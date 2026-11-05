import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { withFileLock } from 'copilot-extension-utils/files/lock';
import { updateTextFile } from 'copilot-extension-utils/files/atomic';
import { fixture } from './helpers.mjs';

test('locks release on success and original operation failure', async t => {
  const directory = await fixture(t);
  const path = join(directory, 'operation.lock');
  assert.equal(await withFileLock(path, () => 42), 42);
  const failure = new Error('operation failed');
  await assert.rejects(withFileLock(path, () => { throw failure; }), error => error === failure);
  await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('foreign locks are never reclaimed, including empty or malformed locks', async t => {
  const directory = await fixture(t);
  const path = join(directory, 'operation.lock');
  for (const content of ['', 'not a lock receipt']) {
    await writeFile(path, content);
    await assert.rejects(withFileLock(path, () => assert.fail(), { timeoutMs: 0 }), { code: 'ERR_LOCK_TIMEOUT' });
    assert.equal(await readFile(path, 'utf8'), content);
  }
});

test('aborted acquisition leaves foreign ownership intact', async t => {
  const directory = await fixture(t);
  const path = join(directory, 'operation.lock');
  await writeFile(path, 'foreign');
  const controller = new AbortController();
  const pending = withFileLock(path, () => assert.fail(), { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(await readFile(path, 'utf8'), 'foreign');
});

test('Windows transient access denial is retried while permanent denial retains its cause', {
  skip: process.platform !== 'win32',
}, async t => {
  const directory = await fixture(t);
  const path = join(directory, 'operation.lock');
  const original = fs.open;
  const denial = Object.assign(new Error('access denied'), { code: 'EPERM' });
  let attempts = 0;
  const mocked = t.mock.method(fs, 'open', async (...args) => {
    if (++attempts === 1) throw denial;
    return original(...args);
  });
  assert.equal(await withFileLock(path, () => 42, { retryMs: 1 }), 42);
  assert.equal(attempts, 2);
  mocked.mock.mockImplementation(async () => { throw denial; });
  await assert.rejects(withFileLock(path, () => assert.fail(), { timeoutMs: 0 }), error =>
    error.code === 'ERR_LOCK_TIMEOUT' && error.cause === denial);
});

test('ownership changes are explicit and a release failure does not hide an operation failure', async t => {
  const directory = await fixture(t);
  const path = join(directory, 'operation.lock');
  const failure = new Error('operation failed');
  await assert.rejects(withFileLock(path, async () => {
    await writeFile(path, 'foreign');
    throw failure;
  }), error => error instanceof AggregateError && error.errors[0] === failure
    && error.errors[1].code === 'ERR_LOCK_OWNERSHIP');
  assert.equal(await readFile(path, 'utf8'), 'foreign');
});

test('atomic updates initialize missing files and leave identical text untouched', async t => {
  const directory = await fixture(t);
  const path = join(directory, 'state.txt');
  const first = await updateTextFile(path, current => {
    assert.equal(current, null);
    return '\ufeffhello\r\n';
  }, { expectedText: null });
  assert.equal(first.changed, true);
  const before = await stat(path);
  const second = await updateTextFile(path, text => text);
  assert.equal(second.changed, false);
  assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
  assert.equal(await readFile(path, 'utf8'), '\ufeffhello\r\n');
  assert.deepEqual(await readdir(directory), ['state.txt']);
});

test('stale expectations reject before calling the updater', async t => {
  const directory = await fixture(t);
  const path = join(directory, 'state.txt');
  await writeFile(path, 'current');
  await assert.rejects(updateTextFile(path, () => assert.fail(), { expectedText: 'old' }), { code: 'ERR_FILE_CONFLICT' });
  assert.equal(await readFile(path, 'utf8'), 'current');
});

test('a temporary close failure cannot hide the write failure or replace existing data', async t => {
  const directory = await fixture(t);
  const path = join(directory, 'state.txt');
  await writeFile(path, 'original');
  const writeFailure = new Error('write failed');
  const closeFailure = new Error('close failed');
  const originalOpen = fs.open;
  const mocked = t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0].endsWith('.tmp')) {
      t.mock.method(handle, 'writeFile', async () => { throw writeFailure; });
      const close = handle.close.bind(handle);
      t.mock.method(handle, 'close', async () => {
        await close();
        throw closeFailure;
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  let temporaryPath;
  await assert.rejects(updateTextFile(path, () => 'replacement'), error => {
    temporaryPath = error.temporaryPath;
    return error.cause instanceof AggregateError
      && error.cause.errors[0] === writeFailure && error.cause.errors[1] === closeFailure;
  });
  assert.equal(await readFile(path, 'utf8'), 'original');
  assert.ok((await stat(temporaryPath)).isFile());
  await assert.rejects(stat(`${path}.lock`), { code: 'ENOENT' });
});

test('non-cooperating edits detected during an update are preserved', async t => {
  const directory = await fixture(t);
  const path = join(directory, 'state.txt');
  await writeFile(path, 'original');
  await assert.rejects(updateTextFile(path, async () => {
    await writeFile(path, 'external edit');
    return 'replacement';
  }), { code: 'ERR_FILE_CONFLICT' });
  assert.equal(await readFile(path, 'utf8'), 'external edit');
  assert.deepEqual(await readdir(directory), ['state.txt']);
});

test('concurrent processes share the lock rather than overwriting increments', async t => {
  const directory = await fixture(t);
  const path = join(directory, 'counter.txt');
  const worker = fileURLToPath(new URL('./fixtures/update-worker.mjs', import.meta.url));
  const outcomes = await Promise.allSettled(Array.from({ length: 3 }, () =>
    promisify(execFile)(process.execPath, [worker, path], { windowsHide: true })));
  const failures = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason);
  if (failures.length) throw new AggregateError(failures, 'Contending worker processes failed.');
  assert.equal(await readFile(path, 'utf8'), '24');
  assert.deepEqual(await readdir(directory), ['counter.txt']);
});

test('invalid UTF-8, directories and updater failures cannot replace user data', async t => {
  const directory = await fixture(t);
  const path = join(directory, 'state.txt');
  await writeFile(path, Buffer.from([255]));
  await assert.rejects(updateTextFile(path, () => 'replacement'), TypeError);
  assert.deepEqual(await readFile(path), Buffer.from([255]));
  const child = join(directory, 'child');
  await mkdir(child);
  await assert.rejects(updateTextFile(child, () => 'replacement'), /regular/);
  await writeFile(path, 'original');
  await assert.rejects(updateTextFile(path, () => null), TypeError);
  const failure = new Error('updater failed');
  await assert.rejects(updateTextFile(path, () => { throw failure; }), error => error === failure);
  assert.equal(await readFile(path, 'utf8'), 'original');
});

test('a lock path alias cannot replace the target with a lock receipt', async t => {
  const directory = await fixture(t);
  const path = join(directory, 'state.txt');
  await assert.rejects(updateTextFile(path, () => 'replacement', { lockPath: path }), TypeError);
  assert.deepEqual(await readdir(directory), []);
});

test('a symlink target is refused rather than replaced or followed', async t => {
  const directory = await fixture(t);
  const target = join(directory, 'target.txt');
  const path = join(directory, 'link.txt');
  await writeFile(target, 'original');
  try {
    await symlink(target, path);
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    t.skip('Creating symbolic links is not permitted on this host.');
    return;
  }
  await assert.rejects(updateTextFile(path, () => 'replacement'), /non-symlink/);
  assert.equal(await readFile(target, 'utf8'), 'original');
});
