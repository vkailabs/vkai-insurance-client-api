'use strict';

const { v4: uuidv4 } = require('uuid');
const env = require('../config/env');
const prisma = require('../lib/prisma');
const { logger } = require('../lib/logger');

const CATALOG_STALE_MS = 15 * 60 * 1000; // 15 minutes

// True if the catalog cache has never been synced or is older than the window.
function isCatalogStale(rows) {
  if (rows.length === 0) return true;
  const newest = rows.reduce((max, r) => {
    const t = r.lastSyncedAt ? r.lastSyncedAt.getTime() : 0;
    return t > max ? t : max;
  }, 0);
  return Date.now() - newest > CATALOG_STALE_MS;
}

// Pull the provider's catalog and upsert it into policy_catalog. Best-effort:
// on any failure we log and keep serving the cached copy.
async function refreshCatalogFromProvider(correlationId, log = logger) {
  const url = `${env.providerApiBaseUrl}/v1/catalog/policies`;
  try {
    const res = await fetch(url, {
      headers: {
        'X-VKAI-Sync-Key': env.syncKey || '',
        'X-VKAI-Correlation-Id': correlationId || uuidv4(),
      },
    });

    if (!res.ok) {
      log.warn({ url, status: res.status }, 'Catalog refresh returned non-2xx; serving cached catalog');
      return false;
    }

    const body = await res.json();
    const items = Array.isArray(body) ? body : body.policies || body.data || [];
    const now = new Date();

    for (const item of items) {
      const providerPolicyId = item.provider_policy_id || item.id;
      if (!providerPolicyId) continue;

      const data = {
        providerPolicyId,
        name: item.name,
        description: item.description ?? null,
        premiumAmount: item.premium_amount,
        coverageAmount: item.coverage_amount,
        isActive: item.is_active ?? true,
        lastSyncedAt: now,
      };

      // Upsert keyed on the provider's policy id so repeated syncs don't dupe.
      const existing = await prisma.policyCatalog.findFirst({ where: { providerPolicyId } });
      if (existing) {
        await prisma.policyCatalog.update({ where: { id: existing.id }, data });
      } else {
        await prisma.policyCatalog.create({ data });
      }
    }

    log.info({ count: items.length }, 'Catalog refreshed from provider');
    return true;
  } catch (err) {
    log.warn({ url, err: err.message }, 'Catalog refresh failed; serving cached catalog');
    return false;
  }
}

module.exports = { isCatalogStale, refreshCatalogFromProvider, CATALOG_STALE_MS };
