const CHECK_TIMEOUT_MS = 3000;

async function withTimeout(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} check timed out`)), CHECK_TIMEOUT_MS);
        timer.unref?.();
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function checkReadiness({ prisma, redis }) {
  const checks = await Promise.allSettled([
    withTimeout(prisma.$queryRaw`SELECT 1`, 'PostgreSQL'),
    withTimeout(redis.ping(), 'Redis')
  ]);
  const dependencies = {
    postgres: checks[0].status === 'fulfilled' ? 'ok' : 'error',
    redis: checks[1].status === 'fulfilled' && checks[1].value === 'PONG' ? 'ok' : 'error'
  };
  const ready = Object.values(dependencies).every((status) => status === 'ok');
  return { statusCode: ready ? 200 : 503, body: { status: ready ? 'ok' : 'error', dependencies } };
}
