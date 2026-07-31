'use strict';

const { v4: uuidv4 } = require('uuid');
const env = require('../config/env');
const prisma = require('../lib/prisma');
const { logger } = require('../lib/logger');

// Provider endpoints we POST outbound events to. The provider side (Azure) is
// independent and reached only over HTTP; these paths are the agreed contract.
const ENDPOINTS = {
  policy: '/v1/sync/policies',
  premium: '/v1/sync/premiums',
  claim: '/v1/sync/claims',
};

const EVENT_TYPES = {
  policyEnrolled: 'policy.enrolled',
  policyRenewed: 'policy.renewed',
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

  const result = await syncToProvider(
    ENDPOINTS.policy,
    {
      eventId,
      eventType,
      correlationId,
      payload: {
        client_policy_id: policy.id,
        provider_policy_id: policy.providerPolicyId,
        policy_catalog_id: policy.policyCatalogId,
        status: policy.status,
        enrolled_at: policy.enrolledAt,
        expiry_date: policy.expiryDate,
      },
    },
    log
  );

  return persistSyncResult('policy', policy, eventId, result);
}

async function syncPremiumRecord(premium, correlationId, log = logger) {
  const eventId = ensureEventId(premium);

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
    return delegate.update({
      where: { id: record.id },
      data: { syncStatus: 'synced', eventId },
    });
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
  syncPremiumRecord,
  syncClaimRecord,
};
