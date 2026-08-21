'use strict';

const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const prisma = require('../lib/prisma');
const { withCorrelationId } = require('../lib/logger');
const {
  syncPolicyRecordByStatus,
  syncPremiumRecord,
  syncClaimRecord,
} = require('../services/providerSync');

const MAX_ATTEMPTS = 5;
const SCHEDULE = '*/5 * * * *'; // every 5 minutes

// Find unsynced records for one table and re-run their outbound sync. Each
// record keeps its existing event_id (idempotency key) across retries.
async function retryTable(delegate, syncFn, correlationId, log) {
  const records = await delegate.findMany({
    where: {
      syncStatus: { in: ['pending', 'failed'] },
      syncAttempts: { lt: MAX_ATTEMPTS },
    },
    take: 100,
  });

  let succeeded = 0;
  for (const record of records) {
    // syncFn persists the outcome (synced, or failed + attempt increment).
    const updated = await syncFn(record, correlationId, log);
    if (updated.syncStatus === 'synced') succeeded += 1;
  }
  return { total: records.length, succeeded };
}

// One pass over all three syncable tables.
async function runOnce() {
  const correlationId = uuidv4();
  const log = withCorrelationId(correlationId);
  log.info('Retry sync job starting');
  try {
    const [policies, premiums, claims] = await Promise.all([
      // Dispatch by status so a failed CANCELLATION re-pushes to the status
      // route, not the enrollment route (VKAI-010).
      retryTable(prisma.policy, syncPolicyRecordByStatus, correlationId, log),
      retryTable(prisma.premium, syncPremiumRecord, correlationId, log),
      retryTable(prisma.claim, syncClaimRecord, correlationId, log),
    ]);
    log.info({ policies, premiums, claims }, 'Retry sync job finished');
  } catch (err) {
    log.error({ err: err.message }, 'Retry sync job errored');
  }
}

// Register the cron schedule. Returns the task so callers can stop it in tests.
function startRetrySyncJob() {
  const task = cron.schedule(SCHEDULE, runOnce);
  return task;
}

module.exports = { startRetrySyncJob, runOnce, SCHEDULE, MAX_ATTEMPTS };
