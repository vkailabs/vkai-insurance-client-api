# vkai-insurance-client-api

VK AI Labs — Node.js **client-side** API for the Insurance module (policies, premiums, claims).

This is the backend for the customer-facing client portal (`vkai-insurance-client`). It owns
its own PostgreSQL database and talks to the independent **provider side** (Azure) only over
HTTP — there is no shared database. Outbound changes are pushed to the provider best-effort and
retried by a background job; the provider pushes status updates back via authenticated sync
routes.

> Scope: local development only. No Nginx / SSL / GCP deployment here — that's a later phase.

## Tech stack

- **Node.js + Express** — HTTP API
- **PostgreSQL + Prisma ORM** — persistence
- **Firebase Admin SDK** — verifies customer JWTs (Firebase Authentication)
- **node-cron** — background sync retry job (every 5 minutes)
- **pino** — structured JSON logging (chosen for being lightweight and fast; every log line
  carries `timestamp`, `env`, `service`, `correlationId`, `level`, `message`)
- **Docker + Docker Compose** — local dev (API container + Postgres container)

## Project layout

```
prisma/
  schema.prisma          Prisma models (snake_case plural tables)
  migrations/            SQL migrations (0_init is the baseline)
src/
  index.js               Entry point: starts HTTP server + cron job
  app.js                 Express app + middleware/route wiring
  config/env.js          Env-var access (all VKAI_INSURANCE_CLIENT_API_* prefixed)
  lib/                   logger (pino), prisma client, firebase admin
  middleware/            correlationId, requestLogger, firebaseAuth, syncAuth, errorHandler
  services/
    providerSync.js      Outbound sync envelope + per-record sync helpers
    catalogSync.js       Provider catalog refresh (15-min staleness)
  jobs/retrySync.js      node-cron retry job for failed/pending syncs
  routes/                catalog, policies, premiums, claims, sync
```

## Quick start (Docker — recommended)

`docker compose up` brings up the API + Postgres, applies the Prisma migration on boot, and
serves the API on port **4000** with a single command:

```bash
docker compose up --build
```

- Postgres is exposed on `localhost:5432` with a named volume (`vkai_insurance_client_pgdata`)
  for persistence; database name is `vkai_insurance_client_dev`.
- The API container's entrypoint runs `prisma migrate deploy` **before** starting, so the schema
  is migrated automatically — no manual migrate step needed.
- Firebase credentials and the sync key are read from your shell / a root `.env` file (see below).
  Without Firebase creds the server still boots and serves `/healthz` and the `/v1/sync/*` routes;
  customer routes return 401 until real Firebase credentials are supplied.

Health check:

```bash
curl http://localhost:4000/healthz
```

## Quick start (host Node, Postgres in Docker)

If you'd rather run the API directly with Node while using the Dockerized Postgres:

```bash
cp .env.example .env
```

Fill in Firebase creds + a sync key in `.env`, then:

```bash
docker compose up postgres
```

```bash
npm install && npx prisma migrate deploy && npm run dev
```

`npm run dev` uses Node's built-in `--watch`. Use `npm start` for a plain run. The API listens on
`VKAI_INSURANCE_CLIENT_API_PORT` (default 4000).

## Environment variables

All app settings use the `VKAI_INSURANCE_CLIENT_API_` prefix. Copy `.env.example` to `.env`
(gitignored) and fill in values:

| Variable | Purpose |
| --- | --- |
| `VKAI_INSURANCE_CLIENT_API_PORT` | HTTP port (default 4000) |
| `VKAI_INSURANCE_CLIENT_API_DATABASE_URL` | Postgres connection string |
| `VKAI_INSURANCE_CLIENT_API_FIREBASE_PROJECT_ID` | Firebase project id |
| `VKAI_INSURANCE_CLIENT_API_FIREBASE_CLIENT_EMAIL` | Firebase service-account email |
| `VKAI_INSURANCE_CLIENT_API_FIREBASE_PRIVATE_KEY` | Firebase service-account private key (single line, `\n` for newlines) |
| `VKAI_INSURANCE_CLIENT_API_SYNC_KEY` | Shared secret for provider↔client sync |
| `VKAI_INSURANCE_PROVIDER_API_BASE_URL` | Base URL of the provider (Azure) API |
| `VKAI_INSURANCE_CLIENT_API_LOG_LEVEL` | `trace`…`fatal` (default `info`) |

> Note: in `docker-compose.yml` the API's `DATABASE_URL` is overridden to reach Postgres at host
> `postgres` (the compose service name); the `localhost` value in `.env.example` is for running
> the API directly on your machine.

## API routes

All customer routes require a Firebase JWT via `Authorization: Bearer <token>`.

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/v1/catalog` | Cached policy catalog; refreshes from the provider if older than 15 min |
| `POST` | `/v1/policies` | Enroll in a policy `{ policy_catalog_id }`, then sync outbound |
| `GET` | `/v1/policies?include=premiums,claims` | The user's policies with optional nested premiums/claims (dashboard view) |
| `POST` | `/v1/policies/:id/renew` | Extend `expiry_date` (`{ extend_months }` or `{ expiry_date }`), sync update |
| `POST` | `/v1/premiums` | Pay a premium `{ policy_id, amount }`, then sync outbound |
| `POST` | `/v1/claims` | File a claim `{ policy_id, amount_claimed, description }`, then sync outbound |
| `GET` | `/v1/claims` | List the user's claims |

Inbound sync routes (called **by the provider**, authenticated with `X-VKAI-Sync-Key`, not a JWT):

| Method | Route | Description |
| --- | --- | --- |
| `POST` | `/v1/sync/policies/status` | Update a local policy's status. Idempotent — already-in-target-status is a no-op success |
| `POST` | `/v1/sync/claims/status` | Same pattern for claims |

Unauthenticated: `GET /healthz`.

## Middleware

1. **Correlation ID** — reads `X-VKAI-Correlation-Id` (or generates a UUID), attaches it and a
   correlation-scoped logger to the request, echoes it back on the response, and includes it in
   every log line for that request.
2. **Firebase auth** — verifies the JWT, upserts the local `users` row, attaches `req.user`.
   Applied to all customer routes.
3. **Sync auth** — checks `X-VKAI-Sync-Key` against `VKAI_INSURANCE_CLIENT_API_SYNC_KEY`;
   401 if missing/invalid. Applied only to `/v1/sync/*`.

## Sync design

**Outbound** (`src/services/providerSync.js`): after each local write, the create/renew handlers
call `syncToProvider(endpointPath, payload)`, which wraps the payload in the standard envelope
`{ event_id, event_type, occurred_at, source: "client", payload }` and POSTs it to
`${VKAI_INSURANCE_PROVIDER_API_BASE_URL}${endpointPath}` with the sync-key and correlation-id
headers. On success the record's `sync_status` becomes `synced`; on any failure it becomes
`failed` and `sync_attempts` is incremented — **the user-facing request still succeeds**, since
the local write already happened (sync is best-effort).

**Retry** (`src/jobs/retrySync.js`): a node-cron job runs every 5 minutes, finds `policies`,
`premiums` and `claims` where `sync_status IN ('pending','failed')` and `sync_attempts < 5`, and
retries each with its **existing `event_id`** so the provider can dedupe. After 5 failed attempts
a record stays `failed` permanently (a future "sync issues" admin view would surface these).

**Inbound idempotency**: `/v1/sync/*` updates are safe to replay — if the target row is already in
the requested status, the route returns success without changing anything.

## Database

Prisma models live in `prisma/schema.prisma`; tables are snake_case + plural
(`users`, `policy_catalog`, `policies`, `premiums`, `claims`). The `policies`, `premiums` and
`claims` tables each carry `sync_status`, `sync_attempts` and `event_id` to drive the
retry/idempotency logic above.

Common commands:

```bash
npx prisma migrate deploy
```

```bash
npx prisma studio
```

## What this repo does NOT include

- No Nginx / SSL / GCP deployment config (later phase)
- No frontend (`vkai-insurance-client` is a separate repo)
- No provider side (Azure) — reached only over HTTP
