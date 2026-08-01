'use strict';

// 404 handler for unmatched routes.
function notFound(req, res) {
  res.status(404).json({ error: 'Not found' });
}

// Centralized error handler. Logs with the request correlation id and returns a
// generic 500 (or a status the caller set on the error).
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  (req.log || console).error({ err: err.message, stack: err.stack }, 'Unhandled request error');

  if (res.headersSent) return;
  res.status(status).json({ error: status === 500 ? 'Internal server error' : err.message });
}

module.exports = { notFound, errorHandler };
