import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { observeOperation } from '../diagnostics/operation.mjs';

export async function withFileLock(path, operation, { diagnostics, ...options } = {}) {
  return observeOperation('file.lock', diagnostics, trace => runWithLock(path, operation, options, trace));
}

async function runWithLock(path, operation, {
  timeoutMs = 5000, retryMs = 25, signal,
}, trace) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError('Lock path must be absolute.');
  if (typeof operation !== 'function') throw new TypeError('Lock operation must be a function.');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(retryMs) || retryMs <= 0) {
    throw new RangeError('Lock timeout must be nonnegative and retry interval must be positive.');
  }
  const deadline = performance.now() + timeoutMs;
  const token = JSON.stringify({ token: randomUUID(), pid: process.pid });
  let handle;
  let attempts = 0;
  while (!handle) {
    signal?.throwIfAborted();
    try {
      attempts++;
      handle = await fs.open(path, 'wx', 0o600);
    } catch (error) {
      const windowsBusy = process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code);
      if (error.code !== 'EEXIST' && !windowsBusy) throw error;
      trace('contended', { attempts });
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw Object.assign(new Error(`Lock acquisition timed out: ${path}`, { cause: error }), { code: 'ERR_LOCK_TIMEOUT' });
      }
      await delay(Math.min(retryMs, remaining), undefined, { signal });
    }
  }
  try {
    await handle.writeFile(token);
  } catch (error) {
    try {
      await handle.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], `Lock initialization and close failed; inspect ${path}`);
    }
    throw new Error(`Could not initialize lock; evidence retained at ${path}`, { cause: error });
  }
  trace('acquired', { attempts });
  const outcome = await Promise.resolve().then(operation).then(
    value => ({ value }), error => ({ failed: true, error }),
  );
  try {
    await handle.close();
    if (await fs.readFile(path, 'utf8') !== token) {
      throw Object.assign(new Error(`Lock ownership changed: ${path}`), { code: 'ERR_LOCK_OWNERSHIP' });
    }
    await fs.unlink(path);
  } catch (error) {
    if (outcome.failed) throw new AggregateError([outcome.error, error], 'Operation and lock release both failed.');
    throw error;
  }
  if (outcome.failed) throw outcome.error;
  return outcome.value;
}
