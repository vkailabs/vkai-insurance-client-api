# Business Requirements — vkai-insurance-client-api

## Overview

`vkai-insurance-client-api` is the backend API for the **client side** of **VK AI Labs
Insurance**, a personal portfolio project. It powers the customer-facing web app
(`vkai-insurance-client`) and exposes the operations a policyholder needs: signing in,
browsing the policy catalog, enrolling in policies, paying premiums (virtual — no real money
moves), and filing claims.

It is one of four independent repositories in the ecosystem. This repo owns **only** the
client side; the provider side lives in a completely separate cloud (Azure) and is never
modified from here.

## Core responsibilities

1. **Customer authentication verification** — verifies Firebase-issued customer JWTs using the
   Firebase Admin SDK. The app does not mint tokens; it validates the `Authorization: Bearer`
   token on each customer request and resolves it to a local user record.
2. **Policy catalog** — serves a catalog of available policies. This catalog is a **cached,
   read-only** copy of the provider's catalog, kept fresh two ways: a **PUSH** from the provider
   (inbound `POST /v1/sync/catalog`, applied immediately) and a **PULL** fallback (refreshed from
   the provider API when the cache is stale). Both feed the same `policy_catalog` table via the
   same upsert. Each catalog entry also caches a provider-owned display **`key`** (see "Catalog
   key" below).
3. **Policy enrollments** — lets a customer enroll in a catalog policy, creating a local
   enrollment record that is then synced to the provider.
4. **Premium payments (virtual)** — records premium payments against a policy. Payments are
   virtual/simulated; no real payment processing occurs.
5. **Claims** — lets a customer file claims against their policies and track claim status.

## Data ownership — independent database

This API maintains its **own independent PostgreSQL database**. There is **no shared database
with the provider side, ever.** The two sides are separate systems in separate clouds and
communicate exclusively over HTTPS. Neither side reads or writes the other's tables.

The client database is the source of truth for: users, the cached policy catalog, enrollments
(policies), premiums, and claims.

## Cross-cloud sync model

Because the client and provider are independent systems with no shared storage, state is kept
consistent through **event-triggered HTTPS calls** in both directions.

### Standard envelope

Every sync call — outbound and inbound — carries a standard envelope:

```json
{
  "event_id": "<uuid>",
  "event_type": "<e.g. policy.enrolled | policy.renewed | premium.paid | claim.filed>",
  "occurred_at": "<ISO-8601 timestamp>",
  "source": "client",
  "payload": { "...event-specific fields..." }
}
```

The meaningful business fields always live inside `payload`; the surrounding keys are
transport/metadata. Inbound handlers must read from `payload`, not the envelope root.

### Reliability: retry + idempotency

The `policies`, `premiums`, and `claims` tables each carry three fields that make sync robust:

- **`sync_status`** — `pending` → `synced` → `failed`. A local write always succeeds first;
  sync is best-effort and never blocks the customer's request.
- **`sync_attempts`** — incremented on each failed attempt.
- **`event_id`** — the idempotency key sent on the outbound call, reused on every retry so the
  receiving side can dedupe.

A **node-cron background job runs every 5 minutes**, finds records that are `pending` or
`failed` with `sync_attempts < 5`, and retries them (reusing the same `event_id`). After 5
failed attempts a record stays `failed` for a future "sync issues" admin view to surface.

Inbound status updates are **idempotent**: if a record is already in the requested status, the
handler treats it as a no-op success, so replays are safe.

## Endpoint categories

The API has two distinct classes of endpoints with **different authentication schemes**:

### 1. Customer-authenticated routes (Firebase JWT)

Called by the frontend on behalf of a signed-in customer. Protected by the Firebase auth
middleware (`Authorization: Bearer <token>`):

- **Catalog** — browse available policies (refreshed from the provider when stale).
- **Policies** — enroll, list the customer's own policies (with nested premiums/claims for the
  dashboard), and renew.
- **Premiums** — pay a premium against one of the customer's policies.
- **Claims** — file a claim and list the customer's claims.

Each customer route scopes data to the authenticated user — a customer can only see and act on
their own policies, premiums, and claims.

### 2. Inbound sync routes (shared secret, NOT customer JWTs)

Called **by the provider side**, not by customers. These are protected by a **shared secret**
sent in the `X-VKAI-Sync-Key` header — **never** by a customer JWT. They let the provider push
authoritative changes back to the client. Requests with a missing or invalid sync key are
rejected with 401. Current inbound routes:

- `POST /v1/sync/policies/status` — provider pushes a policy status change (idempotent no-op if
  already in target status).
- `POST /v1/sync/claims/status` — provider pushes a claim status change (same pattern).
- `POST /v1/sync/catalog` — provider PUSHES a catalog create/edit/deactivate (VKAI-003, see
  "Push-based catalog sync" below).

## Catalog key (VKAI-002)

The provider owns a display **`key`** on each catalog entry (e.g. `"PG2"`, or the
collision-suffixed `"PG2-2"`). As of VKAI-002 the provider's catalog-pull endpoint
(`GET /v1/catalog/policies`, the source this API refreshes its cache from) returns `key` on
every row.

Rules:

- **Cached, not owned.** The client stores `key` verbatim on each cached catalog row
  (`policy_catalog.key`, nullable). The client **never generates** a key — it only stores and
  echoes what the provider sends. On refresh, the existing upsert (matched on
  `provider_policy_id`) **updates** the row's `key` in place; no duplicates are created. `key` is
  nullable so pre-existing cached rows stay valid until the next refresh fills it in.
- **Display-only.** `key` is **not** a field on `policies`, `premiums`, or `claims`, and it is
  **not** part of any enrollment/premium/claim sync payload. It exists purely to label catalog
  entries in the UI.
- **Where it's exposed.**
  - `GET /v1/catalog` — each catalog row carries `key` (string or `null`) directly, since rows
    serialize straight from `policy_catalog`.
  - `GET /v1/policies` — each policy carries a top-level `key`, **looked up through the cached
    catalog relation** (`policyCatalog.key`) the policy already references — not stored on the
    policy. It degrades to `null` when the referenced catalog entry has no key yet (e.g. the cache
    hasn't been refreshed since the provider added keys). Nested `premiums` and `claims` do **not**
    get a `key`.
- **Force-refresh.** After the provider ships a catalog change, run
  `npm run catalog:refresh` (script: `scripts/refresh-catalog.js`) to pull immediately, bypassing
  the 15-minute staleness window, so already-cached rows pick up their `key` right away. See
  README / CLAUDE.md for the exact deploy command.

## Push-based catalog sync (VKAI-003)

The catalog cache is kept fresh by **two complementary paths that both write the same
`policy_catalog` table through the same upsert** (`upsertCatalogItem` in
`src/services/catalogSync.js`):

- **PUSH (primary, immediate).** The provider calls the inbound route
  `POST /v1/sync/catalog` whenever a catalog entry is **created, edited, or deactivated**. This
  applies the change to the cache right away, instead of waiting for staleness.
- **PULL (fallback, unchanged).** The existing 15-minute stale-cache refresh from the provider's
  `GET /v1/catalog/policies` remains fully intact as a safety net (e.g. a missed push). VKAI-003
  is **additive** — it does not remove or weaken the pull.

Contract for `POST /v1/sync/catalog`:

- **Auth:** the shared-secret `X-VKAI-Sync-Key` header (same `syncAuth` middleware as every other
  inbound sync route). Missing/invalid key → 401. Not a customer/Firebase JWT.
- **Envelope:** the standard snake_case envelope `{ event_id, event_type, occurred_at, source,
  payload }`. `event_type` is `catalog.upserted` — a **single event type covers create, edit and
  deactivate**. Business fields are read from `payload`, never the envelope root.
- **Payload is camelCase** (unlike the snake_case status-sync payloads) and mirrors the pull
  response `GET /v1/catalog/policies` row **one-for-one**: `id`, `key`, `name`, `description`,
  `premiumAmount` (decimal-as-string), `coverageAmount` (decimal-as-string), `isActive`,
  `createdAt`.
- **Dedupe / idempotency:** upsert keyed on `payload.id` → `policy_catalog.provider_policy_id`
  (the business/dedupe key). A re-delivered or retried event never creates a duplicate row, and
  applying the same event twice yields the same final state. We do **not** separately record
  `event_id`, matching this repo's other inbound handlers, which rely on idempotent state rather
  than an event-log table.
- **Deactivation:** `isActive: false` is stored verbatim on `policy_catalog.is_active`. The
  customer-facing `GET /v1/catalog` filters to `isActive = true`, so a deactivated plan
  immediately disappears from the browse catalog. (Existing customer policies referencing a now
  deactivated catalog entry are unaffected — only the browse catalog is filtered.)

## Premium sync carries the enrolment date (VKAI-009 / VJS-48)

The outbound premium-payment sync (`premium.paid` → provider `POST /v1/sync/premiums`) now
carries an additional field **`enrolled_at`** in its `payload`, alongside the existing
`client_premium_id`, `client_policy_id`, `amount`, and `paid_at`.

- **Value.** `enrolled_at` is the enrolment date of the premium's linked enrollment — the client
  `Policy.enrolledAt` (`@map("enrolled_at")`) of the policy referenced by `premium.policyId`. It
  is sent as-is (ISO/date), or **`null`** if the date can't be resolved.
- **Best-effort, never blocking.** The premium row usually arrives at the sync helper without its
  `policy` relation loaded (both the pay-premium handler and the 5-min retry job pass a bare row),
  so `syncPremiumRecord` looks the policy up by `premium.policyId`. If that lookup fails for any
  reason it sends `null` rather than throwing — consistent with the repo's best-effort sync model,
  where sync must never break the customer's request. The retry path re-reads the premium and
  resolves the date the same way, so retries carry `enrolled_at` too.
- **Consumed by the provider.** The provider-api accepts `enrolled_at` as an **optional**
  snake_case field on `POST /v1/sync/premiums` and stores it as the premium's enrolment date
  (surfaced on the provider portal's "Premiums" tab). This is a purely additive contract change —
  the field being absent/null remains valid on the provider side.

## Out of scope

- Real payment processing (premiums are virtual).
- The provider side (Azure) — reached only over HTTPS; never built or modified from this repo.
- The frontend (`vkai-insurance-client`) — a separate repository.
- Nginx / SSL configuration (handled at the VM/infra layer, not in this repo).

## Deployment

Production runs on a **GCP Compute Engine VM**. A **GitHub Actions** pipeline
(`.github/workflows/deploy.yml`) **automatically deploys on every push to `main`**: it SSHes to
the VM, pulls the latest code, rebuilds the Docker containers, and verifies the API is healthy
via `/healthz`. See [README.md](README.md#deployment) for details and the required repo secrets.
