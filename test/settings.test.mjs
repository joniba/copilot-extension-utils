import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { parseSettings, patchSettings } from 'copilot-extension-utils/settings/jsonc';
import { updateSettings } from 'copilot-extension-utils/settings/store';
import { fixture } from './helpers.mjs';

test('surgical JSONC updates preserve BOM, comments, line endings and unrelated fields', () => {
  const original = '\ufeff{\r\n  // retained comment\r\n  "foreign": {"keep":true},\r\n  "preferences": {"interval":10, "other":7},\r\n}\r\n';
  const { text, value } = patchSettings(original, [{ path: ['preferences', 'interval'], value: 20 }]);
  assert.equal(text, original.replace('"interval":10', '"interval":20'));
  assert.equal(value.preferences.other, 7);
  assert.deepEqual({ ...value.foreign }, { keep: true });
});

test('missing nested properties can be added without resetting other preferences', () => {
  const original = '{\n  // retain\n  "foreign": true,\n}\n';
  const result = patchSettings(original, [{ path: ['preferences', 'enabled'], value: false }]);
  assert.ok(result.text.includes('// retain'));
  assert.equal(result.value.foreign, true);
  assert.equal(result.value.preferences.enabled, false);
});

test('malformed, ambiguous or non-object settings are rejected', () => {
  for (const text of ['{broken', '[]', 'null', '{"a":1,"a":2}', '{"a":[{"b":1,"b":2}]}']) {
    assert.throws(() => patchSettings(text, []), SyntaxError);
  }
});

test('unsafe paths, scalar traversal and non-JSON values are rejected', () => {
  for (const path of [[], ['__proto__', 'polluted'], ['constructor'], ['list', 0]]) {
    assert.throws(() => patchSettings('{}', [{ path, value: true }]), TypeError);
  }
  for (const value of [undefined, NaN, Infinity, new Date(), () => {}]) {
    assert.throws(() => patchSettings('{}', [{ path: ['value'], value }]), TypeError);
  }
  const circular = {};
  circular.self = circular;
  assert.throws(() => patchSettings('{}', [{ path: ['value'], value: circular }]), TypeError);
  assert.throws(() => patchSettings('{"a":null}', [{ path: ['a', 'b'], value: true }]), TypeError);
  assert.equal({}.polluted, undefined);
});

test('settings persistence rereads under the same lock and preserves concurrent independent edits', async t => {
  const directory = await fixture(t);
  const path = join(directory, 'settings.json');
  await writeFile(path, '{\n  // retained\n  "foreign": true\n}\n');
  await Promise.all([
    updateSettings(path, [{ path: ['left'], value: 1 }]),
    updateSettings(path, [{ path: ['right'], value: 2 }]),
  ]);
  const text = await readFile(path, 'utf8');
  assert.ok(text.includes('// retained'));
  assert.deepEqual({ ...parseSettings(text) }, { foreign: true, left: 1, right: 2 });
});

test('consumer validation rejects changes without rewriting the existing file', async t => {
  const directory = await fixture(t);
  const path = join(directory, 'settings.json');
  await writeFile(path, '{"foreign":true}');
  await assert.rejects(updateSettings(path, [{ path: ['interval'], value: -1 }], {
    validate: value => value.interval > 0,
  }), /validation rejected/);
  assert.equal(await readFile(path, 'utf8'), '{"foreign":true}');
  assert.deepEqual(await readdir(directory), ['settings.json']);
});

test('missing settings initialize explicitly and stale views cannot overwrite newer state', async t => {
  const directory = await fixture(t);
  const path = join(directory, 'settings.json');
  await updateSettings(path, [{ path: ['enabled'], value: true }], { expectedText: null });
  await assert.rejects(updateSettings(path, [{ path: ['enabled'], value: false }], { expectedText: null }), {
    code: 'ERR_FILE_CONFLICT',
  });
  assert.equal(parseSettings(await readFile(path, 'utf8')).enabled, true);
});
