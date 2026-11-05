import { appendFile, lstat, rename } from 'node:fs/promises';
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

export function createRotatingFileSink({ path, maxBytes = 2 * 1024 * 1024, backups = 3 }) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError('Log path must be absolute.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(backups) || backups < 1) {
    throw new RangeError('Log size and backup count must be positive integers.');
  }
  return async record => {
    const encoded = JSON.stringify(record);
    if (encoded === undefined) throw new TypeError('Log records must be JSON serializable.');
    const line = `${encoded}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > maxBytes) throw new RangeError('Log record exceeds the configured file size limit.');
    await withFileLock(`${path}.lock`, async () => {
      const current = await size(path);
      if (current > 0 && current + bytes > maxBytes) {
        for (let index = backups - 1; index >= 0; index--) {
          const source = index === 0 ? path : `${path}.${index}`;
          const target = `${path}.${index + 1}`;
          if (await size(source) > 0) {
            await size(target);
            await rename(source, target);
          }
        }
      }
      await appendFile(path, line, { encoding: 'utf8', mode: 0o600 });
    });
  };
}
