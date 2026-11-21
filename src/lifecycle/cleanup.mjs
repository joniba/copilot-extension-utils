import { observeOperation } from '../diagnostics/operation.mjs';

export function createCleanupScope({ diagnostics } = {}) {
  const actions = [];
  let closed;
  return Object.freeze({
    defer(action) {
      if (typeof action !== 'function' || closed) throw new TypeError('Provide cleanup before the scope closes.');
      actions.push(action);
    },
    close() {
      return closed ??= Promise.resolve().then(() => observeOperation('lifecycle.close', diagnostics, async trace => {
        const errors = [];
        const count = actions.length;
        while (actions.length) {
          try { await actions.pop()(); }
          catch (error) { errors.push(error); }
        }
        trace('drained', { attempts: count });
        if (errors.length) throw new AggregateError(errors, 'One or more cleanup actions failed.');
      }));
    },
  });
}
