'use strict';

const express = require('express');
const prisma = require('../lib/prisma');
const { syncAuth } = require('../middleware/syncAuth');
const { upsertCatalogItem } = require('../services/catalogSync');

const router = express.Router();

// These routes are called BY the provider, authenticated with the shared secret.
router.use(syncAuth);

// The provider wraps every outbound call in a standard envelope:
//   { event_id, event_type, occurred_at, source, payload: { ... } }
// Defensively handle both the enveloped form (fields inside `payload`) and a
// flat body, mirroring the provider's own crossCloud.js unwrap logic.
function unwrapEnvelope(body) {
  const b = body || {};
  const hasEnvelope = b.payload && typeof b.payload === 'object';
  const payload = hasEnvelope ? b.payload : b;
  // event_id lives on the envelope; fall back to the payload for flat bodies.
  const eventId = b.event_id || payload.event_id;
  return { payload, eventId };
}

// POST /v1/sync/policies/status
// Body: { event_id, client_policy_id | provider_policy_id, status }
// Idempotent: if the policy is already in the target status, it's a no-op success.
router.post('/policies/status', async (req, res, next) => {
  try {
    const { payload, eventId } = unwrapEnvelope(req.body);
    const { client_policy_id: clientId, provider_policy_id: providerId, status } = payload;
    if (!status || (!clientId && !providerId)) {
      return res.status(400).json({ error: 'status and a policy identifier are required' });
    }

    const policy = clientId
      ? await prisma.policy.findUnique({ where: { id: clientId } })
      : await prisma.policy.findFirst({ where: { providerPolicyId: providerId } });

    if (!policy) {
      return res.status(404).json({ error: 'Policy not found' });
    }

    if (policy.status === status) {
      req.log.info({ eventId, policyId: policy.id, status }, 'Policy already in target status; no-op');
      return res.json({ data: policy, idempotent: true });
    }

    const updated = await prisma.policy.update({
      where: { id: policy.id },
      data: {
        status,
        // Learn the provider's id if we didn't have it yet.
        providerPolicyId: policy.providerPolicyId || providerId || undefined,
      },
    });

    req.log.info({ eventId, policyId: updated.id, status }, 'Policy status updated from provider');
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});

// POST /v1/sync/claims/status
// Body: { event_id, client_claim_id | provider_claim_id, status }
// Idempotent, same pattern as policies.
router.post('/claims/status', async (req, res, next) => {
  try {
    const { payload, eventId } = unwrapEnvelope(req.body);
    const { client_claim_id: clientId, provider_claim_id: providerId, status } = payload;
    if (!status || (!clientId && !providerId)) {
      return res.status(400).json({ error: 'status and a claim identifier are required' });
    }

    const claim = clientId
      ? await prisma.claim.findUnique({ where: { id: clientId } })
      : await prisma.claim.findFirst({ where: { providerClaimId: providerId } });

    if (!claim) {
      return res.status(404).json({ error: 'Claim not found' });
    }

    if (claim.status === status) {
      req.log.info({ eventId, claimId: claim.id, status }, 'Claim already in target status; no-op');
      return res.json({ data: claim, idempotent: true });
    }

    const updated = await prisma.claim.update({
      where: { id: claim.id },
      data: {
        status,
        providerClaimId: claim.providerClaimId || providerId || undefined,
      },
    });

    req.log.info({ eventId, claimId: updated.id, status }, 'Claim status updated from provider');
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});

// POST /v1/sync/catalog
// Inbound provider PUSH of a catalog create/edit/deactivate. A single event type
// (`catalog.upserted`) covers all three; deactivation arrives as `isActive: false`.
//
// The `payload` is camelCase and mirrors the pull response GET /v1/catalog/policies
// row-for-row (id, key, name, description, premiumAmount, coverageAmount, isActive,
// createdAt). We reuse the SAME mapping/upsert the pull refresh uses
// (`upsertCatalogItem`), keyed on payload.id -> providerPolicyId, so:
//   - a re-delivered / retried event never creates a duplicate row, and
//   - applying the same event twice leaves the same final state (idempotent).
// This is additive to the existing stale-cache PULL fallback; both feed policy_catalog.
router.post('/catalog', async (req, res, next) => {
  try {
    const { payload, eventId } = unwrapEnvelope(req.body);
    if (!payload || !payload.id) {
      return res.status(400).json({ error: 'payload.id is required' });
    }

    const row = await upsertCatalogItem(payload);

    req.log.info(
      { eventId, providerPolicyId: payload.id, isActive: row.isActive },
      'Catalog entry upserted from provider push'
    );
    res.json({ data: row });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
