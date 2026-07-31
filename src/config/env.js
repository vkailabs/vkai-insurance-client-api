'use strict';

// Centralized, validated access to environment variables.
// All app-owned settings use the VKAI_INSURANCE_CLIENT_API_ prefix.

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    // We don't hard-crash here for local dev ergonomics; individual subsystems
    // (Firebase, sync) surface clearer errors when their config is missing.
    return undefined;
  }
  return value;
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.VKAI_INSURANCE_CLIENT_API_PORT || '4000', 10),
  logLevel: process.env.VKAI_INSURANCE_CLIENT_API_LOG_LEVEL || 'info',
  databaseUrl: required('VKAI_INSURANCE_CLIENT_API_DATABASE_URL'),

  firebase: {
    projectId: required('VKAI_INSURANCE_CLIENT_API_FIREBASE_PROJECT_ID'),
    clientEmail: required('VKAI_INSURANCE_CLIENT_API_FIREBASE_CLIENT_EMAIL'),
    // Private keys pasted into .env keep literal "\n" sequences; restore them.
    privateKey: (process.env.VKAI_INSURANCE_CLIENT_API_FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n') || undefined,
  },

  // Shared secret used both to authenticate inbound provider calls and to sign
  // our outbound calls to the provider.
  syncKey: required('VKAI_INSURANCE_CLIENT_API_SYNC_KEY'),

  providerApiBaseUrl: process.env.VKAI_INSURANCE_PROVIDER_API_BASE_URL || 'http://localhost:4100',

  serviceName: 'vkai-insurance-client-api',
};

module.exports = env;
