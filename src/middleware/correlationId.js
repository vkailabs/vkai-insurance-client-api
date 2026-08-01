'use strict';

const { v4: uuidv4 } = require('uuid');
const { withCorrelationId } = require('../lib/logger');

const CORRELATION_HEADER = 'x-vkai-correlation-id';

// Reads X-VKAI-Correlation-Id from the incoming request (or generates one),
// attaches it and a correlation-scoped logger to req, and echoes it back on the
// response so callers can stitch traces together.
function correlationId(req, res, next) {
  const incoming = req.headers[CORRELATION_HEADER];
  const id = typeof incoming === 'string' && incoming.trim() !== '' ? incoming.trim() : uuidv4();

  req.correlationId = id;
  req.log = withCorrelationId(id);
  res.setHeader('X-VKAI-Correlation-Id', id);

  next();
}

module.exports = { correlationId, CORRELATION_HEADER };
