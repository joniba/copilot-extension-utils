import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withFileLock } from '../files/lock.mjs';

export function withStatusLock(path, action, options) {
  return process.platform === 'win32' ? withPipeLock(path, action, options) : withFileLock(path, action, options);
}

async function withPipeLock(path, action, { timeoutMs = 5000, retryMs = 25, signal } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(retryMs) || retryMs <= 0) {
    throw new RangeError('Invalid status lock timing.');
  }
  const key = join(await realpath(dirname(path)), basename(path)).toLowerCase();
  const address = `\\\\.\\pipe\\extension-utils-status-${createHash('sha256').update(key).digest('hex')}`;
  const deadline = performance.now() + timeoutMs;
  let server;
  for (;;) {
    signal?.throwIfAborted();
    server = createServer(socket => socket.destroy());
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(address, resolve);
      });
      break;
    } catch (error) {
      if (!['EADDRINUSE', 'EACCES', 'EPERM'].includes(error.code)) throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw Object.assign(new Error('Status lock acquisition timed out.', { cause: error }), { code: 'ERR_LOCK_TIMEOUT' });
      }
      await delay(Math.min(remaining, retryMs), undefined, { signal });
    }
  }
  const outcome = await Promise.resolve().then(action).then(value => ({ value }), error => ({ failed: true, error }));
  try {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } catch (error) {
    if (outcome.failed) throw new AggregateError([outcome.error, error], 'Status write and lock release both failed.');
    throw error;
  }
  if (outcome.failed) throw outcome.error;
  return outcome.value;
}
