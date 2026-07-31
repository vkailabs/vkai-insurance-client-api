'use strict';

const express = require('express');
const prisma = require('../lib/prisma');
const { firebaseAuth } = require('../middleware/firebaseAuth');
const { syncClaimRecord } = require('../services/providerSync');

const router = express.Router();

router.use(firebaseAuth);

// POST /v1/claims  { policy_id, amount_claimed, description }
// File a claim against one of the user's policies, then sync outbound.
router.post('/', async (req, res, next) => {
  try {
    const { policy_id: policyId, amount_claimed: amountClaimed, description } = req.body || {};
    if (!policyId || amountClaimed === undefined || !description) {
      return res.status(400).json({ error: 'policy_id, amount_claimed and description are required' });
    }
    if (Number(amountClaimed) <= 0 || Number.isNaN(Number(amountClaimed))) {
      return res.status(400).json({ error: 'amount_claimed must be a positive number' });
    }

    const policy = await prisma.policy.findFirst({ where: { id: policyId, userId: req.user.id } });
    if (!policy) {
      return res.status(404).json({ error: 'Policy not found' });
    }

    const claim = await prisma.claim.create({
      data: { policyId, amountClaimed, description, status: 'Submitted' },
    });

    const synced = await syncClaimRecord(claim, req.correlationId, req.log);

    res.status(201).json({ data: synced });
  } catch (err) {
    next(err);
  }
});

// GET /v1/claims
// List all claims filed by the logged-in user (across their policies).
router.get('/', async (req, res, next) => {
  try {
    const claims = await prisma.claim.findMany({
      where: { policy: { userId: req.user.id } },
      orderBy: { submittedAt: 'desc' },
    });
    res.json({ data: claims });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
