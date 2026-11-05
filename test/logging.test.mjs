import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { redact } from 'copilot-extension-utils/logging/redaction';
import { createLogger } from 'copilot-extension-utils/logging/logger';
import { createRotatingFileSink } from 'copilot-extension-utils/logging/rotating-file';
import { fixture } from './helpers.mjs';

test('redaction handles credentials, nested errors and cycles without changing inputs', () => {
  const token = ['ghp', 'syntheticvalue'].join('_');
  const input = {
    accessToken: 'private value',
    nested: [{ 'API-KEY': 'private value', text: `Bearer synthetic ${token}` }],
    error: new Error('password=synthetic', { cause: new Error('https://user:pass@example.invalid') }),
    aggregate: new AggregateError([new Error('{"client_secret": "synthetic with spaces"}')], 'failure'),
  };
  input.self = input;
  const output = redact(input);
  const encoded = JSON.stringify(output);
  for (const secret of ['private value', 'synthetic', token, 'user:pass']) assert.ok(!encoded.includes(secret));
  assert.equal(output.self, '[circular]');
  assert.equal(input.accessToken, 'private value');
  assert.equal(output.error.name, 'Error');
  assert.equal(output.aggregate.errors.length, 1);
});

test('redaction bounds strings and collection depth but permits repeated non-circular objects', () => {
  const shared = { elapsedMs: 2 };
  const output = redact({ long: 'x'.repeat(9000), values: [shared, shared], many: Array(101).fill(1) });
  assert.ok(output.long.endsWith('[truncated]'));
  assert.deepEqual(output.values[0], output.values[1]);
  assert.equal(output.many.at(-1), '[truncated]');
  let deep = {};
  for (let index = 0; index < 12; index++) deep = { child: deep };
  assert.ok(JSON.stringify(redact(deep)).includes('[depth limit]'));
});

test('logger allowlists metadata and redacts before every destination', async () => {
  const received = [];
  const logger = createLogger({
    fields: ['elapsedMs', 'error'],
    sinks: [record => received.push(record)],
    now: () => new Date('2026-01-01T00:00:00Z'),
  });
  const record = await logger.record('warn', 'worker.failed', {
    elapsedMs: 40, body: 'private content', error: new Error('token=private'),
    timestamp: 'forged', level: 'forged',
  });
  assert.equal(received[0], record);
  assert.equal(record.timestamp, '2026-01-01T00:00:00.000Z');
  assert.equal(record.level, 'warn');
  assert.equal(record.fields.elapsedMs, 40);
  assert.equal(record.fields.error.message, 'token=[redacted]');
  assert.ok(!JSON.stringify(record).includes('private'));
  assert.equal(record.fields.body, undefined);
});

test('a failed log sink cannot prevent another sink and failures remain explicit', async () => {
  const failure = new Error('sink unavailable');
  const received = [];
  const logger = createLogger({
    fields: [], sinks: [() => { throw failure; }, async record => received.push(record)],
  });
  await assert.rejects(logger.record('error', 'worker.failed'), error =>
    error instanceof AggregateError && error.errors[0] === failure);
  assert.equal(received.length, 1);
});

test('logger rejects dynamic event messages and invalid configuration before delivery', async () => {
  assert.throws(() => createLogger({ sinks: [], fields: [] }));
  assert.throws(() => createLogger({ sinks: [() => {}] }));
  const logger = createLogger({ sinks: [() => assert.fail('must not send')], fields: [] });
  await assert.rejects(logger.record('info', 'a message with content'), TypeError);
  await assert.rejects(logger.record('unsupported', 'event'), TypeError);
});

test('rotation stays byte-bounded, retains the newest records and resumes indefinitely', async t => {
  const directory = await fixture(t);
  const path = join(directory, 'debug.jsonl');
  const sink = createRotatingFileSink({ path, maxBytes: 100, backups: 2 });
  for (let index = 0; index < 30; index++) await sink({ index, text: 'unicode: \u00e9' });
  const files = await readdir(directory);
  assert.deepEqual(files.sort(), ['debug.jsonl', 'debug.jsonl.1', 'debug.jsonl.2']);
  const records = [];
  for (const name of files) {
    const file = join(directory, name);
    assert.ok((await stat(file)).size <= 100);
    records.push(...(await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line)));
  }
  assert.ok(records.some(record => record.index === 29));
  assert.ok(!records.some(record => record.index === 0));
});

test('separate file sinks coordinate writes without lost or broken records', async t => {
  const directory = await fixture(t);
  const path = join(directory, 'debug.jsonl');
  const left = createRotatingFileSink({ path });
  const right = createRotatingFileSink({ path });
  const outcomes = await Promise.allSettled(Array.from({ length: 20 }, (_, index) =>
    (index % 2 ? left : right)({ index })));
  const failures = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason);
  if (failures.length) throw new AggregateError(failures, 'Contending file sinks failed.');
  const records = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.map(record => record.index).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i));
  for (const parity of [0, 1]) {
    assert.deepEqual(records.filter(record => record.index % 2 === parity).map(record => record.index),
      Array.from({ length: 10 }, (_, index) => index * 2 + parity));
  }
  await assert.rejects(stat(`${path}.lock`), { code: 'ENOENT' });
});

test('a failed append remains observable without poisoning later queued writes', async t => {
  const directory = await fixture(t);
  const path = join(directory, 'debug.jsonl');
  const failure = new Error('append failed');
  const append = fs.appendFile;
  let attempts = 0;
  const mocked = t.mock.method(fs, 'appendFile', async (...args) => {
    if (++attempts === 1) throw failure;
    return append(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  const sink = createRotatingFileSink({ path });
  const outcomes = await Promise.allSettled([sink({ index: 1 }), sink({ index: 2 })]);
  assert.equal(outcomes[0].status, 'rejected');
  assert.equal(outcomes[0].reason, failure);
  assert.equal(outcomes[1].status, 'fulfilled');
  assert.equal(JSON.parse((await readFile(path, 'utf8')).trim()).index, 2);
  await assert.rejects(stat(`${path}.lock`), { code: 'ENOENT' });
});

test('oversized or unserializable records fail without changing existing logs', async t => {
  const directory = await fixture(t);
  const path = join(directory, 'debug.jsonl');
  await writeFile(path, 'original\n');
  const sink = createRotatingFileSink({ path, maxBytes: 20 });
  await assert.rejects(sink({ text: 'x'.repeat(100) }), RangeError);
  await assert.rejects(sink(undefined), TypeError);
  assert.equal(await readFile(path, 'utf8'), 'original\n');
  assert.deepEqual(await readdir(directory), ['debug.jsonl']);
});
