import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { composeStatusLine } from 'copilot-extension-utils/status/compose';
import { createStatusPublisher, readStatusContributions } from 'copilot-extension-utils/status/contributions';
import { fixture } from './helpers.mjs';

const quiet = { write() {} };
const worker = fileURLToPath(new URL('./fixtures/status-worker.mjs', import.meta.url));

test('status publishers preserve the base renderer and isolate providers, sessions and expiry', async t => {
  const directory = await fixture(t);
  let now = 100;
  const options = { directory, sessionId: 'session-1', clock: () => now, lifetimeMs: 30 };
  const first = createStatusPublisher({ ...options, provider: 'alpha' });
  const second = createStatusPublisher({ ...options, provider: 'beta' });
  const foreign = createStatusPublisher({ ...options, provider: 'other', sessionId: 'session-2' });
  await Promise.all([first.publish('Alpha', 1), second.publish('Beta', 2), foreign.publish('Foreign', 10)]);
  const { records } = await readStatusContributions(options);
  assert.equal(records.length, 2);
  assert.equal(composeStatusLine('Base', records, { ...options, now }), 'Base | Beta | Alpha');
  assert.equal(composeStatusLine('Base', records, { ...options, now: 130 }), 'Base');
  assert.equal(composeStatusLine('Base', records, { ...options, now, maxContributions: 1 }), 'Base | Beta');
  now = 110;
  await second.publish('Beta', 2);
  const renewed = await readStatusContributions(options);
  assert.equal(composeStatusLine('Base', renewed.records, { ...options, now: 130 }), 'Base | Beta');
});

test('an expired status owner cannot overwrite or clear a successor, even after the successor expires', async t => {
  const directory = await fixture(t);
  let now = 0;
  const options = { directory, sessionId: 'session-1', provider: 'sample', lifetimeMs: 10, clock: () => now };
  const old = createStatusPublisher(options);
  const next = createStatusPublisher(options);
  assert.equal(await old.publish('old'), 'published');
  assert.equal(await next.publish('next'), 'busy');
  now = 10;
  assert.equal(await next.publish('next'), 'published');
  now = 20;
  assert.equal(await old.publish('stale'), 'not-owner');
  assert.equal(await old.close(), 'not-owner');
  const { records } = await readStatusContributions(options);
  assert.equal(records[0].value.text, 'next');
});

test('close drains admitted publications and does not recreate a missing record', async t => {
  const directory = await fixture(t);
  const options = { directory, sessionId: 'session-1', provider: 'sample' };
  const publisher = createStatusPublisher(options);
  const pending = publisher.publish('first');
  const close = publisher.close();
  assert.equal(await publisher.publish('late'), 'closed');
  assert.equal(await pending, 'published');
  assert.equal(await close, 'cleared');
  assert.equal((await readStatusContributions(options)).records[0].value, null);
  const next = createStatusPublisher(options);
  assert.equal(await next.publish('new'), 'published');
  const path = join(directory, options.sessionId, 'sample.json');
  await unlink(path);
  assert.equal(await next.close(), 'not-owner');
  await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('a diagnostic writer can await status shutdown without waiting on itself', { timeout: 5000 }, async t => {
  const directory = await fixture(t);
  const options = { directory, sessionId: 'session-1', provider: 'sample' };
  const publisher = createStatusPublisher({
    ...options,
    diagnostics: { async write(record) {
      if (record.event === 'status.publish.failed') assert.equal(await publisher.close(), 'cleared');
    } },
  });
  assert.equal(await publisher.publish('Visible'), 'published');
  await assert.rejects(publisher.publish(''), /Invalid status text/);
  assert.equal((await readStatusContributions(options)).records[0].value, null);
});

test('malformed and oversized records cannot pollute the renderer or leak their contents into diagnostics', async t => {
  const directory = await fixture(t);
  const sessionId = 'session-1';
  await mkdir(join(directory, sessionId));
  await writeFile(join(directory, sessionId, 'broken.json'), 'private-not-json');
  await writeFile(join(directory, sessionId, 'long.json'), 'x'.repeat(16_385));
  const observed = [];
  const result = await readStatusContributions({
    directory, sessionId, diagnostics: { debug: false, write: record => observed.push(record) },
  });
  assert.deepEqual(result, { records: [], invalidCount: 2 });
  assert.ok(observed.some(record => record.fields.code === 'ERR_STATUS_RECORD'));
  assert.ok(!JSON.stringify(observed).includes('private-not-json'));
});

test('independent processes cannot simultaneously own one active contribution', async t => {
  const directory = await fixture(t);
  const settled = await Promise.allSettled(['first', 'second'].map(text =>
    promisify(execFile)(process.execPath, [worker, directory, text], { timeout: 60_000, windowsHide: true })));
  const errors = settled.filter(result => result.status === 'rejected').map(result => result.reason);
  if (errors.length) throw new AggregateError(errors);
  assert.deepEqual(settled.map(result => result.value.stdout.trim()).sort(), ['busy', 'published']);
});

test('Windows releases the publication guard when its process exits', { skip: process.platform !== 'win32' }, async t => {
  const directory = await fixture(t);
  const child = spawn(process.execPath, [worker, directory, 'crash'], { windowsHide: true });
  const done = once(child, 'exit');
  const timeout = setTimeout(() => child.kill(), 30_000);
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.resume();
  try { assert.deepEqual(await done, [23, null]); }
  finally { clearTimeout(timeout); }
  assert.match(output, /lock-acquired/);
  const next = createStatusPublisher({ directory, sessionId: 'session-1', provider: 'sample', diagnostics: quiet });
  assert.equal(await next.publish('healthy'), 'published');
});
