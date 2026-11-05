import { randomUUID } from 'node:crypto';

const defaultWriter = record => console.error(JSON.stringify(record));
const safeName = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : 'UNKNOWN';

export async function observeOperation(name, options, operation) {
  const { debug = false, write = defaultWriter } = options ?? {};
  if (typeof debug !== 'boolean' || typeof write !== 'function') throw new TypeError('Invalid diagnostics configuration.');
  if (typeof name !== 'string' || !/^[a-z][a-z0-9._-]{0,127}$/.test(name) || typeof operation !== 'function') {
    throw new TypeError('Provide a static operation identifier and an operation function.');
  }
  const operationId = randomUUID();
  const start = performance.now();
  const pending = [];
  let changed;
  const sanitize = fields => {
    const result = {};
    for (const key of ['attempts', 'durationMs']) {
      if (Number.isFinite(fields[key])) result[key] = fields[key];
    }
    if (typeof fields.changed === 'boolean') result.changed = fields.changed;
    for (const key of ['code', 'errorType']) {
      if (fields[key] !== undefined) result[key] = safeName(fields[key]);
    }
    return result;
  };
  async function emit(level, suffix, fields = {}) {
    if (level === 'debug' && !debug) return;
    const record = {
      timestamp: new Date().toISOString(), level, event: `${name}.${suffix}`,
      fields: { operationId, ...sanitize(fields) },
    };
    try {
      await write(record);
    } catch (error) {
      try {
        defaultWriter({
          timestamp: new Date().toISOString(), level: 'error', event: 'diagnostics.delivery_failed',
          fields: { operationId, code: safeName(error?.code), errorType: safeName(error?.name) },
        });
      } catch (fallbackError) {
        throw new AggregateError([error, fallbackError], 'Diagnostic destination and fallback both failed.');
      }
    }
  }
  await emit('debug', 'started');
  function trace(event, fields = {}) {
    if (typeof event !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(event)) {
      throw new TypeError('Trace event must be a static identifier.');
    }
    if (typeof fields.changed === 'boolean') changed = fields.changed;
    if (debug && pending.length < 64) pending.push({ event, fields: sanitize(fields) });
  }
  async function flush() {
    for (const entry of pending) await emit('debug', entry.event, entry.fields);
  }
  let result;
  try {
    result = await operation(trace);
  } catch (error) {
    try {
      await flush();
      await emit(error?.name === 'AbortError' ? 'warn' : 'error', 'failed', {
        durationMs: Math.round(performance.now() - start),
        code: safeName(error?.code), errorType: safeName(error?.name), changed,
      });
    } catch (diagnosticsError) {
      const combined = new AggregateError([error, diagnosticsError], 'Operation and diagnostic delivery both failed.');
      if (error?.code === 'ERR_DIAGNOSTICS_AFTER_SUCCESS' && error.operationCompleted === true) {
        Object.assign(combined, { code: error.code, operationCompleted: true });
      }
      throw combined;
    }
    throw error;
  }
  try {
    await flush();
    await emit('debug', 'completed', { durationMs: Math.round(performance.now() - start), changed });
  } catch (error) {
    throw Object.assign(new Error('Operation completed, but diagnostic delivery failed.', { cause: error }), {
      code: 'ERR_DIAGNOSTICS_AFTER_SUCCESS', operationCompleted: true,
    });
  }
  return result;
}
