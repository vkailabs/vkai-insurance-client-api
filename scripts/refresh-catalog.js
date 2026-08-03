'use strict';

// One-off force-refresh of the cached policy catalog from the provider.
//
// This bypasses the natural 15-minute staleness window used by GET /v1/catalog:
// it calls refreshCatalogFromProvider() directly, which always pulls and upserts
// regardless of how recently the cache was synced. Use it after the provider
// ships a catalog change (e.g. VKAI-002's new `key` field) so already-cached rows
// pick up their `key` immediately instead of waiting for the window to expire.
//
// Upsert is keyed on provider_policy_id, so existing rows are UPDATED in place
// (their `key` is filled in) — no duplicates are created.
//
// Run it against a deployed environment where the provider API is reachable, e.g.:
//   docker compose exec api npm run catalog:refresh
// or, running the API directly on the host:
//   npm run catalog:refresh
//
// Requires the same env as the API (VKAI_INSURANCE_PROVIDER_API_BASE_URL,
// VKAI_INSURANCE_CLIENT_API_SYNC_KEY, VKAI_INSURANCE_CLIENT_API_DATABASE_URL).

const { v4: uuidv4 } = require('uuid');
const { refreshCatalogFromProvider } = require('../src/services/catalogSync');
const { logger } = require('../src/lib/logger');
const prisma = require('../src/lib/prisma');

(async () => {
  const correlationId = uuidv4();
  logger.info({ correlationId }, 'Force-refreshing policy catalog from provider (bypassing staleness window)');

  let exitCode = 0;
  try {
    const ok = await refreshCatalogFromProvider(correlationId, logger);
    if (ok) {
      logger.info({ correlationId }, 'Catalog force-refresh complete');
    } else {
      logger.error({ correlationId }, 'Catalog force-refresh did not complete (provider unreachable or non-2xx)');
      exitCode = 1;
    }
  } catch (err) {
    logger.error({ correlationId, err: err.message }, 'Catalog force-refresh threw');
    exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }

  process.exit(exitCode);
})();
