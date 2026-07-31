'use strict';

const express = require('express');
const prisma = require('../lib/prisma');
const { firebaseAuth } = require('../middleware/firebaseAuth');
const { syncPolicyRecord } = require('../services/providerSync');

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

    const policy = await prisma.policy.create({
      data: {
        userId: req.user.id,
        policyCatalogId,
        providerPolicyId: catalog.providerPolicyId,
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

    res.json({ data: policies });
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

module.exports = router;
