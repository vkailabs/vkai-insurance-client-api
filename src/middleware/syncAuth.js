'use strict';

const env = require('../config/env');

const SYNC_HEADER = 'x-vkai-sync-key';

// Guards the /v1/sync/* routes (called by the provider, not customers).
// Checks X-VKAI-Sync-Key against the configured shared secret.
function syncAuth(req, res, next) {
  const provided = req.headers[SYNC_HEADER];

  if (!env.syncKey) {
    req.log.error('VKAI_INSURANCE_CLIENT_API_SYNC_KEY is not configured; rejecting sync call');
    return res.status(401).json({ error: 'Sync authentication not configured' });
  }

  if (!provided || provided !== env.syncKey) {
    req.log.warn('Rejected sync call with missing/invalid sync key');
    return res.status(401).json({ error: 'Invalid sync key' });
  }

  next();
}

module.exports = { syncAuth, SYNC_HEADER };
