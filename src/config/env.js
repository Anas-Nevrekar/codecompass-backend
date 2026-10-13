const DEFAULTS = {
  NODE_ENV: 'development',
  PORT: '3000',
  FRONTEND_URL: 'http://localhost:5173',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/codecompass',
  REDIS_URL: 'redis://localhost:6379'
};

export function validateEnv(source = process.env) {
  const values = { ...DEFAULTS, ...source };
  const port = Number(values.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  for (const [key, protocols] of Object.entries({
    FRONTEND_URL: ['http:', 'https:'],
    DATABASE_URL: ['postgres:', 'postgresql:'],
    REDIS_URL: ['redis:', 'rediss:']
  })) {
    let parsed;
    try { parsed = new URL(values[key]); } catch {
      throw new Error(`${key} must be a valid URL`);
    }
    if (!protocols.includes(parsed.protocol)) {
      throw new Error(`${key} must use ${protocols.join(' or ')}`);
    }
  }
  if (!['development', 'test', 'production'].includes(values.NODE_ENV)) {
    throw new Error('NODE_ENV must be development, test, or production');
  }
  return Object.freeze({
    nodeEnv: values.NODE_ENV,
    port,
    frontendUrl: values.FRONTEND_URL,
    databaseUrl: values.DATABASE_URL,
    redisUrl: values.REDIS_URL
  });
}
