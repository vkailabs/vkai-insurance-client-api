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

// Map ONE provider catalog item (camelCase, the same row shape the pull endpoint
// GET /v1/catalog/policies returns) into our policy_catalog columns and upsert it,
// keyed on the provider's `id` -> our `providerPolicyId`. This is the SINGLE source
// of catalog mapping/upsert logic, reused by BOTH the periodic pull refresh and the
// inbound provider PUSH route (POST /v1/sync/catalog).
//
// Idempotent: upserting the same item twice yields the same final row, and a
// re-delivered/retried event never creates a duplicate (dedupe on providerPolicyId).
// `isActive` is honoured verbatim, INCLUDING false (a provider deactivation), so a
// deactivated plan is stored inactive and drops out of the customer-visible catalog.
async function upsertCatalogItem(item, { now = new Date() } = {}) {
  // The provider returns raw Prisma objects in camelCase; its own `id` is this
  // catalog entry's provider_policy_id from our side's POV.
  const providerPolicyId = item.id;
  if (!providerPolicyId) return null;

  const data = {
    providerPolicyId,
    // Provider-owned display key. Cached verbatim; never generated here.
    // Null when the provider omits it so the row still upserts cleanly.
    key: item.key ?? null,
    name: item.name,
    description: item.description ?? null,
    premiumAmount: item.premiumAmount,
    coverageAmount: item.coverageAmount,
    isActive: item.isActive ?? true,
    lastSyncedAt: now,
  };

  // Upsert keyed on the provider's policy id so repeated syncs don't dupe.
  const existing = await prisma.policyCatalog.findFirst({ where: { providerPolicyId } });
  if (existing) {
    return prisma.policyCatalog.update({ where: { id: existing.id }, data });
  }
  return prisma.policyCatalog.create({ data });
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
      // Same mapping/upsert used by the inbound PUSH route — dedupe on provider id.
      await upsertCatalogItem(item, { now });
    }

    log.info({ count: items.length }, 'Catalog refreshed from provider');
    return true;
  } catch (err) {
    log.warn({ url, err: err.message }, 'Catalog refresh failed; serving cached catalog');
    return false;
  }
}

module.exports = { isCatalogStale, refreshCatalogFromProvider, upsertCatalogItem, CATALOG_STALE_MS };
