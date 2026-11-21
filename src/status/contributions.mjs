import { randomUUID } from 'node:crypto';
import { mkdir, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { observeOperation } from '../diagnostics/operation.mjs';
import { keepText, readTextFile, updateTextFile } from '../files/atomic.mjs';
import { validStatusIdentity, validStatusRecord, statusValue } from './record.mjs';
import { withStatusLock } from './lock.mjs';

const limit = 16_384;

function traceOutcome(trace, outcome) {
  trace(outcome.replace('-', '_'), { changed: outcome === 'published' || outcome === 'cleared' });
  return outcome;
}

function decode(text, sessionId, provider) {
  if (text === null) return null;
  if (Buffer.byteLength(text) > limit) throw new RangeError('Status record exceeds the byte limit.');
  const record = JSON.parse(text);
  if (!validStatusRecord(record) || record.sessionId !== sessionId || record.provider !== provider) {
    throw new TypeError('Invalid or mismatched status record.');
  }
  return record;
}

function validateLocation(directory, sessionId) {
  if (!isAbsolute(directory) || !validStatusIdentity(sessionId)) throw new TypeError('Invalid status directory or session.');
}

function verifyDirectory(path, actual) {
  const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (comparable(path) !== comparable(actual)) throw new TypeError('Status directory must be canonical, not linked.');
}

export function createStatusPublisher({
  directory, sessionId, provider, lifetimeMs = 30_000, clock = Date.now, diagnostics,
  lock: { timeoutMs, retryMs } = {},
}) {
  validateLocation(directory, sessionId);
  if (!validStatusIdentity(provider) || !Number.isSafeInteger(lifetimeMs)
    || lifetimeMs < 1 || lifetimeMs > 120_000 || typeof clock !== 'function') throw new TypeError('Invalid publisher options.');
  const owner = randomUUID();
  const parent = join(directory, sessionId);
  const path = join(parent, `${provider}.json`);
  let tail = Promise.resolve();
  let closing;
  let owns = false;
  let lost = false;

  function enqueue(action) {
    const pending = tail.then(action);
    tail = pending.catch(() => {});
    return pending;
  }

  async function persist(value) {
    verifyDirectory(directory, await realpath(directory));
    await mkdir(parent).catch(error => { if (error.code !== 'EEXIST') throw error; });
    verifyDirectory(parent, await realpath(parent));
    let outcome;
    try {
      await updateTextFile(path, text => {
        const previous = decode(text, sessionId, provider);
        const now = clock();
        if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + lifetimeMs)) {
          throw new RangeError('Invalid status clock.');
        }
        if (lost || (owns && previous?.owner !== owner)) {
          lost = true;
          outcome = 'not-owner';
          return keepText;
        }
        if (previous && previous.owner !== owner && previous.expiresAt > now) {
          outcome = 'busy';
          return keepText;
        }
        outcome = value === null ? 'cleared' : 'published';
        return `${JSON.stringify({ version: 1, sessionId, provider, owner,
          expiresAt: value === null ? now : now + lifetimeMs, value })}\n`;
      }, { guard: withStatusLock, timeoutMs, retryMs, maxBytes: limit });
    } catch (error) {
      if (error?.fileCommitted && outcome === 'published') owns = true;
      throw error;
    }
    if (outcome === 'published') owns = true;
    return outcome;
  }

  return Object.freeze({
    publish(text, priority) {
      if (closing) return Promise.resolve('closed');
      return observeOperation('status.publish', diagnostics, async trace =>
        traceOutcome(trace, await enqueue(() => persist(statusValue(text, priority)))));
    },
    close() {
      if (closing) return closing;
      let operationError;
      const reported = observeOperation('status.close', diagnostics, async trace => {
        closing = enqueue(() => owns ? persist(null) : 'not-owner');
        let outcome;
        try {
          outcome = await closing;
        } catch (error) {
          operationError = { error };
          throw error;
        }
        return traceOutcome(trace, outcome);
      });
      // If diagnostic configuration was invalid, no close work was admitted.
      if (!closing) return closing = reported;
      reported.catch(error => {
        if (!operationError || operationError.error !== error) {
          process.emitWarning('Status shutdown diagnostics could not be delivered.', { code: 'ERR_STATUS_CLOSE_DIAGNOSTICS' });
        }
      });
      return closing;
    },
  });
}

export function readStatusContributions({ directory, sessionId, diagnostics }) {
  return observeOperation('status.read', diagnostics, async () => {
    validateLocation(directory, sessionId);
    const parent = join(directory, sessionId);
    let names;
    try {
      verifyDirectory(parent, await realpath(parent));
      names = await readdir(parent, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return { records: [], invalidCount: 0 };
      throw error;
    }
    const records = [];
    let invalidCount = 0;
    for (const entry of names) {
      const provider = entry.name.slice(0, -5);
      if (!entry.isFile() || !entry.name.endsWith('.json') || !validStatusIdentity(provider)) continue;
      try {
        const record = decode(await readTextFile(join(parent, entry.name), { diagnostics, maxBytes: limit }), sessionId, provider);
        if (record) records.push(record);
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError)) throw error;
        invalidCount++;
      }
    }
    if (invalidCount) {
      const error = Object.assign(new Error('Invalid status records were ignored.'), { code: 'ERR_STATUS_RECORD' });
      // Record malformed-peer evidence even when debug logging is disabled.
      await observeOperation('status.invalid_records', diagnostics, () => { throw error; }).catch(failure => {
        if (failure !== error) throw failure;
      });
    }
    return { records, invalidCount };
  });
}
