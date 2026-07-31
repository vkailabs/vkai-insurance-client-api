'use strict';

const pino = require('pino');
const env = require('../config/env');

// Structured JSON logger (pino). Every line carries a consistent base:
//   timestamp, env, service, level, message  (+ correlationId on request/child loggers)
const logger = pino({
  level: env.logLevel,
  base: {
    env: env.nodeEnv,
    service: env.serviceName,
  },
  // Emit `timestamp` as an ISO-8601 field (default pino key is `time`).
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  formatters: {
    // Log the textual level ("info") rather than the numeric one.
    level(label) {
      return { level: label };
    },
  },
  // pino uses `msg`; expose it as `message` to match the agreed log shape.
  messageKey: 'message',
});

// Build a request/job-scoped child logger that stamps every line with a correlationId.
function withCorrelationId(correlationId) {
  return logger.child({ correlationId });
}

module.exports = { logger, withCorrelationId };
