'use strict';

const express = require('express');
const prisma = require('../lib/prisma');
const { firebaseAuth } = require('../middleware/firebaseAuth');
const { isCatalogStale, refreshCatalogFromProvider } = require('../services/catalogSync');

const router = express.Router();

// GET /v1/catalog
// Returns cached policy_catalog rows. If the cache is stale (>15m), refresh
// from the provider first (best-effort), then serve.
router.get('/', firebaseAuth, async (req, res, next) => {
  try {
    let rows = await prisma.policyCatalog.findMany({ orderBy: { name: 'asc' } });

    if (isCatalogStale(rows)) {
      req.log.info('Policy catalog is stale; refreshing from provider');
      const refreshed = await refreshCatalogFromProvider(req.correlationId, req.log);
      if (refreshed) {
        rows = await prisma.policyCatalog.findMany({ orderBy: { name: 'asc' } });
      }
    }

    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
