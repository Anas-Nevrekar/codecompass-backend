import 'dotenv/config';
import { validateEnv } from './config/env.js';

let config;
try {
  config = validateEnv();
} catch (error) {
  console.error(`Invalid environment configuration: ${error.message}`);
  process.exit(1);
}

const [
  { createApp }, 
  { prisma }, 
  { redis }] = await Promise.all([
  import('./app.js'), import('./lib/prisma.js'), import('./lib/redis.js')
]);

const app = createApp({ prisma, redis, config });
const server = app.listen(config.port, () => {
  console.info(`CodeCompass API listening on port ${config.port}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`Received ${signal}; shutting down`);
  const forceTimer = setTimeout(() => {
    console.error('Graceful shutdown timed out');
    process.exit(1);
  }, 10000);
  forceTimer.unref();
  server.close(async (serverError) => {
    const results = await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
    clearTimeout(forceTimer);
    const failed = serverError || results.some((result) => result.status === 'rejected');
    if (failed) {
      console.error('Shutdown encountered an error', serverError ?? results);
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
