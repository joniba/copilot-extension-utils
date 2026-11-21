import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { applyManagedFiles, backupManagedFiles, planManagedFiles, verifyManagedFiles } from 'copilot-extension-utils/install/managed-files';
import { runInstallerCli } from 'copilot-extension-utils/install/npx';
import { createInstallProgress } from 'copilot-extension-utils/install/progress';
import { runInstallation } from 'copilot-extension-utils/install/run';
import { fixture } from './helpers.mjs';

const quiet = { write() {} };

test('installation emits stages in order, verifies before publishing and leaves same-version receipts alone', async t => {
  const receiptPath = join(await fixture(t), 'installed.json');
  const lines = [];
  const options = {
    receiptPath, version: 'build-1', diagnostics: quiet,
    preflight: () => 'plan', prepare: plan => ({ plan }), activate: prepared => prepared.plan,
    async verify(prepared, result) {
      assert.equal(prepared.plan, result);
      await assert.rejects(readFile(receiptPath), { code: 'ENOENT' });
    },
    progress: createInstallProgress({ write: value => lines.push(value) }),
  };
  assert.deepEqual(await runInstallation(options), {
    activation: 'completed', receipt: 'published', result: 'plan', progressFailures: 0,
  });
  assert.deepEqual(lines, ['Checking prerequisites', 'Preparing files and backups', 'Activating extension',
    'Verifying installed files', 'Recording installed version', 'Installation complete']);
  assert.deepEqual(JSON.parse(await readFile(receiptPath, 'utf8')), { version: 'build-1' });
  const modified = (await stat(receiptPath)).mtimeMs;
  assert.equal((await runInstallation({ ...options, verify() {} })).receipt, 'unchanged');
  assert.equal((await stat(receiptPath)).mtimeMs, modified);
});

test('preparation, partial activation and failed verification never advertise a new version', async t => {
  const receiptPath = join(await fixture(t), 'installed.json');
  const old = '{"version":"old"}\r\n';
  await writeFile(receiptPath, old);
  const failure = new Error('synthetic failure');
  const base = {
    receiptPath, version: 'new', diagnostics: quiet, preflight() {}, prepare() {}, activate() {}, verify() {},
  };
  for (const [stage, activation] of [['prepare', 'not-started'], ['activate', 'attempted'], ['verify', 'completed']]) {
    await assert.rejects(runInstallation({ ...base, [stage]() { throw failure; } }), error =>
      error.cause === failure && error.stage === stage && error.activation === activation && error.receipt === 'not-attempted');
    assert.equal(await readFile(receiptPath, 'utf8'), old);
  }
  await assert.rejects(runInstallation({ ...base, verify: () => false }), { stage: 'verify' });
  assert.equal(await readFile(receiptPath, 'utf8'), old);
});

test('intervening receipt edits stop preparation or preserve a conflicting post-activation edit', async t => {
  const receiptPath = join(await fixture(t), 'installed.json');
  const old = '{"version":"old"}';
  const other = '{"version":"other"}';
  const base = {
    receiptPath, version: 'new', diagnostics: quiet, preflight() {}, prepare() {}, activate() {}, verify() {},
  };
  await writeFile(receiptPath, old);
  await assert.rejects(runInstallation({
    ...base, prepare: () => writeFile(receiptPath, other), activate: () => assert.fail('must not activate'),
  }), { activation: 'not-started' });
  assert.equal(await readFile(receiptPath, 'utf8'), other);
  await writeFile(receiptPath, old);
  await assert.rejects(runInstallation({ ...base, verify: () => writeFile(receiptPath, other) }), {
    activation: 'completed', receipt: 'conflict',
  });
  assert.equal(await readFile(receiptPath, 'utf8'), other);
});

test('broken progress output stays observable without losing a successful install', async t => {
  const receiptPath = join(await fixture(t), 'installed.json');
  const records = [];
  const result = await runInstallation({
    receiptPath, version: 'one', preflight() {}, prepare() {}, activate() {}, verify() {},
    progress() { throw new Error('sensitive progress transport details'); },
    diagnostics: { debug: false, write: record => records.push(record) },
  });
  assert.equal(result.receipt, 'published');
  assert.equal(result.progressFailures, 6);
  assert.equal(records.filter(record => record.level === 'warn').length, 6);
  assert.ok(!JSON.stringify(records).includes('sensitive'));
  assert.ok(!JSON.stringify(records).includes(receiptPath));
});

test('guarded update requires opt-in, verifies exact backups and preserves unrelated data', async t => {
  const root = await fixture(t);
  const backup = join(root, 'backups');
  await mkdir(backup);
  const path = join(root, 'entry.mjs');
  const local = join(root, 'preferences.json');
  const old = '\ufefforiginal\r\n';
  await writeFile(path, old);
  await writeFile(local, 'keep');
  const options = { root, files: [{ path, text: 'new' }], diagnostics: quiet };
  await assert.rejects(planManagedFiles(options), { code: 'ERR_INSTALL_UPDATE_REQUIRED' });
  const plan = await planManagedFiles({ ...options, update: true });
  const saved = await backupManagedFiles(plan, backup, { diagnostics: quiet });
  assert.equal(saved.count, 1);
  assert.equal(await readFile(join(saved.directory, 'entry.mjs'), 'utf8'), old);
  assert.deepEqual(await applyManagedFiles(plan, { diagnostics: quiet }), { changed: [path] });
  await verifyManagedFiles(plan, { diagnostics: quiet });
  assert.equal(await readFile(local, 'utf8'), 'keep');
});

test('managed-file preflight rejects competing edits and paths outside its root before replacing any file', async t => {
  const root = await fixture(t);
  const first = join(root, 'a.mjs');
  const second = join(root, 'b.mjs');
  const plan = await planManagedFiles({
    root, files: [{ path: first, text: 'a' }, { path: second, text: 'b' }],
  });
  await writeFile(second, 'other');
  await assert.rejects(applyManagedFiles(plan, { diagnostics: quiet }), { code: 'ERR_INSTALL_CONFLICT' });
  await assert.rejects(stat(first), { code: 'ENOENT' });
  assert.equal(await readFile(second, 'utf8'), 'other');
  await assert.rejects(planManagedFiles({
    root, files: [{ path: join(root, '..', 'outside.mjs'), text: 'bad' }], diagnostics: quiet,
  }), /escapes/);
});

test('Windows managed files accept path spelling aliases but reject duplicate file entries', {
  skip: process.platform !== 'win32',
}, async t => {
  const directory = await realpath(await fixture(t));
  const root = join(directory, 'Managed');
  await mkdir(root);
  const path = join(root, 'Example.mjs');
  await writeFile(path, 'preserve');
  const alias = join(directory, 'managed', 'example.mjs');
  const plan = await planManagedFiles({
    root, files: [{ path: alias, text: 'new' }], update: true, diagnostics: quiet,
  });
  await assert.rejects(planManagedFiles({
    root, files: [{ path, text: 'one' }, { path: alias, text: 'two' }], update: true, diagnostics: quiet,
  }), /duplicated/);
  assert.equal(await readFile(path, 'utf8'), 'preserve');
  assert.deepEqual(await applyManagedFiles(plan, { diagnostics: quiet }), { changed: [path] });
  assert.equal(await readFile(path, 'utf8'), 'new');
});

test('npx entry point separates help, install and doctor, rejecting unknown flags and a failed check', async t => {
  const home = await fixture(t);
  const calls = [];
  const cfg = {
    name: 'sample', version: '1.0.0', write: value => calls.push(value), diagnostics: quiet,
    install: value => calls.push(value), doctor: ({ copilotHome }) => ({ ok: copilotHome !== home }),
  };
  await runInstallerCli(['--help'], cfg);
  await runInstallerCli(['--version'], cfg);
  await runInstallerCli(['--update', '--copilot-home', home], cfg);
  assert.deepEqual(calls, ['Usage: sample [--update | --doctor | --version | --help] [--copilot-home PATH]',
    '1.0.0', { copilotHome: home, update: true }]);
  await assert.rejects(runInstallerCli(['--doctor', '--copilot-home', home], cfg), { code: 'ERR_INSTALL_DOCTOR' });
  await assert.rejects(runInstallerCli(['--doctor', '--update'], cfg), /Conflicting/);
  await assert.rejects(runInstallerCli(['--unknown'], cfg), { code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' });
});
