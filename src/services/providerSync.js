'use strict';

const { v4: uuidv4 } = require('uuid');
const env = require('../config/env');
const prisma = require('../lib/prisma');
const { logger } = require('../lib/logger');

// Provider endpoints we POST outbound events to. The provider side (Azure) is
// independent and reached only over HTTP; these paths are the agreed contract.
const ENDPOINTS = {
  policy: '/v1/sync/policies',
  // Client -> provider policy STATUS push (currently only customer-initiated
  // cancellation, VKAI-010). This is the FIRST client->provider status
  // direction. Note the client's own INBOUND route has the same path name for
  // the reverse (provider->client) direction — that's fine, they live in
  // different clouds and are entirely separate routes.
  policyStatus: '/v1/sync/policies/status',
  premium: '/v1/sync/premiums',
  claim: '/v1/sync/claims',
};

const EVENT_TYPES = {
  policyEnrolled: 'policy.enrolled',
  policyRenewed: 'policy.renewed',
  policyCancelled: 'policy.cancelled',
  premiumPaid: 'premium.paid',
  claimFiled: 'claim.filed',
};

// Low-level, reusable transport. Wraps the payload in the standard envelope and
// POSTs it to the provider with the shared-secret and correlation-id headers.
// NEVER throws — returns a result object so callers can decide what to persist.
async function syncToProvider(endpointPath, { eventId, eventType, payload, correlationId }, log = logger) {
  const url = `${env.providerApiBaseUrl}${endpointPath}`;
  const envelope = {
    event_id: eventId,
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    source: 'client',
    payload,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VKAI-Sync-Key': env.syncKey || '',
        'X-VKAI-Correlation-Id': correlationId || uuidv4(),
      },
      body: JSON.stringify(envelope),
    });

    if (!res.ok) {
      log.warn({ url, status: res.status, eventId, eventType }, 'Outbound sync returned non-2xx');
      return { ok: false, status: res.status };
    }

    let body = null;
    try {
      body = await res.json();
    } catch (_) {
      // Provider may return an empty body; that's fine.
    }
    log.info({ url, status: res.status, eventId, eventType }, 'Outbound sync succeeded');
    return { ok: true, status: res.status, body };
  } catch (err) {
    log.warn({ url, err: err.message, eventId, eventType }, 'Outbound sync network error');
    return { ok: false, error: err.message };
  }
}

// Ensure a record has a stable idempotency key. Generated once and reused on
// every retry so the provider can dedupe.
function ensureEventId(record) {
  return record.eventId || uuidv4();
}

// ---- Per-resource helpers ---------------------------------------------------
// Each one builds the payload, calls syncToProvider, and updates the local
// record's sync_status / sync_attempts / event_id. These are shared by the
// route handlers (first attempt) and the retry job (subsequent attempts).

async function syncPolicyRecord(policy, correlationId, log = logger) {
  const eventId = ensureEventId(policy);
  const eventType = policy.providerPolicyId ? EVENT_TYPES.policyRenewed : EVENT_TYPES.policyEnrolled;

  // Resolve the related user and catalog record. Callers (enroll/renew handlers
  // and the retry job) pass a bare policy row without relations, so fetch them
  // here to keep the outbound payload correct regardless of caller.
  const user = policy.user || (await prisma.user.findUnique({ where: { id: policy.userId } }));
  const catalog =
    policy.policyCatalog || (await prisma.policyCatalog.findUnique({ where: { id: policy.policyCatalogId } }));

  const result = await syncToProvider(
    ENDPOINTS.policy,
    {
      eventId,
      eventType,
      correlationId,
      payload: {
        client_policy_id: policy.id,
        // Opaque, stable reference to the client-side user. Firebase UID is the
        // user's canonical external identity and never changes.
        client_user_ref: user ? user.firebaseUid : undefined,
        provider_policy_id: policy.providerPolicyId,
        // The provider knows nothing of our local catalog PKs; send the catalog
        // record's provider_policy_id (the id on the provider's own side).
        policy_catalog_id: catalog ? catalog.providerPolicyId : undefined,
        status: policy.status,
        enrolled_at: policy.enrolledAt,
        expiry_date: policy.expiryDate,
      },
    },
    log
  );

  return persistSyncResult('policy', policy, eventId, result);
}

// Customer-initiated cancellation of a pending policy (VKAI-010). Unlike
// syncPolicyRecord (which posts the full enrollment/renewal to /v1/sync/policies),
// this pushes a minimal status change to the provider's /v1/sync/policies/status
// route — the first client->provider status direction. Reuses the standard
// envelope, event_id idempotency, and persistSyncResult bookkeeping.
async function cancelPolicyRecord(policy, correlationId, log = logger) {
  const eventId = ensureEventId(policy);

  const result = await syncToProvider(
    ENDPOINTS.policyStatus,
    {
      eventId,
      eventType: EVENT_TYPES.policyCancelled,
      correlationId,
      payload: {
        client_policy_id: policy.id,
        status: 'cancelled',
      },
    },
    log
  );

  return persistSyncResult('policy', policy, eventId, result);
}

// Route a policy row to the correct outbound sync based on its lifecycle
// status. A cancelled policy must re-push the CANCELLATION event to the status
// route, never be mis-sent as an enrollment/renewal to /v1/sync/policies. Used
// by the 5-min retry job so a failed cancel is retried on the right endpoint
// with the same event_id.
async function syncPolicyRecordByStatus(policy, correlationId, log = logger) {
  if (policy.status === 'cancelled') {
    return cancelPolicyRecord(policy, correlationId, log);
  }
  return syncPolicyRecord(policy, correlationId, log);
}

async function syncPremiumRecord(premium, correlationId, log = logger) {
  const eventId = ensureEventId(premium);

  // Resolve the linked enrollment's enrolment date so the provider can store it
  // on its premium record (VKAI-009 / VJS-48). Callers (the pay-premium handler
  // and the retry job) pass a bare premium row without the `policy` relation, so
  // look the policy up by policyId here. Best-effort: if the date can't be
  // resolved for any reason, send null rather than throwing — sync must never
  // break the customer's request.
  let enrolledAt = null;
  try {
    const policy =
      premium.policy || (await prisma.policy.findUnique({ where: { id: premium.policyId } }));
    enrolledAt = policy ? policy.enrolledAt : null;
  } catch (err) {
    log.warn({ err: err.message, premiumId: premium.id }, 'Could not resolve enrolledAt for premium sync');
    enrolledAt = null;
  }

  const result = await syncToProvider(
    ENDPOINTS.premium,
    {
      eventId,
      eventType: EVENT_TYPES.premiumPaid,
      correlationId,
      payload: {
        client_premium_id: premium.id,
        client_policy_id: premium.policyId,
        amount: premium.amount,
        paid_at: premium.paidAt,
        enrolled_at: enrolledAt,
      },
    },
    log
  );

  return persistSyncResult('premium', premium, eventId, result);
}

async function syncClaimRecord(claim, correlationId, log = logger) {
  const eventId = ensureEventId(claim);

  const result = await syncToProvider(
    ENDPOINTS.claim,
    {
      eventId,
      eventType: EVENT_TYPES.claimFiled,
      correlationId,
      payload: {
        client_claim_id: claim.id,
        client_policy_id: claim.policyId,
        amount_claimed: claim.amountClaimed,
        description: claim.description,
        status: claim.status,
        submitted_at: claim.submittedAt,
      },
    },
    log
  );

  return persistSyncResult('claim', claim, eventId, result);
}

// Update the local record after a sync attempt. On success -> synced. On
// failure -> failed, and bump sync_attempts. Always stores the event_id used.
async function persistSyncResult(kind, record, eventId, result) {
  const delegate = prisma[kind]; // prisma.policy / prisma.premium / prisma.claim

  if (result.ok) {
    const data = { syncStatus: 'synced', eventId };

    // On the first successful policy sync the provider creates its own policy
    // record and returns its id. Capture it (only when we don't have one yet)
    // so subsequent syncs are correctly treated as renewals, not enrollments.
    if (kind === 'policy' && !record.providerPolicyId) {
      const providerPolicyId = result.body?.policy?.id;
      if (providerPolicyId) data.providerPolicyId = providerPolicyId;
    }

    return delegate.update({ where: { id: record.id }, data });
  }

  return delegate.update({
    where: { id: record.id },
    data: { syncStatus: 'failed', eventId, syncAttempts: { increment: 1 } },
  });
}

module.exports = {
  ENDPOINTS,
  EVENT_TYPES,
  syncToProvider,
  syncPolicyRecord,
  cancelPolicyRecord,
  syncPolicyRecordByStatus,
  syncPremiumRecord,
  syncClaimRecord,
};
