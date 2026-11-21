import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { defineSlashCommand } from 'copilot-extension-utils/commands/slash';
import { createCleanupScope } from 'copilot-extension-utils/lifecycle/cleanup';
import { createSessionNotifier } from 'copilot-extension-utils/notifications/session';
import { resolveScopedSettings } from 'copilot-extension-utils/settings/scope';

const quiet = { write() {} };
const notice = { prompt: 'Trusted static request', displayPrompt: 'Request queued' };

test('settings resolve per key with explicit session precedence and no loss of false or null values', () => {
  const result = resolveScopedSettings({
    defaults: { enabled: true, limit: 5 }, global: { limit: 10, label: 'global' },
    session: { enabled: false, label: null },
  });
  assert.deepEqual({ ...result.value }, { enabled: false, limit: 10, label: null });
  assert.deepEqual({ ...result.sources }, { enabled: 'session', limit: 'global', label: 'session' });
  assert.throws(() => resolveScopedSettings({ global: JSON.parse('{"__proto__":true}') }), /Invalid/);
});

test('native slash handler enforces ownership, typed usage, menu cancellation and input validation', async () => {
  const output = [];
  const session = { sessionId: 'session-1', log: line => output.push(line), capabilities: {} };
  let selection = null;
  const command = defineSlashCommand({
    name: 'sample', getSession: () => session, usage: '/sample greet',
    menu: () => selection, parse: args => args === 'greet' ? args : null,
    execute: value => output.push(value), diagnostics: quiet,
  });
  await assert.rejects(command.handler({ sessionId: 'foreign', args: 'greet' }), { code: 'ERR_COMMAND_OWNER' });
  const invoke = args => command.handler({ sessionId: session.sessionId, args });
  await invoke('');
  await invoke('bad');
  await invoke('--help');
  await invoke('greet');
  session.capabilities = { ui: { elicitation: true } };
  session.ui = {};
  await invoke('');
  selection = 'greet';
  await invoke('');
  assert.deepEqual(output, ['/sample greet', '/sample greet', '/sample greet', 'greet', 'greet']);
});

test('cleanup runs every handler once despite failures and shares its close result', async () => {
  const order = [];
  const failure = new Error('cleanup failed');
  const scope = createCleanupScope({ diagnostics: quiet });
  scope.defer(() => order.push('first'));
  scope.defer(() => { order.push('second'); throw failure; });
  const closing = scope.close();
  assert.equal(scope.close(), closing);
  assert.throws(() => scope.defer(() => {}), TypeError);
  await assert.rejects(closing, error => error instanceof AggregateError && error.errors[0] === failure);
  assert.deepEqual(order, ['second', 'first']);
});

test('a notification shares the pending send, verifies acceptance and drains on disposal', async () => {
  const sent = [];
  const { promise, resolve } = Promise.withResolvers();
  const notifier = createSessionNotifier({ session: { send: input => { sent.push(input); return promise; } } });
  const first = notifier.notify('one', notice);
  assert.equal(notifier.notify('one', notice), first);
  const disposing = notifier.dispose();
  assert.equal(notifier.dispose(), disposing);
  assert.deepEqual(await notifier.notify('two', notice), { status: 'disposed' });
  resolve('message-1');
  assert.deepEqual(await first, { status: 'accepted', messageId: 'message-1' });
  await disposing;
  assert.deepEqual(sent, [{ ...notice, source: 'system', mode: 'enqueue' }]);
});

test('host callbacks see an already tracked send and disposal waits for its acceptance', async () => {
  const acceptance = Promise.withResolvers();
  let reentrant;
  let disposing;
  let drained = false;
  let sends = 0;
  const notifier = createSessionNotifier({ session: { send() {
    if (++sends === 1) {
      reentrant = notifier.notify('one', notice);
      disposing = notifier.dispose().then(() => { drained = true; });
    }
    return acceptance.promise;
  } } });
  const first = notifier.notify('one', notice);
  try {
    await setImmediate();
    assert.equal(reentrant, first);
    assert.equal(sends, 1);
    assert.equal(drained, false);
  } finally {
    acceptance.resolve('message-1');
  }
  await disposing;
  assert.equal(drained, true);
  assert.equal((await first).messageId, 'message-1');
});

test('an unacknowledged send is explicit, never automatically retried, and accepted keys are deduplicated', async () => {
  let sends = 0;
  const notifier = createSessionNotifier({
    session: { send: () => ++sends === 1 ? undefined : 'message-2' },
    diagnostics: quiet,
  });

  await assert.rejects(notifier.notify('one', notice), { code: 'ERR_NOTICE_UNCERTAIN' });
  await setImmediate();
  assert.equal(sends, 1);
  assert.deepEqual(await notifier.notify('one', notice), { status: 'accepted', messageId: 'message-2' });
  assert.deepEqual(await notifier.notify('one', notice), { status: 'already-accepted', messageId: 'message-2' });
  assert.equal(sends, 2);
});

test('a diagnostic writer can await notifier disposal after host acceptance', { timeout: 5000 }, async () => {
  let drained = false;
  const notifier = createSessionNotifier({
    session: { send: () => 'message-1' },
    diagnostics: {
      debug: true,
      async write(record) {
        if (record.event === 'notification.enqueue.accepted') {
          await notifier.dispose();
          drained = true;
        }
      },
    },
  });
  assert.deepEqual(await notifier.notify('one', notice), { status: 'accepted', messageId: 'message-1' });
  assert.equal(drained, true);
  assert.deepEqual(await notifier.notify('two', notice), { status: 'disposed' });
});
