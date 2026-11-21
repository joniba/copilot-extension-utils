import { lstat, open, readFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { withFileLock } from './lock.mjs';
import { observeOperation } from '../diagnostics/operation.mjs';

export const keepText = Symbol('keep current file');

async function snapshot(path, maxBytes = Infinity) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular, non-symlink file: ${path}`);
  if (info.size > maxBytes) throw new RangeError('Text file exceeds its byte limit.');
  const bytes = await readFile(path);
  if (bytes.length > maxBytes) throw new RangeError('Text file exceeds its byte limit.');
  return { bytes, mode: info.mode & 0o777, ino: info.ino, dev: info.dev };
}

function same(left, right) {
  if (left === null || right === null) return left === right;
  return left.mode === right.mode && left.ino === right.ino
    && left.dev === right.dev && left.bytes.equals(right.bytes);
}

function conflict(path) {
  return Object.assign(new Error(`File changed concurrently: ${path}`), { code: 'ERR_FILE_CONFLICT' });
}

function decode(value) {
  return value === null ? null : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value.bytes);
}

function checkLimit(maxBytes) {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    throw new RangeError('File byte limit must be a nonnegative safe integer.');
  }
}

export function readTextFile(path, { diagnostics, maxBytes } = {}) {
  return observeOperation('file.read', diagnostics, async () => {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError('File path must be absolute.');
    checkLimit(maxBytes);
    return decode(await snapshot(path, maxBytes));
  });
}

export async function updateTextFile(path, update, options = {}) {
  const effect = { committed: false };
  try {
    return await observeOperation('file.update', options.diagnostics, trace => updateFile(path, update, options, trace, effect));
  } catch (error) {
    if (effect.committed) error.fileCommitted = true;
    throw error;
  }
}

async function updateFile(path, update, options, trace, effect) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError('File path must be absolute.');
  if (typeof update !== 'function') throw new TypeError('File update must be a function.');
  if (Object.hasOwn(options, 'expectedText') && options.expectedText !== null && typeof options.expectedText !== 'string') {
    throw new TypeError('expectedText must be a string or null for a missing file.');
  }
  const { lockPath = `${path}.lock`, expectedText, maxBytes, guard = withFileLock, ...lockOptions } = options;
  checkLimit(maxBytes);
  if (typeof guard !== 'function') throw new TypeError('File guard must be a function.');
  const normalize = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  if (typeof lockPath === 'string' && normalize(lockPath) === normalize(path)) {
    throw new TypeError('Lock path must differ from the target file.');
  }
  const replace = async () => {
    const before = await snapshot(path, maxBytes);
    const text = decode(before);
    if (Object.hasOwn(options, 'expectedText') && text !== expectedText) throw conflict(path);
    const next = await update(text);
    if (next !== keepText && typeof next !== 'string') throw new TypeError('File update must return text or keepText.');
    if (next === keepText) {
      await trace('unchanged', { changed: false });
      return { changed: false, text };
    }
    if (maxBytes !== undefined && Buffer.byteLength(next) > maxBytes) throw new RangeError('Text file exceeds its byte limit.');
    if (!same(before, await snapshot(path, maxBytes))) throw conflict(path);
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
      if (!same(before, await snapshot(path, maxBytes))) throw conflict(path);
      await rename(temporaryPath, path);
      effect.committed = true;
    } catch (error) {
      throw Object.assign(new Error(`Atomic update failed; inspect temporary file at ${temporaryPath}`, { cause: error }), {
        code: error.code,
        temporaryPath,
      });
    }
    await trace('committed', { changed: true });
    return { changed: true, text: next };
  };
  let result;
  try {
    const guardResult = await guard(lockPath, async () => {
      result = await replace();
      return result;
    }, lockOptions);
    return result ?? guardResult;
  } catch (cause) {
    if (!effect.committed) throw cause;
    throw Object.assign(new Error('File replacement committed before guard completion failed.', { cause }), {
      code: cause?.code, ...(cause?.operationCompleted && { operationCompleted: true }),
    });
  }
}
