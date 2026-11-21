import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { createOperationTracer } from 'copilot-extension-utils/diagnostics/trace';
import { createLogDelivery } from 'copilot-extension-utils/logging/delivery';
import { fixture } from './helpers.mjs';

test('start evidence reaches a destination while the traced operation is still pending', { timeout: 5000 }, async () => {
  const entered = Promise.withResolvers();
  const start = Promise.withResolvers();
  const end = Promise.withResolvers();
  const operation = Promise.withResolvers();
  const delivery = createLogDelivery({ destinations: [{
    name: 'file',
    write(record) { (record.event.endsWith('.started') ? start : end).resolve(record); },
  }] });
  const tracer = createOperationTracer({ submit: delivery.submit, debug: true, contextKeys: ['requestId'] });
  const running = tracer.run('request.send', () => {
    entered.resolve();
    return operation.promise;
  }, { requestId: 'r-1', body: 'not recorded' });
  await entered.promise;
  const started = await start.promise;
  assert.equal(started.event, 'request.send.started');
  assert.equal(started.fields.requestId, 'r-1');
  assert.equal(started.fields.body, undefined);
  const result = {};
  operation.resolve(result);
  assert.equal(await running, result);
  const completed = await end.promise;
  assert.equal(completed.event, 'request.send.completed');
  assert.equal(completed.fields.operationId, started.fields.operationId);
  assert.ok(completed.fields.durationMs >= 0);
  delivery.close();
});

test('quiet tracing preserves safe integer codes, raw error identity and cancellation', async () => {
  const records = [];
  const tracer = createOperationTracer({
    submit: record => records.push(record),
    codes: [-32603, 'EIO'],
  });
  const inner = Object.assign(new Error('private content'), { code: -32603 });
  const error = new Error('private wrapper', { cause: inner });
  const cancelled = Object.assign(new Error('private abort'), { name: 'AbortError' });
  const codedAbort = new Error('wrapped', { cause: Object.assign(new Error('private cancel'), { code: 'ABORT_ERR' }) });
  assert.equal(await tracer.run('request.send', () => 42), 42);
  await assert.rejects(tracer.run('request.send', () => { throw error; }), reason => reason === error);
  await assert.rejects(tracer.run('request.send', () => Promise.reject(cancelled)), reason => reason === cancelled);
  await assert.rejects(tracer.run('request.send', () => Promise.reject(codedAbort)), reason => reason === codedAbort);
  assert.deepEqual(records.map(record => [record.event, record.level, record.fields.code]), [
    ['request.send.failed', 'error', -32603],
    ['request.send.cancelled', 'warn', 'UNKNOWN'],
    ['request.send.cancelled', 'warn', 'UNKNOWN'],
  ]);
  assert.ok(!JSON.stringify(records).includes('private'));
});

test('aggregate cancellation requires every branch to cancel regardless of the code allowlist', async () => {
  const abort = Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' });
  const allAborted = new AggregateError([abort, new AggregateError([abort])]);
  const mixed = new AggregateError([abort, new Error('failed')], 'mixed', { cause: abort });
  const cycle = new AggregateError([abort]);
  cycle.errors.push(cycle);
  const tooWide = new AggregateError([...Array(32).fill(abort), new Error('failed')]);

  for (const codes of [[], ['ABORT_ERR']]) {
    const records = [];
    const tracer = createOperationTracer({ codes, submit: record => records.push(record) });
    for (const error of [allAborted, mixed, cycle, tooWide]) {
      await assert.rejects(tracer.run('worker.run', () => Promise.reject(error)), reason => reason === error);
    }
    assert.deepEqual(records.map(({ event, level }) => [event, level]), [
      ['worker.run.cancelled', 'warn'],
      ['worker.run.failed', 'error'],
      ['worker.run.failed', 'error'],
      ['worker.run.failed', 'error'],
    ]);
    assert.equal(records[0].fields.code, codes[0] ?? 'UNKNOWN');
  }
});

test('a malformed diagnostic error cannot replace the original rejection', async () => {
  const tracer = createOperationTracer({ submit() {} });
  const malformed = { name: 'AggregateError', errors: { length: Symbol() } };
  await assert.rejects(tracer.run('worker.run', () => Promise.reject(malformed)), error => error === malformed);
});

test('throwing admission, bad context, and closed delivery cannot change a traced result', async () => {
  const result = {};
  const failure = {};
  const tracer = createOperationTracer({
    debug: true, contextKeys: ['requestId'],
    submit() { throw new Error('reporter failed'); },
  });
  assert.equal(await tracer.run('worker.run', () => result), result);
  await assert.rejects(tracer.run('worker.run', () => Promise.reject(failure)), reason => reason === failure);
  const context = { get requestId() { throw new Error('context failed'); } };
  assert.equal(await tracer.run('worker.run', () => result, context), result);
  assert.equal(tracer.getHealth().admissionFailures, 5);

  const asynchronous = createOperationTracer({ debug: true, async submit() { throw new Error('reporter failed'); } });
  assert.equal(await asynchronous.run('worker.run', () => result), result);
  await setImmediate();
  assert.equal(asynchronous.getHealth().admissionFailures, 2);

  const delivery = createLogDelivery({ destinations: [{ name: 'file', write: () => assert.fail() }] });
  delivery.close();
  const closed = createOperationTracer({ submit: delivery.submit, debug: true });
  assert.equal(await closed.run('worker.run', () => result), result);
  assert.equal(closed.getHealth().admissionFailures, 2);
  assert.equal(delivery.getHealth().afterClose, 2);
});

test('closing delivery lets a process exit naturally while the log lock is contended', { timeout: 8000 }, async t => {
  const path = join(await fixture(t), 'debug.jsonl');
  await writeFile(`${path}.lock`, 'other writer');
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import { createLogDelivery } from 'copilot-extension-utils/logging/delivery';
    import { createRotatingFileSink } from 'copilot-extension-utils/logging/rotating-file';
    const path = ${JSON.stringify(path)};
    const delivery = createLogDelivery({
      destinations: [{ name: 'file', write: createRotatingFileSink({ path, separatePartialLine: true }) }],
    });
    const open = fs.open;
    fs.open = async (...args) => {
      try {
        return await open(...args);
      } catch (error) {
        if (args[0] === path + '.lock' && error.code === 'EEXIST') {
          setImmediate(() => {
            assert.equal(delivery.getHealth().destinations[0].active, true);
            delivery.close();
            console.log('closed');
          });
        }
        throw error;
      }
    };
    delivery.submit({ event: 'test' });
    `,
  ], { cwd: new URL('../', import.meta.url), windowsHide: true, timeout: 4000 });
  assert.equal(stdout.trim(), 'closed');
  assert.equal(await readFile(`${path}.lock`, 'utf8'), 'other writer');
  await assert.rejects(readFile(path), { code: 'ENOENT' });
});

test('a pending writer stays bounded and cannot stall another destination or close', { timeout: 5000 }, async () => {
  const hold = Promise.withResolvers();
  const seen = [];
  const received = [Promise.withResolvers(), Promise.withResolvers(), Promise.withResolvers()];
  const delivery = createLogDelivery({
    capacity: 1,
    destinations: [
      { name: 'slow', write: () => hold.promise },
      { name: 'fast', write: record => { seen.push(record.value); received[record.value - 1].resolve(); } },
    ],
  });
  try {
    const record = { value: 1 };
    assert.equal(delivery.submit(record), 2);
    record.value = 99;
    assert.deepEqual(delivery.getHealth().destinations.map(sink => sink.delivered), [0, 0]);
    await received[0].promise;
    assert.equal(delivery.submit({ value: 2 }), 2);
    await received[1].promise;
    assert.equal(delivery.submit({ value: 3 }), 1);
    await received[2].promise;
    await setImmediate();
    assert.deepEqual(seen, [1, 2, 3]);
    const [slow, fast] = delivery.getHealth().destinations;
    assert.equal(slow.active, true);
    assert.equal(slow.pending, 1);
    assert.equal(slow.overflow, 1);
    assert.equal(fast.delivered, 3);
    delivery.close();
    assert.equal(delivery.getHealth().destinations[0].discarded, 1);
    assert.equal(delivery.getHealth().destinations[0].active, true);
  } finally {
    delivery.close();
    hold.resolve();
  }
});

test('a failed write is not retried or suppressed; suppression begins only after successful delivery', { timeout: 5000 }, async () => {
  const secondWrite = Promise.withResolvers();
  const thirdWrite = Promise.withResolvers();
  const seen = [];
  const delivery = createLogDelivery({
    suppressionMs: 60_000,
    destinations: [{ name: 'file', write({ seq }) {
      seen.push(seq);
      if (seq === 1) throw new Error('append outcome unknown');
      if (seq === 2) secondWrite.resolve();
      if (seq === 4) thirdWrite.resolve();
    } }],
  });
  for (const seq of [1, 2, 3]) delivery.submit({ seq }, { suppressionKey: 'same' });
  await secondWrite.promise;
  delivery.submit({ seq: 4 }, { suppressionKey: 'different' });
  await thirdWrite.promise;
  await setImmediate();
  assert.deepEqual(seen, [1, 2, 4]);
  const [file] = delivery.getHealth().destinations;
  assert.equal(file.failed, 1);
  assert.equal(file.suppressed, 1);
  assert.equal(file.delivered, 2);
  delivery.close();
});

test('invalid record formatting and recursive delivery are counted outside the destination', { timeout: 5000 }, async () => {
  const received = Promise.withResolvers();
  const delivery = createLogDelivery({
    maxRecordBytes: 64,
    destinations: [{ name: 'file', async write() {
      await setImmediate();
      assert.equal(delivery.submit({ nested: true }), 0);
      received.resolve();
    } }],
  });
  const invalid = { toJSON() { throw new Error('formatting failed'); } };
  assert.equal(delivery.submit(invalid), 0);
  assert.equal(delivery.submit({ long: 'x'.repeat(100) }), 0);
  assert.equal(delivery.submit({ ok: true }, { get suppressionKey() { throw new Error('invalid key'); } }), 0);
  assert.equal(delivery.submit({ ok: true }), 1);
  await received.promise;
  assert.equal(delivery.getHealth().invalid, 3);
  assert.equal(delivery.getHealth().reentrant, 1);
  assert.equal(delivery.submit({ toJSON() { delivery.close(); return {}; } }), 0);
  assert.equal(delivery.getHealth().afterClose, 1);
  assert.equal(delivery.getHealth().destinations[0].pending, 0);
});

test('byte overflow is reported independently with safe original and delivery failure details', { timeout: 5000 }, async () => {
  const reports = [];
  const reported = Promise.withResolvers();
  const delivery = createLogDelivery({
    maxPendingBytes: 100,
    codes: [-32603, 'EIO'],
    destinations: [{ name: 'file', write() {
      const cause = Object.assign(new Error('private destination details'), { code: 'EIO' });
      throw Object.assign(new Error('private write details', { cause }), { deliveryOutcome: 'uncertain' });
    } }],
    onLoss(health) {
      assert.equal(delivery.submit({ event: 'recursive' }), 0);
      reports.push(health);
      if (health.destinations[0].uncertain) reported.resolve(health);
    },
  });
  const record = { fields: { code: -32603, errorType: 'ResponseError' }, body: 'private original evidence' };
  assert.equal(delivery.submit(record), 1);
  assert.equal(delivery.submit(record), 0);
  const [file] = (await reported.promise).destinations;
  assert.equal(file.overflow, 1);
  assert.equal(file.uncertain, 1);
  assert.equal(file.delivered, 0);
  assert.equal(file.pendingBytes, 0);
  assert.deepEqual(file.lastFailure, {
    outcome: 'uncertain',
    original: { code: -32603, errorType: 'ResponseError' },
    diagnostic: { code: 'EIO', errorType: 'Error' },
  });
  assert.ok(!JSON.stringify(reports).includes('private'));
  assert.equal(delivery.getHealth().lossReportFailures, 0);
  assert.ok(delivery.getHealth().reentrant >= 1);
  delivery.close();
});

test('a rejected write with confirmed bytes counts as delivered without replay', { timeout: 5000 }, async () => {
  const reported = Promise.withResolvers();
  const seen = [];
  const delivery = createLogDelivery({
    destinations: [{ name: 'file', write(record) {
      seen.push(record);
      throw Object.assign(new Error('lock cleanup failed'), { deliveryOutcome: 'written' });
    } }],
    onLoss: reported.resolve,
  });
  delivery.submit({ seq: 1 });
  const [file] = (await reported.promise).destinations;
  assert.deepEqual(seen, [{ seq: 1 }]);
  assert.equal(file.postDeliveryFailures, 1);
  assert.equal(file.delivered, 1);
  assert.equal(file.uncertain, 0);
  delivery.close();
});

for (const [reported, outcome, counter] of [
  [undefined, 'failed', 'failed'],
  ['uncertain', 'uncertain', 'uncertain'],
  ['written', 'written', 'postDeliveryFailures'],
]) {
  test(`${outcome} delivery preserves only approved context for flat and traced records`, { timeout: 5000 }, async () => {
    const context = {
      sessionId: 'session-1', requestId: 'request-2', phase: 'event', operation: 'metadata.snapshot',
      compactionEpoch: 3, recoveryPending: false,
    };
    const contextKeys = Object.keys(context);
    const expectedError = { code: -32603, errorType: 'ResponseError' };
    for (const nested of [false, true]) {
      const observed = Promise.withResolvers();
      let operationId;
      const delivery = createLogDelivery({
        codes: [-32603, 'EIO'],
        contextKeys: [...contextKeys, 'event', 'operationId', 'longId', 'invalidId', 'nestedValue'],
        destinations: [{ name: 'file', write(record) {
          operationId = nested ? record.fields.operationId : record.operationId;
          if (nested) record.fields.requestId = 'mutated';
          else record.requestId = 'mutated';
          throw Object.assign(new Error('private log error'), { code: 'EIO', deliveryOutcome: reported });
        } }],
        onLoss: observed.resolve,
      });
      const event = nested ? 'metadata.snapshot.failed' : 'bridge';
      const excluded = {
        longId: 'x'.repeat(129), invalidId: 'unsafe/path', nestedValue: { code: 'EIO' },
        body: 'rawNote', stack: 'rawStack', gateDecision: 'not-allowed',
      };
      try {
        if (nested) {
          const trace = createOperationTracer({
            codes: [-32603],
            contextKeys,
            submit(record) {
              return delivery.submit({
                ...record, requestId: 'outer-request',
                fields: { ...record.fields, ...excluded, event: 'not-the-envelope' },
              });
            },
          });
          const failure = Object.assign(new Error('private original error'), { name: 'ResponseError', code: -32603 });
          await assert.rejects(trace.run('metadata.snapshot', () => Promise.reject(failure), context),
            error => error === failure);
        } else {
          assert.equal(delivery.submit({ event, operationId: 'legacy-op', ...context, ...expectedError, ...excluded }), 1);
        }
        const [file] = (await observed.promise).destinations;
        assert.ok(operationId);
        assert.equal(file[counter], 1);
        assert.equal(file.delivered, reported === 'written' ? 1 : 0);
        assert.deepEqual(file.lastFailure, {
          outcome,
          original: { ...expectedError, ...context, event, operationId },
          diagnostic: { code: 'EIO', errorType: 'Error' },
        });
        assert.deepEqual(delivery.getHealth().destinations[0].lastFailure, file.lastFailure);
      } finally {
        delivery.close();
      }
    }
  });
}

test('delivery snapshots the bounded context keys and error codes before destinations initialize', { timeout: 5000 }, async () => {
  const contextKeys = ['requestId'];
  const codes = ['EIO'];
  const additional = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`extra${index}`, index]));
  contextKeys[Symbol.iterator] = function* () { yield 'requestId'; yield* Object.keys(additional); };
  const observed = Promise.withResolvers();
  const delivery = createLogDelivery({
    contextKeys,
    codes,
    destinations: [{
      name: 'file',
      get write() {
        contextKeys[0] = 'otherId';
        codes[0] = 'EPERM';
        return () => { throw Object.assign(new Error('file unavailable'), { code: 'EIO' }); };
      },
    }],
    onLoss: observed.resolve,
  });
  try {
    assert.equal(delivery.submit({ requestId: 'request-1', otherId: 'request-2', ...additional }), 1);
    const [file] = (await observed.promise).destinations;
    assert.deepEqual(file.lastFailure.original, { requestId: 'request-1' });
    assert.equal(file.lastFailure.diagnostic.code, 'EIO');
  } finally {
    delivery.close();
  }
});

test('the tracer uses the same validated keys and codes even if array elements change on reread', async () => {
  const contextKeys = ['requestId'];
  const codes = ['EIO'];
  let keyReads = 0;
  let codeReads = 0;
  Object.defineProperty(contextKeys, 0, { get: () => ++keyReads === 1 ? 'requestId' : 'otherId' });
  Object.defineProperty(codes, 0, { get: () => ++codeReads === 1 ? 'EIO' : 'EPERM' });
  const records = [];
  const tracer = createOperationTracer({ contextKeys, codes, debug: true, submit: record => records.push(record) });
  const failure = Object.assign(new Error('request failed'), { code: 'EIO' });
  await assert.rejects(
    tracer.run('request.send', () => { throw failure; }, { requestId: 'request-1', otherId: 'request-2' }),
    error => error === failure,
  );
  assert.deepEqual(records.map(record => record.fields.requestId), ['request-1', 'request-1']);
  assert.ok(records.every(record => !Object.hasOwn(record.fields, 'otherId')));
  assert.equal(records[1].fields.code, 'EIO');
});

test('lazy destination error fields cannot enqueue back into the same destination', { timeout: 5000 }, async () => {
  const observed = Promise.withResolvers();
  const seen = [];
  let accepted;
  const delivery = createLogDelivery({
    codes: ['EIO'],
    destinations: [{ name: 'file', write(record) {
      seen.push(record.event);
      if (record.event === 'first') {
        throw Object.defineProperty(new Error('destination failed'), 'code', {
          get() {
            accepted = delivery.submit({ event: 'feedback' });
            return 'EIO';
          },
        });
      }
    } }],
    onLoss: observed.resolve,
  });
  delivery.submit({ event: 'first' });
  const health = await observed.promise;
  assert.equal(accepted, 0);
  assert.equal(health.reentrant, 1);
  assert.equal(health.destinations[0].lastFailure.diagnostic.code, 'EIO');
  await setImmediate();
  assert.deepEqual(seen, ['first']);
  delivery.close();
});

test('a stalled loss reporter coalesces later losses without holding up delivery or close', { timeout: 5000 }, async () => {
  const hold = Promise.withResolvers();
  const firstReport = Promise.withResolvers();
  const finalReport = Promise.withResolvers();
  const delivered = Promise.withResolvers();
  const reports = [];
  const delivery = createLogDelivery({
    capacity: 1,
    destinations: [{ name: 'file', write: delivered.resolve }],
    onLoss(health) {
      reports.push(health);
      if (reports.length === 1) {
        firstReport.resolve();
        return hold.promise;
      }
      finalReport.resolve(health);
    },
  });
  try {
    assert.equal(delivery.submit(null), 0);
    await firstReport.promise;
    for (let index = 0; index < 20; index++) assert.equal(delivery.submit(null), 0);
    assert.equal(delivery.submit({ value: 1 }), 1);
    assert.deepEqual(await delivered.promise, { value: 1 });
    delivery.close();
    assert.equal(reports.length, 1);
    hold.resolve();
    // Give the unreferenced shutdown report a turn without keeping production alive.
    await setImmediate();
    await setImmediate();
    const health = await finalReport.promise;
    assert.equal(health.closed, true);
    assert.equal(health.invalid, 21);
    assert.equal(health.destinations[0].delivered, 1);
    assert.equal(reports.length, 2);
  } finally {
    delivery.close();
    hold.resolve();
  }
});
