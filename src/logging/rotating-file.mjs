import { appendFile, lstat, open, rename } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { withFileLock } from '../files/lock.mjs';

async function size(path) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular log file: ${path}`);
  return info.size;
}

async function withLogHandle(path, flags, operation) {
  const file = await open(path, flags, 0o600);
  let failure;
  try {
    return await operation(file);
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    try { await file.close(); }
    catch (error) {
      if (failure) throw new AggregateError([failure.error, error], 'Log file operation and close both failed.');
      throw error;
    }
  }
}

function endsWithNewline(path, bytes) {
  return withLogHandle(path, 'r', async file => {
    const tail = Buffer.alloc(1);
    const { bytesRead } = await file.read(tail, 0, 1, bytes - 1);
    if (bytesRead !== 1) throw Object.assign(new Error('The log changed while reading its tail.'), { code: 'ERR_LOG_CHANGED' });
    return tail[0] === 10;
  });
}

export function createRotatingFileSink({ path, maxBytes = 2 * 1024 * 1024, backups = 3, separatePartialLine = false }) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError('Log path must be absolute.');
  if (typeof separatePartialLine !== 'boolean') throw new TypeError('separatePartialLine must be boolean.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(backups) || backups < 1) {
    throw new RangeError('Log size and backup count must be positive integers.');
  }
  let pending = Promise.resolve();
  return async record => {
    const encoded = JSON.stringify(record);
    if (encoded === undefined) throw new TypeError('Log records must be JSON serializable.');
    const line = `${encoded}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > maxBytes) throw new RangeError('Log record exceeds the configured file size limit.');
    const write = async () => {
      let deliveryOutcome = 'not-written';
      try {
        await withFileLock(`${path}.lock`, async () => {
          const current = await size(path);
          let separator = separatePartialLine && current > 0 && current + bytes <= maxBytes
            && !await endsWithNewline(path, current) ? '\n' : '';
          if (current > 0 && current + bytes + separator.length > maxBytes) {
            separator = '';
            for (let index = backups - 1; index >= 0; index--) {
              const source = index === 0 ? path : `${path}.${index}`;
              const target = `${path}.${index + 1}`;
              if (await size(source) > 0) {
                await size(target);
                await rename(source, target);
              }
            }
          }
          if (separatePartialLine) {
            await withLogHandle(path, 'a', async file => {
              deliveryOutcome = 'uncertain';
              await file.appendFile(`${separator}${line}`, 'utf8');
              deliveryOutcome = 'written';
            });
          } else {
            await appendFile(path, line, { encoding: 'utf8', mode: 0o600 });
          }
        }, separatePartialLine ? { diagnostics: { write() {} }, retryRef: false } : undefined);
      } catch (cause) {
        if (!separatePartialLine) throw cause;
        throw Object.assign(new Error('Log write or lock cleanup failed.', { cause }), { deliveryOutcome });
      }
    };
    const result = pending.then(write, write);
    pending = result;
    return result;
  };
}
