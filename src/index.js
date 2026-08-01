'use strict';

const { createApp } = require('./app');
const env = require('./config/env');
const prisma = require('./lib/prisma');
const { logger } = require('./lib/logger');
const { startRetrySyncJob } = require('./jobs/retrySync');

async function main() {
  const app = createApp();

  const server = app.listen(env.port, () => {
    logger.info({ port: env.port }, 'vkai-insurance-client-api listening');
  });

  // Start the background sync retry job (every 5 minutes).
  const retryJob = startRetrySyncJob();
  logger.info('Retry sync cron job scheduled');

  // Graceful shutdown.
  async function shutdown(signal) {
    logger.info({ signal }, 'Shutting down');
    retryJob.stop();
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'Fatal startup error');
  process.exit(1);
});
