'use strict';

const express = require('express');
const prisma = require('../lib/prisma');
const { firebaseAuth } = require('../middleware/firebaseAuth');
const { isCatalogStale, refreshCatalogFromProvider } = require('../services/catalogSync');

const router = express.Router();

// GET /v1/catalog
// Returns cached policy_catalog rows. If the cache is stale (>15m), refresh
// from the provider first (best-effort), then serve.
//
// Only ACTIVE rows are shown to customers. The pull historically only ever
// received active rows (the provider filters isActive=true on its pull), but the
// inbound PUSH (POST /v1/sync/catalog) can now deliver a deactivation
// (isActive: false). Filtering on isActive here is what makes that deactivation
// actually hide the plan from the browse catalog.
router.get('/', firebaseAuth, async (req, res, next) => {
  try {
    let rows = await prisma.policyCatalog.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });

    if (isCatalogStale(rows)) {
      req.log.info('Policy catalog is stale; refreshing from provider');
      const refreshed = await refreshCatalogFromProvider(req.correlationId, req.log);
      if (refreshed) {
        rows = await prisma.policyCatalog.findMany({
          where: { isActive: true },
          orderBy: { name: 'asc' },
        });
      }
    }

    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
