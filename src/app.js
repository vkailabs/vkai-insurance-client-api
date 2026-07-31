'use strict';

const express = require('express');
const cors = require('cors');

const env = require('./config/env');
const { correlationId } = require('./middleware/correlationId');
const { requestLogger } = require('./middleware/requestLogger');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const catalogRoutes = require('./routes/catalog');
const policiesRoutes = require('./routes/policies');
const premiumsRoutes = require('./routes/premiums');
const claimsRoutes = require('./routes/claims');
const syncRoutes = require('./routes/sync');

function createApp() {
  const app = express();

  // CORS: allow the frontend dev origin to send the Firebase Bearer token.
  app.use(
    cors({
      origin: env.allowedOrigin,
      allowedHeaders: ['Authorization', 'Content-Type'],
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    })
  );

  app.use(express.json());
  app.use(correlationId); // must run before requestLogger so req.log exists
  app.use(requestLogger);

  // Liveness probe — unauthenticated.
  app.get('/healthz', (req, res) => res.json({ status: 'ok', service: 'vkai-insurance-client-api' }));

  // Customer-authenticated routes (Firebase JWT). Auth is applied inside each router.
  app.use('/v1/catalog', catalogRoutes);
  app.use('/v1/policies', policiesRoutes);
  app.use('/v1/premiums', premiumsRoutes);
  app.use('/v1/claims', claimsRoutes);

  // Inbound provider sync routes (shared-secret auth, applied inside the router).
  app.use('/v1/sync', syncRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
