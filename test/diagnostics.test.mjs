import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { observeOperation } from 'copilot-extension-utils/diagnostics/operation';
import { createLogger } from 'copilot-extension-utils/logging/logger';
import { updateTextFile } from 'copilot-extension-utils/files/atomic';
import { withFileLock } from 'copilot-extension-utils/files/lock';
import { updateSettings } from 'copilot-extension-utils/settings/store';
import { fixture } from './helpers.mjs';

test('disabled traces stay quiet while failures remain observable without private payloads', async () => {
  const records = [];
  const diagnostics = { debug: false, write: record => records.push(record) };
  assert.equal(await observeOperation('worker.run', diagnostics, () => 42), 42);
  assert.equal(records.length, 0);
  const failure = Object.assign(new Error('private content and path'), { code: 'ERR_EXAMPLE' });
  await assert.rejects(observeOperation('worker.run', diagnostics, () => { throw failure; }), error => error === failure);
  assert.equal(records[0].event, 'worker.run.failed');
  assert.equal(records[0].fields.code, 'ERR_EXAMPLE');
  assert.ok(!JSON.stringify(records).includes('private'));
});

test('debug traces follow committed effects and are delivered after resources release', async t => {
  const directory = await fixture(t);
  const path = join(directory, 'settings.json');
  const records = [];
  const acquiredWhileLocked = [];
  await updateSettings(path, [{ path: ['enabled'], value: true }], {
    diagnostics: {
      debug: true,
      async write(record) {
        if (record.event === 'file.lock.acquired') {
          acquiredWhileLocked.push(await stat(`${path}.lock`).then(() => true, error => {
            if (error.code === 'ENOENT') return false;
            throw error;
          }));
        }
        records.push(record);
      },
    },
  });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).enabled, true);
  assert.deepEqual(acquiredWhileLocked, [false]);
  assert.ok(!records.some(record => record.event === 'file.lock.contended'));
  assert.ok(records.some(record => record.event === 'file.update.committed' && record.fields.changed));
  assert.ok(records.some(record => record.event === 'settings.update.completed'));
  assert.ok(!JSON.stringify(records).includes(directory));
});

test('contention is never reported as successful lock acquisition', async t => {
  const directory = await fixture(t);
  const path = join(directory, 'foreign.lock');
  await writeFile(path, 'foreign');
  const records = [];
  await assert.rejects(withFileLock(path, () => assert.fail('A foreign lock must not be acquired.'), {
    timeoutMs: 0,
    diagnostics: { debug: true, write: record => records.push(record) },
  }), { code: 'ERR_LOCK_TIMEOUT' });
  assert.deepEqual(records.map(record => record.event), [
    'file.lock.started', 'file.lock.contended', 'file.lock.failed',
  ]);
  assert.equal(records[1].fields.attempts, 1);
  assert.equal(await readFile(path, 'utf8'), 'foreign');
});

test('diagnostic destination failure uses a nonrecursive fallback without hiding the outcome', async t => {
  const messages = [];
  t.mock.method(console, 'error', message => messages.push(JSON.parse(message)));
  const diagnostics = { debug: true, write: () => { throw new Error('private sink error'); } };
  assert.equal(await observeOperation('worker.run', diagnostics, () => 42), 42);
  assert.ok(messages.every(record => record.event === 'diagnostics.delivery_failed'));
  assert.ok(!JSON.stringify(messages).includes('private'));
  const failure = new Error('operation error');
  await assert.rejects(observeOperation('worker.run', diagnostics, () => { throw failure; }), error => error === failure);
});

test('delivery failure after success is distinguished from failure before effects', async t => {
  let calls = 0;
  t.mock.method(console, 'error', () => { throw new Error('fallback failed'); });
  await assert.rejects(observeOperation('worker.run', {
    debug: true,
    write() { if (++calls > 1) throw new Error('sink failed'); },
  }, () => 42), error => error.code === 'ERR_DIAGNOSTICS_AFTER_SUCCESS' && error.operationCompleted);
});

test('composed file and settings errors retain completed-write markers and diagnostic causes', async t => {
  const directory = await fixture(t);
  const destinationError = new Error('destination failed');
  const fallbackError = new Error('fallback failed');
  t.mock.method(console, 'error', () => { throw fallbackError; });
  const diagnostics = {
    debug: true,
    write(record) {
      if (!record.event.endsWith('.started')) throw destinationError;
    },
  };
  const contains = (error, expected) => error === expected
    || (error instanceof AggregateError && error.errors.some(child => contains(child, expected)))
    || (error?.cause !== undefined && contains(error.cause, expected));
  for (const [name, update] of [
    ['text.txt', path => updateTextFile(path, () => 'committed', { diagnostics })],
    ['settings.json', path => updateSettings(path, [{ path: ['enabled'], value: true }], { diagnostics })],
  ]) {
    const path = join(directory, name);
    await assert.rejects(update(path), error => error.code === 'ERR_DIAGNOSTICS_AFTER_SUCCESS'
      && error.operationCompleted === true && contains(error, destinationError) && contains(error, fallbackError));
    const text = await readFile(path, 'utf8');
    assert.ok(name === 'text.txt' ? text === 'committed' : JSON.parse(text).enabled === true);
    await assert.rejects(stat(`${path}.lock`), { code: 'ENOENT' });
  }
});

test('trace metadata is allowlisted and committed changes survive later failure reporting', async () => {
  const records = [];
  const failure = new Error('cleanup failed');
  await assert.rejects(observeOperation('worker.run', { debug: true, write: record => records.push(record) }, trace => {
    trace('committed', { changed: true, body: 'private text', path: 'private path' });
    throw failure;
  }), error => error === failure);
  assert.equal(records.at(-1).fields.changed, true);
  assert.ok(!JSON.stringify(records).includes('private'));
});

test('structured logger debug output is independently disable-able', async () => {
  const received = [];
  const quiet = createLogger({ fields: [], sinks: [record => received.push(record)] });
  assert.equal(await quiet.record('debug', 'worker.run'), null);
  assert.equal(received.length, 0);
  const verbose = createLogger({ debug: true, fields: [], sinks: [record => received.push(record)] });
  await verbose.record('debug', 'worker.run');
  assert.equal(received.length, 1);
});
