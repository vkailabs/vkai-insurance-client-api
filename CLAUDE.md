# CLAUDE.md — project context for vkai-insurance-client-api

Context for future Claude Code sessions working in this repo. Read this before making changes.

## What this repo is

The backend API for the **client side** of "VK AI Labs Insurance" (a personal portfolio
project). It serves the `vkai-insurance-client` frontend and handles customer auth verification
(Firebase Admin SDK), the cached policy catalog, policy enrollments, virtual premium payments,
and claims. It owns its **own independent Postgres database** — there is **no shared database**
with the provider side, ever. It syncs with the provider API (Azure) over HTTPS using a standard
envelope `{ event_id, event_type, occurred_at, source, payload }`. See
[BUSINESS_REQUIREMENTS.md](BUSINESS_REQUIREMENTS.md) for the full picture and
[README.md](README.md) for setup.

## Stack

Node.js + Express · Prisma + PostgreSQL · Firebase Admin SDK (JWT verification) · node-cron
(5-min sync retry job) · pino (structured JSON logging).

## Naming conventions

- **Env vars**: prefix everything with `VKAI_INSURANCE_CLIENT_API_*` (the provider base URL,
  `VKAI_INSURANCE_PROVIDER_API_BASE_URL`, is the one deliberate exception — it names the other
  system).
- **Database columns**: `snake_case`, tables plural (`policy_catalog`, `policies`, …).
- **Prisma model fields**: `camelCase`, mapped to snake_case columns via `@map`.
- **JSON API responses are camelCase, not snake_case** — they serialize Prisma objects directly.
  Inbound request payloads from the provider, however, use snake_case inside `payload` (e.g.
  `client_policy_id`, `provider_policy_id`). Don't assume one casing everywhere; check the
  direction of the data.

## CRITICAL gotchas (learned the hard way)

### 1. docker-compose.yml lists env vars EXPLICITLY — it does not load .env

The `api` service enumerates each environment variable individually; it does **not** bulk-load
the `.env` file. **Any new env var added to `.env.example` and the app code MUST also be added
to the `api` service's `environment:` list in `docker-compose.yml`**, or the running container
silently never receives it (the app falls back to a default or breaks with no obvious error —
this is exactly how CORS broke once). **Always cross-check all three when adding a var:**
`.env.example`, the app code that reads it, and `docker-compose.yml`.

### 2. A manual fix on a deployed VM is LOCAL-ONLY until committed

Any change made directly on a deployed VM (editing a file over `ssh`/`nano`, etc.) lives only on
that VM's disk and is **invisible to git**. It will be lost or overwritten and is not part of the
codebase until it is explicitly committed and pushed through the normal
`dev` → PR → `main` workflow. **Never leave a fix living only on a VM.** Port it back into the
repo.

### 3. Inbound sync routes MUST unwrap the standard envelope

The provider wraps every outbound call in `{ event_id, event_type, occurred_at, source,
payload }`. Inbound handlers in `src/routes/sync.js` must read business fields from
**`req.body.payload`**, not `req.body` directly. Reading them off the root was a real bug that
made every inbound status sync fail with 400. The unwrap helper handles both enveloped and flat
bodies defensively — keep it; don't reintroduce the bug.

### 4. Firebase Admin private key formatting

`VKAI_INSURANCE_CLIENT_API_FIREBASE_PRIVATE_KEY` in `.env` must stay on **one line, quoted, with
literal `\n` text** (the app converts `\n` back into real newlines at load time). **Never let an
editor "clean up" the key into real multi-line breaks** — that corrupts the key and Firebase
initialization fails.

### 5. Local cross-container networking

When testing against a sibling repo's API running in **its own** Docker Compose project locally,
use `http://host.docker.internal:<port>` — **not** `localhost`. Inside a container `localhost`
refers to the container itself, so `localhost:<port>` will not reach a service in another compose
project.

### 6. CI/CD deploy pipeline (GitHub Actions → GCP VM)

`.github/workflows/deploy.yml` auto-deploys to the production GCP VM on every push to `main`
(SSH via `appleboy/ssh-action`: `git pull`, `docker compose up --build -d`, health check).
Two things were learned the hard way building it:

- **Use absolute paths in the deploy script, NOT `~`.** `~` does **not** reliably expand in this
  SSH action's non-interactive shell, causing `No such file or directory` even when the path is
  correct. Use the full path, e.g. `/home/vibhavkulshrestha/vkai-insurance-client-api`.
- **The health check needs a real wait + retry, not an immediate single curl.** Postgres
  healthcheck + Prisma migration + API startup takes longer than a few seconds. The workflow
  sleeps **20s** then retries the `/healthz` curl **5 times, 5s apart** before failing. A single
  immediate check produces false 502 failures on a deploy that actually succeeded.

Requires these **GitHub repo secrets**: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`.

## Keeping documentation current

**If a change is significant** — a new field, a new business rule, a new architectural decision,
new infrastructure/pipeline, or a newly discovered gotcha — **update this repo's own
`BUSINESS_REQUIREMENTS.md` and/or `README.md` as part of the same commit**, not as a separate
afterthought. Minor or purely cosmetic changes don't need a doc update.

## Git workflow

- **Always work on `dev`. Never commit directly to `main`.**
- Commit and push to `dev` only. **Never open or merge a PR** — the human handles all PR
  review/merges (`dev` → `main`).
- Standard loop: make the change, verify, `git add` the specific files, commit, `git push origin
  dev`.

## Related repos (independent — do not assume knowledge of or change them from here)

- **vkai-insurance-client** — this API's own frontend (GCP).
- **vkai-insurance-provider** — the provider-side app (Azure), fully independent.
- **vkai-insurance-provider-api** — the provider-side API (Azure), fully independent.

The provider side is a **completely separate cloud (Azure)**. Never assume knowledge of those
repos' internals and never make changes there from this repo — the only contract between sides is
the HTTPS sync envelope.
