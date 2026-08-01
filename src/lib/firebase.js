'use strict';

const admin = require('firebase-admin');
const env = require('../config/env');
const { logger } = require('./logger');

// Lazily initialize the Firebase Admin SDK so the process can still boot for
// non-auth work (migrations, health checks) when credentials are absent.
let initialized = false;

function ensureInitialized() {
  if (initialized) return admin;

  const { projectId, clientEmail, privateKey } = env.firebase;
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'Firebase Admin credentials are not configured. Set ' +
        'VKAI_INSURANCE_CLIENT_API_FIREBASE_PROJECT_ID, _FIREBASE_CLIENT_EMAIL and _FIREBASE_PRIVATE_KEY.'
    );
  }

  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
  initialized = true;
  logger.info('Firebase Admin SDK initialized');
  return admin;
}

// Verify a Firebase ID token and return the decoded claims.
async function verifyIdToken(idToken) {
  const app = ensureInitialized();
  return app.auth().verifyIdToken(idToken);
}

module.exports = { verifyIdToken };
