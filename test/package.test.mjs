import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
