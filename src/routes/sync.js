'use strict';

const express = require('express');
const prisma = require('../lib/prisma');
const { syncAuth } = require('../middleware/syncAuth');

const router = express.Router();

// These routes are called BY the provider, authenticated with the shared secret.
router.use(syncAuth);

// POST /v1/sync/policies/status
// Body: { event_id, client_policy_id | provider_policy_id, status }
// Idempotent: if the policy is already in the target status, it's a no-op success.
router.post('/policies/status', async (req, res, next) => {
  try {
    const { client_policy_id: clientId, provider_policy_id: providerId, status } = req.body || {};
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
      req.log.info({ policyId: policy.id, status }, 'Policy already in target status; no-op');
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

    req.log.info({ policyId: updated.id, status }, 'Policy status updated from provider');
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
    const { client_claim_id: clientId, provider_claim_id: providerId, status } = req.body || {};
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
      req.log.info({ claimId: claim.id, status }, 'Claim already in target status; no-op');
      return res.json({ data: claim, idempotent: true });
    }

    const updated = await prisma.claim.update({
      where: { id: claim.id },
      data: {
        status,
        providerClaimId: claim.providerClaimId || providerId || undefined,
      },
    });

    req.log.info({ claimId: updated.id, status }, 'Claim status updated from provider');
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
