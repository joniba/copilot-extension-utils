import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { fixture } from './helpers.mjs';

const loader = new URL('./fixtures/isolation-loader.mjs', import.meta.url).href;
async function isolated(script, blocked, hook = loader) {
  return promisify(execFile)(process.execPath, [
    '--experimental-loader', hook, '--input-type=module', '--eval', script,
  ], {
    windowsHide: true,
    env: { ...process.env, UTILS_TEST_BLOCKED: JSON.stringify(blocked) },
  });
}

test('logging and file modules import without loading any settings implementation', async () => {
  await isolated(`
    const {createLogger} = await import('copilot-extension-utils/logging/logger');
    await import('copilot-extension-utils/logging/rotating-file');
    await import('copilot-extension-utils/files/atomic');
    const logger = createLogger({sinks:[() => {}],fields:[]});
    await logger.record('info','startup');
  `, ['/settings/', '/jsonc-parser/']);
});

test('pure JSONC editing loads neither logging nor filesystem implementations', async () => {
  await isolated(`
    const {patchSettings} = await import('copilot-extension-utils/settings/jsonc');
    const result = patchSettings('{}',[{path:['enabled'],value:true}]);
    if (!result.value.enabled) throw new Error('Edit was not applied.');
  `, ['/logging/', '/files/', 'node:fs']);
});

test('checkout directory names cannot be mistaken for forbidden module dependencies', async t => {
  const directory = await fixture(t);
  const copied = join(directory, 'files', 'checkout', 'test', 'fixtures', 'isolation-loader.mjs');
  await mkdir(dirname(copied), { recursive: true });
  await copyFile(fileURLToPath(loader), copied);
  const copiedURL = pathToFileURL(copied).href;
  await isolated(`
    import assert from 'node:assert/strict';
    const {resolve} = await import(${JSON.stringify(copiedURL)});
    const root = new URL('../../', ${JSON.stringify(copiedURL)});
    await resolve('pure', {}, async () => ({url: new URL('src/settings/jsonc.mjs', root).href}));
    await assert.rejects(resolve('files', {}, async () => ({
      url: new URL('src/files/atomic.mjs', root).href,
    })), /Unexpected dependency/);
    await assert.rejects(resolve('node:fs', {}, async () => ({url: 'node:fs'})), /Unexpected dependency/);
  `, ['/files/', 'node:fs'], copiedURL);
});

test('there is no root barrel import that implicitly couples exposed modules', async () => {
  await assert.rejects(import('copilot-extension-utils'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});
