import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { fixture } from './helpers.mjs';

test('a packed installation runs independently of the source checkout', async t => {
  const directory = await fixture(t);
  const source = fileURLToPath(new URL('../', import.meta.url));
  const npm = process.env.npm_execpath;
  assert.ok(npm, 'Run package validation through npm test so the active npm CLI is explicit.');
  const execute = promisify(execFile);
  const { stdout } = await execute(process.execPath, [
    npm, 'pack', '--json', '--pack-destination', directory,
  ], { cwd: source, windowsHide: true });
  const pack = JSON.parse(stdout)[0];
  assert.ok(pack.files.every(file => !file.path.startsWith('test/')));
  const consumer = join(directory, 'consumer');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}');
  await execute(process.execPath, [
    npm, 'install', '--offline', '--ignore-scripts', join(directory, pack.filename),
  ], { cwd: consumer, windowsHide: true });
  const script = join(consumer, 'verify.mjs');
  const logPath = join(consumer, 'debug.jsonl');
  const settingsPath = join(consumer, 'settings.json');
  await writeFile(script, `
    import {createLogger} from 'copilot-extension-utils/logging/logger';
    import {createRotatingFileSink} from 'copilot-extension-utils/logging/rotating-file';
    import {updateSettings} from 'copilot-extension-utils/settings/store';
    const logger = createLogger({
      fields:['token'], sinks:[createRotatingFileSink({path:${JSON.stringify(logPath)}})],
    });
    await logger.record('info','startup',{token:'private value'});
    await updateSettings(${JSON.stringify(settingsPath)},[{path:['enabled'],value:true}]);
  `);
  await execute(process.execPath, [script], { cwd: consumer, windowsHide: true });
  assert.equal(JSON.parse(await readFile(logPath, 'utf8')).fields.token, '[redacted]');
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).enabled, true);
});

test('packed logging assets resolve locally without blocking the consumer when unavailable or stalled', {
  timeout: 120_000,
}, async t => {
  const build = await fixture(t);
  const home = await fixture(t);
  const source = fileURLToPath(new URL('../', import.meta.url));
  const npm = process.env.npm_execpath;
  assert.ok(npm, 'Run package validation through npm test.');
  const execute = promisify(execFile);
  const run = (file, args, cwd = build) => execute(process.execPath, [file, ...args], {
    cwd, windowsHide: true, timeout: 30_000,
  });
  await cp(new URL('./fixtures/logging-consumer/', import.meta.url), build, { recursive: true });
  await writeFile(join(build, 'package.json'), JSON.stringify({
    name: 'sample-logging-consumer', version: '1.0.0', private: true, type: 'module',
    bin: { 'sample-logging-consumer': 'install.mjs' },
    files: ['install.mjs', 'entry.mjs'],
    bundleDependencies: ['copilot-extension-utils'],
  }));
  await run(npm, ['install', '--offline', '--ignore-scripts', '--install-links', source]);
  const { stdout } = await run(npm, ['pack', '--json', '--pack-destination', build]);
  const installer = join(build, JSON.parse(stdout)[0].filename);
  await run(join(dirname(npm), 'npx-cli.js'), [
    '--offline', '--ignore-scripts', `--package=${installer}`, '--', 'sample-logging-consumer', home,
  ]);

  const runtime = join(home, 'extensions', 'sample-logging');
  const entry = join(runtime, 'entry.mjs');
  const logPath = join(home, 'session.jsonl');
  const normal = await run(entry, [logPath], home);
  assert.deepEqual(JSON.parse(normal.stdout), { result: 'operation-result' });
  assert.match(normal.stderr, /diagnostic-import-completed/);
  const lines = (await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines.map(record => record.event), ['request.send.started', 'request.send.completed']);
  assert.deepEqual(lines.map(record => record.fields.sessionId), ['sample-session', 'sample-session']);

  const sourceFile = join(runtime, 'lib', 'diagnostics', 'trace.mjs');
  const damaged = join(home, 'damaged.jsonl');
  await writeFile(sourceFile, 'export function');
  const bad = await run(entry, [damaged], home);
  assert.deepEqual(JSON.parse(bad.stdout), { result: 'operation-result' });
  assert.match(bad.stderr, /diagnostic-import-unavailable/);
  await assert.rejects(readFile(damaged), { code: 'ENOENT' });

  const stalledLog = join(home, 'stalled.jsonl');
  await writeFile(sourceFile, "console.error('fixture-import-pending'); await new Promise(() => {});");
  const stalled = await run(entry, [stalledLog], home);
  assert.deepEqual(JSON.parse(stalled.stdout), { result: 'operation-result' });
  assert.match(stalled.stderr, /fixture-import-pending/);
  assert.doesNotMatch(stalled.stderr, /diagnostic-import-(?:completed|unavailable)/);
  await assert.rejects(readFile(stalledLog), { code: 'ENOENT' });

  const missingRuntime = join(home, 'missing-runtime');
  await mkdir(missingRuntime);
  const missingEntry = join(missingRuntime, 'entry.mjs');
  await cp(entry, missingEntry);
  const missing = await run(missingEntry, [join(home, 'missing.jsonl')], home);
  assert.deepEqual(JSON.parse(missing.stdout), { result: 'operation-result' });
  assert.match(missing.stderr, /diagnostic-import-unavailable/);
});

test('the documented starter installs via npx and runs its installed command without the build checkout', { timeout: 120_000 }, async t => {
  const directory = await realpath(await fixture(t));
  const source = fileURLToPath(new URL('../', import.meta.url));
  const npm = process.env.npm_execpath;
  assert.ok(npm, 'Run package validation through npm test.');
  const npx = join(dirname(npm), 'npx-cli.js');
  const execute = promisify(execFile);
  const run = (program, args, cwd = directory) => execute(process.execPath, [program, ...args], {
    cwd, windowsHide: true, timeout: 30_000,
  });
  const starter = join(directory, 'starter');
  await cp(join(source, 'examples', 'starter'), starter, { recursive: true });
  await run(npm, ['install', '--ignore-scripts', '--offline', '--install-links', source], starter);
  const { stdout } = await run(npm, ['pack', '--json', '--pack-destination', directory], starter);
  const starterPack = join(directory, JSON.parse(stdout)[0].filename);
  const copilotHome = join(directory, 'isolated-home');
  const invoke = flags => run(npx, [
    '--offline', '--ignore-scripts', `--package=${starterPack}`, '--', 'extension-utils-starter',
    ...flags, '--copilot-home', copilotHome,
  ]);
  assert.match((await invoke(['--help'])).stdout, /--doctor/);
  assert.match((await invoke([])).stdout, /Checking prerequisites[\s\S]+Installation complete/);
  assert.match((await invoke(['--doctor'])).stdout, /version verified/);
  const target = join(copilotHome, 'extensions', 'extension-utils-starter');
  assert.equal(JSON.parse(await readFile(join(target, 'installed.json'), 'utf8')).version, '1.0.0');
  const script = join(copilotHome, 'verify.mjs');
  await writeFile(script, `
    import assert from 'node:assert/strict';
    import { greetingCommand } from './extensions/extension-utils-starter/command.mjs';
    const output = [];
    const session = { sessionId: 'sample-session', log: message => output.push(message) };
    const { name, handler } = greetingCommand(() => session);
    assert.equal(name, 'utils-greet');
    await handler({ sessionId: session.sessionId, args: 'hello' });
    assert.deepEqual(output, ['Hello from the sample extension.']);
  `);
  await execute(process.execPath, [script], { cwd: copilotHome, windowsHide: true });
  // Fail a replacement and lock release to exercise recovery through a combined error.
  await writeFile(join(target, 'extension.mjs'), 'old entrypoint');
  await writeFile(join(target, 'command.mjs'), 'old command');
  const failed = join(target, 'command.mjs');
  const installLock = join(target, 'installed.json.install.lock');
  const fault = join(directory, 'fault.mjs');
  await writeFile(fault, `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const rename = fs.rename;
    const unlink = fs.unlink;
    fs.rename = async (from, to) => {
      if (to === ${JSON.stringify(failed)}) throw Object.assign(new Error('Simulated write failure.'), { code: 'EIO' });
      await rename(from, to);
    };
    fs.unlink = async path => {
      if (path === ${JSON.stringify(installLock)}) throw Object.assign(new Error('Simulated release failure.'), { code: 'EIO' });
      await unlink(path);
    };
    syncBuiltinESMExports();
  `);
  let backup;
  await assert.rejects(
    run('--import', [pathToFileURL(fault).href, join(starter, 'install.mjs'), '--update', '--copilot-home', copilotHome]),
    error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Activation: attempted; version receipt: not-attempted/);
      const field = label => {
        const line = error.stderr.split(/\r?\n/).find(value => value.startsWith(label));
        assert.ok(line, `Missing recovery field: ${label}`);
        return JSON.parse(line.slice(label.length));
      };
      assert.deepEqual(field('Known replaced files: '), [join(target, 'extension.mjs')]);
      assert.equal(field('Last attempted file: '), failed);
      backup = field('Backup directory retained: ');
      return true;
    },
  );
  assert.equal(await readFile(join(backup, 'extension.mjs'), 'utf8'), 'old entrypoint');
  assert.equal(await readFile(join(backup, 'command.mjs'), 'utf8'), 'old command');
  assert.notEqual(await readFile(join(target, 'extension.mjs'), 'utf8'), 'old entrypoint');
  assert.equal(await readFile(failed, 'utf8'), 'old command');
  assert.equal(JSON.parse(await readFile(join(target, 'installed.json'), 'utf8')).version, '1.0.0');
  assert.equal(typeof JSON.parse(await readFile(installLock, 'utf8')).token, 'string');
});
