import { observeOperation } from '../diagnostics/operation.mjs';

export function createSessionNotifier({ session, maxKeys = 64, diagnostics }) {
  if (typeof session?.send !== 'function' || !Number.isSafeInteger(maxKeys) || maxKeys < 1 || maxKeys > 1024) {
    throw new TypeError('Invalid notification options.');
  }
  const pending = new Map();
  const accepted = new Map();
  let disposed;
  return Object.freeze({
    notify(key, { prompt, displayPrompt } = {}) {
      if (disposed) return Promise.resolve({ status: 'disposed' });
      if (typeof key !== 'string' || !key || key.length > 128 || typeof prompt !== 'string' || !prompt.trim()
        || typeof displayPrompt !== 'string' || !displayPrompt.trim()) {
        return Promise.reject(new TypeError('Provide a short key and trusted prompt and display text.'));
      }
      if (pending.has(key)) return pending.get(key).result;
      if (accepted.has(key)) return Promise.resolve({ status: 'already-accepted', messageId: accepted.get(key) });
      if (pending.size >= maxKeys) return Promise.reject(new RangeError('Too many pending notification keys.'));
      const entry = {};
      entry.result = observeOperation('notification.enqueue', diagnostics, async trace => {
        // Register the work before the host can call back into this notifier.
        entry.work = Promise.resolve().then(async () => {
          let messageId;
          try {
            messageId = await session.send({ prompt, displayPrompt, source: 'system', mode: 'enqueue' });
            if (typeof messageId !== 'string' || !messageId.trim()) throw new Error('Missing acceptance ID.');
          } catch (cause) {
            throw Object.assign(new Error('Session notification acceptance is unknown.', { cause }), { code: 'ERR_NOTICE_UNCERTAIN' });
          }
          accepted.set(key, messageId);
          if (accepted.size > maxKeys) accepted.delete(accepted.keys().next().value);
          return { status: 'accepted', messageId };
        });
        const result = await entry.work;
        trace('accepted', { changed: true });
        return result;
      }).finally(() => pending.delete(key));
      pending.set(key, entry);
      return entry.result;
    },
    dispose() {
      return disposed ??= Promise.allSettled(Array.from(pending.values(), entry => entry.work)).then(() => {});
    },
  });
}
