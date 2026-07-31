'use strict';

// Logs one structured line per request on completion, using the
// correlation-scoped logger attached by the correlationId middleware.
function requestLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    (req.log || console).info(
      {
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      },
      `${req.method} ${req.originalUrl} ${res.statusCode}`
    );
  });

  next();
}

module.exports = { requestLogger };
