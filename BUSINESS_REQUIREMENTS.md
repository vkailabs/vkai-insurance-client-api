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
   read-only** copy of the provider's catalog, refreshed from the provider API when stale.
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
authoritative status changes back to the client (e.g. a policy becoming active, or a claim being
approved/rejected/paid). Requests with a missing or invalid sync key are rejected with 401.

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
