import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { observeOperation } from '../diagnostics/operation.mjs';
import { readTextFile, updateTextFile } from '../files/atomic.mjs';

const plans = new WeakSet();
const windows = process.platform === 'win32';
const canonicalDrive = value => windows ? value.replace(/^[a-z]:/i, drive => drive.toUpperCase()) : value;
const conflict = () => Object.assign(new Error('Managed file changed after planning.'), { code: 'ERR_INSTALL_CONFLICT' });

async function resolveDirectory(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError('Managed paths must be absolute.');
  const input = canonicalDrive(resolve(path));
  const directory = canonicalDrive(await realpath(input));
  let part = input;
  for (;;) {
    if (!(await lstat(part)).isDirectory()) throw new TypeError('Managed paths need existing, non-linked directories.');
    const parent = dirname(part);
    if (part === directory || parent === part) break;
    part = parent;
    if (canonicalDrive(await realpath(part)) === part) break;
  }
  return directory;
}

async function requireDirectory(path) {
  if (await resolveDirectory(path) !== path) {
    throw new TypeError('Managed files require an existing, canonical directory.');
  }
}

async function resolveTarget(path, parent) {
  const target = join(parent, basename(path));
  if (windows && basename(target).includes(':')) {
    throw new TypeError('Managed targets must be files, not alternate data streams.');
  }
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return target;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new TypeError('Managed targets must be regular files.');
  const actual = canonicalDrive(await realpath(target));
  if (dirname(actual) !== parent) throw conflict();
  return actual;
}

async function requireTargetSpelling(path) {
  if (await resolveTarget(path, dirname(path)) !== path) throw conflict();
}

async function readTarget(path) {
  await requireDirectory(dirname(path));
  await requireTargetSpelling(path);
  return readTextFile(path);
}

function assertPlan(plan) {
  if (!plans.has(plan)) throw new TypeError('Provide a managed-file plan from this module.');
}

export function planManagedFiles({ root, files, update = false, diagnostics }) {
  return observeOperation('installer.plan', diagnostics, async () => {
    if (!Array.isArray(files) || !files.length || typeof update !== 'boolean') throw new TypeError('Invalid managed files.');
    const directory = await resolveDirectory(root);
    // Compare the resolved directory names; Windows path.relative folds case even when the filesystem doesn't.
    const prefix = directory.endsWith(sep) ? directory : `${directory}${sep}`;
    const entries = [];
    const seen = new Set();
    const folded = new Set();
    const missing = new Set();
    for (const { path, text } of files) {
      if (typeof path !== 'string' || !isAbsolute(path) || typeof text !== 'string'
        || Buffer.from(text).toString() !== text) throw new TypeError('Provide absolute paths and valid UTF-8 text.');
      const absolute = resolve(path);
      const parent = await resolveDirectory(dirname(absolute));
      if (parent !== directory && !parent.startsWith(prefix)) throw new TypeError('Managed target escapes the root.');
      const target = await resolveTarget(absolute, parent);
      const name = target.slice(prefix.length);
      if (/\.lock$/i.test(name)) throw new TypeError('Managed target uses a reserved lock name.');
      const before = await readTarget(target);
      const key = target.toLowerCase();
      if (seen.has(target) || (windows && (missing.has(key) || (before === null && folded.has(key))))) {
        throw new TypeError('Managed target is duplicated.');
      }
      seen.add(target);
      if (windows) {
        folded.add(key);
        if (before === null) missing.add(key);
      }
      if (!update && before !== null && before !== text) {
        throw Object.assign(new Error('Existing managed file differs; explicitly request an update.'), { code: 'ERR_INSTALL_UPDATE_REQUIRED' });
      }
      entries.push(Object.freeze({ path: target, name, before, text }));
    }
    const plan = Object.freeze({ entries: Object.freeze(entries) });
    plans.add(plan);
    return plan;
  });
}

export function backupManagedFiles(plan, parent, { diagnostics } = {}) {
  return observeOperation('installer.backup', diagnostics, async () => {
    assertPlan(plan);
    const entries = plan.entries.filter(({ before, text }) => before !== null && before !== text);
    if (!entries.length) return { directory: null, count: 0 };
    const backupParent = await resolveDirectory(parent);
    const directory = await mkdtemp(join(backupParent, 'install-'));
    try {
      for (const { path, name, before } of entries) {
        if (await readTarget(path) !== before) throw conflict();
        const target = join(directory, name);
        await mkdir(dirname(target), { recursive: true });
        const bytes = Buffer.from(before);
        await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
        if (!(await readFile(target)).equals(bytes)) throw new Error('Managed file backup verification failed.');
      }
    } catch (error) {
      throw Object.assign(new Error('Backup failed; partial backup retained.', { cause: error }), { backupDirectory: directory });
    }
    return { directory, count: entries.length };
  });
}

export function applyManagedFiles(plan, { diagnostics } = {}) {
  return observeOperation('installer.files', diagnostics, async trace => {
    assertPlan(plan);
    for (const { path, before } of plan.entries) if (await readTarget(path) !== before) throw conflict();
    const changed = [];
    for (const { path, text, before } of plan.entries) {
      if (before === text) continue;
      try {
        await requireDirectory(dirname(path));
        await updateTextFile(path, async () => {
          await requireDirectory(dirname(path));
          await requireTargetSpelling(path);
          return text;
        }, { expectedText: before });
        changed.push(path);
        trace('file_replaced', { changed: true });
      } catch (cause) {
        if (cause?.fileCommitted || cause?.operationCompleted) changed.push(path);
        throw Object.assign(new Error('Managed file installation stopped; inspect the target before retrying.', { cause }), {
          changed, attemptedPath: path,
        });
      }
    }
    return { changed };
  });
}

export function verifyManagedFiles(plan, { diagnostics } = {}) {
  return observeOperation('installer.verify_files', diagnostics, async () => {
    assertPlan(plan);
    for (const { path, text } of plan.entries) {
      if (await readTarget(path) !== text) throw new Error('Installed managed file does not match its plan.');
    }
  });
}
