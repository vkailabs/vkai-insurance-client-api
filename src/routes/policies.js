'use strict';

const express = require('express');
const prisma = require('../lib/prisma');
const { firebaseAuth } = require('../middleware/firebaseAuth');
const { syncPolicyRecord, cancelPolicyRecord } = require('../services/providerSync');

const router = express.Router();

// All policy routes require an authenticated customer.
router.use(firebaseAuth);

// POST /v1/policies  { policy_catalog_id }
// Enroll the logged-in user in a catalog policy, then sync outbound.
router.post('/', async (req, res, next) => {
  try {
    const { policy_catalog_id: policyCatalogId } = req.body || {};
    if (!policyCatalogId) {
      return res.status(400).json({ error: 'policy_catalog_id is required' });
    }

    const catalog = await prisma.policyCatalog.findUnique({ where: { id: policyCatalogId } });
    if (!catalog) {
      return res.status(404).json({ error: 'policy_catalog_id not found' });
    }

    // Default a one-year term for the enrollment.
    const enrolledAt = new Date();
    const expiryDate = new Date(enrolledAt);
    expiryDate.setFullYear(expiryDate.getFullYear() + 1);

    // providerPolicyId is intentionally left unset here: the provider only
    // creates its own policy record when it receives the outbound sync, so this
    // enrollment has no provider-side id yet. It's populated after the first
    // successful sync (see persistSyncResult in providerSync.js).
    const policy = await prisma.policy.create({
      data: {
        userId: req.user.id,
        policyCatalogId,
        status: 'pending',
        enrolledAt,
        expiryDate,
      },
    });

    // Local write is committed; sync is best-effort and won't fail the request.
    const synced = await syncPolicyRecord(policy, req.correlationId, req.log);

    res.status(201).json({ data: synced });
  } catch (err) {
    next(err);
  }
});

// GET /v1/policies?include=premiums,claims
// List the logged-in user's policies, optionally with nested premiums/claims.
router.get('/', async (req, res, next) => {
  try {
    const include = String(req.query.include || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const policies = await prisma.policy.findMany({
      where: { userId: req.user.id },
      orderBy: { enrolledAt: 'desc' },
      include: {
        policyCatalog: true,
        premiums: include.includes('premiums'),
        claims: include.includes('claims'),
      },
    });

    // Surface the plan's provider-owned display `key` at the top level of each
    // policy, read through the cached catalog relation the policy already holds.
    // `key` is NOT a column on policies — it's looked up via policyCatalog. It
    // degrades to null when the referenced catalog entry has no key yet (e.g.
    // the cache hasn't been refreshed since the provider added keys). Nested
    // premiums and claims deliberately do NOT get a key.
    const shaped = policies.map((policy) => ({
      ...policy,
      key: policy.policyCatalog ? policy.policyCatalog.key ?? null : null,
    }));

    res.json({ data: shaped });
  } catch (err) {
    next(err);
  }
});

// POST /v1/policies/:id/renew  { extend_months? | expiry_date? }
// Extend the policy term and sync the update to the provider.
router.post('/:id/renew', async (req, res, next) => {
  try {
    const policy = await prisma.policy.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!policy) {
      return res.status(404).json({ error: 'Policy not found' });
    }

    // Compute the new expiry: explicit date wins, else extend by N months (default 12).
    let newExpiry;
    if (req.body && req.body.expiry_date) {
      newExpiry = new Date(req.body.expiry_date);
      if (Number.isNaN(newExpiry.getTime())) {
        return res.status(400).json({ error: 'Invalid expiry_date' });
      }
    } else {
      const months = Number(req.body && req.body.extend_months) || 12;
      const base = policy.expiryDate > new Date() ? policy.expiryDate : new Date();
      newExpiry = new Date(base);
      newExpiry.setMonth(newExpiry.getMonth() + months);
    }

    // Renew is a fresh outbound event: reset sync bookkeeping so a new event_id
    // is minted and retries start clean.
    const updated = await prisma.policy.update({
      where: { id: policy.id },
      data: {
        expiryDate: newExpiry,
        status: 'active',
        syncStatus: 'pending',
        syncAttempts: 0,
        eventId: null,
      },
    });

    const synced = await syncPolicyRecord(updated, req.correlationId, req.log);

    res.json({ data: synced });
  } catch (err) {
    next(err);
  }
});

// POST /v1/policies/:id/cancel
// Customer-initiated cancellation of their OWN policy, allowed ONLY while the
// policy is still `pending` (i.e. before the provider has approved/activated it).
// Cancellation is terminal — no premium/claim cascade or refund (premiums are
// virtual). On success we push a `policy.cancelled` status event to the provider
// (VKAI-010): the first client -> provider status direction.
router.post('/:id/cancel', async (req, res, next) => {
  try {
    const policy = await prisma.policy.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!policy) {
      return res.status(404).json({ error: 'Policy not found' });
    }

    // Server-side eligibility guard: cancellation is only allowed on a pending
    // policy. Anything else (active/expired/already-cancelled) is a conflict.
    if (policy.status !== 'pending') {
      return res.status(409).json({
        error: `Only a pending policy can be cancelled (current status: ${policy.status})`,
      });
    }

    // Terminal status change is a fresh outbound event: reset sync bookkeeping
    // so a new event_id is minted and retries start clean (mirrors renew).
    const updated = await prisma.policy.update({
      where: { id: policy.id },
      data: {
        status: 'cancelled',
        syncStatus: 'pending',
        syncAttempts: 0,
        eventId: null,
      },
    });

    // Local write is committed; the outbound cancellation sync is best-effort
    // and won't fail the customer's request.
    const synced = await cancelPolicyRecord(updated, req.correlationId, req.log);

    res.json({ data: synced });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
