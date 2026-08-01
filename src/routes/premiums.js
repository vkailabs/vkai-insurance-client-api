'use strict';

const express = require('express');
const prisma = require('../lib/prisma');
const { firebaseAuth } = require('../middleware/firebaseAuth');
const { syncPremiumRecord } = require('../services/providerSync');

const router = express.Router();

router.use(firebaseAuth);

// POST /v1/premiums  { policy_id, amount }
// Record a premium payment against one of the user's policies, then sync.
router.post('/', async (req, res, next) => {
  try {
    const { policy_id: policyId, amount } = req.body || {};
    if (!policyId || amount === undefined) {
      return res.status(400).json({ error: 'policy_id and amount are required' });
    }
    if (Number(amount) <= 0 || Number.isNaN(Number(amount))) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }

    // Ownership check: the policy must belong to the requesting user.
    const policy = await prisma.policy.findFirst({ where: { id: policyId, userId: req.user.id } });
    if (!policy) {
      return res.status(404).json({ error: 'Policy not found' });
    }

    const premium = await prisma.premium.create({
      data: { policyId, amount },
    });

    const synced = await syncPremiumRecord(premium, req.correlationId, req.log);

    res.status(201).json({ data: synced });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
