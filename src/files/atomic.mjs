import { lstat, open, readFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { withFileLock } from './lock.mjs';
import { observeOperation } from '../diagnostics/operation.mjs';

async function snapshot(path) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular, non-symlink file: ${path}`);
  return { bytes: await readFile(path), mode: info.mode & 0o777, ino: info.ino, dev: info.dev };
}

function same(left, right) {
  if (left === null || right === null) return left === right;
  return left.mode === right.mode && left.ino === right.ino
    && left.dev === right.dev && left.bytes.equals(right.bytes);
}

function conflict(path) {
  return Object.assign(new Error(`File changed concurrently: ${path}`), { code: 'ERR_FILE_CONFLICT' });
}

export async function updateTextFile(path, update, options = {}) {
  return observeOperation('file.update', options.diagnostics, trace => updateFile(path, update, options, trace));
}

async function updateFile(path, update, options, trace) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError('File path must be absolute.');
  if (typeof update !== 'function') throw new TypeError('File update must be a function.');
  if (Object.hasOwn(options, 'expectedText') && options.expectedText !== null && typeof options.expectedText !== 'string') {
    throw new TypeError('expectedText must be a string or null for a missing file.');
  }
  const { lockPath = `${path}.lock`, expectedText, ...lockOptions } = options;
  const normalize = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  if (typeof lockPath === 'string' && normalize(lockPath) === normalize(path)) {
    throw new TypeError('Lock path must differ from the target file.');
  }
  return withFileLock(lockPath, async () => {
    const before = await snapshot(path);
    const text = before === null ? null : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(before.bytes);
    if (Object.hasOwn(options, 'expectedText') && text !== expectedText) throw conflict(path);
    const next = await update(text);
    if (typeof next !== 'string') throw new TypeError('File update must return text.');
    if (!same(before, await snapshot(path))) throw conflict(path);
    if (next === text) {
      await trace('unchanged', { changed: false });
      return { changed: false, text };
    }
    const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporaryPath, 'wx', before?.mode ?? 0o600);
      let failure;
      try {
        if (before) await handle.chmod(before.mode);
        await handle.writeFile(next, 'utf8');
        await handle.sync();
      } catch (error) {
        failure = { error };
      }
      try {
        await handle.close();
      } catch (error) {
        if (failure) throw new AggregateError([failure.error, error], 'Temporary file write and close both failed.');
        throw error;
      }
      if (failure) throw failure.error;
      if (!same(before, await snapshot(path))) throw conflict(path);
      await rename(temporaryPath, path);
    } catch (error) {
      throw Object.assign(new Error(`Atomic update failed; inspect temporary file at ${temporaryPath}`, { cause: error }), {
        code: error.code,
        temporaryPath,
      });
    }
    await trace('committed', { changed: true });
    return { changed: true, text: next };
  }, lockOptions);
}
