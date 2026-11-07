import { spawn } from 'node:child_process';

const processes = [
  ['API', ['--watch', 'src/server.js']],
  ['indexing worker', ['src/workers/indexing.worker.js']],
  ['parsing worker', ['src/workers/parsing.worker.js']],
  ['embedding worker', ['src/workers/embedding.worker.js']]
];

const children = [];
let stopping = false;

function stopAll(exitCode = 0, signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
  const forceStop = setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }, 5000);
  forceStop.unref();
}

for (const [label, args] of processes) {
  const child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env });
  children.push(child);
  child.once('error', (error) => {
    console.error(`Could not start ${label}: ${error.message}`);
    stopAll(1);
  });
  child.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(`${label} exited${signal ? ` on ${signal}` : ` with code ${code}`}; stopping the development stack.`);
      stopAll(code || 1);
    }
  });
}

process.once('SIGINT', () => stopAll(0, 'SIGINT'));
process.once('SIGTERM', () => stopAll(0, 'SIGTERM'));
