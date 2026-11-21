import { randomUUID } from 'node:crypto';
import { isCancellation, isErrorCode, summarizeError } from './error-fields.mjs';

const namePattern = /^[a-z][a-z0-9._-]{0,111}$/;
const keyPattern = /^[a-z][A-Za-z0-9]{0,63}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const reserved = new Set(['operationId', 'durationMs', 'code', 'errorType']);
const count = value => Math.min(value + 1, Number.MAX_SAFE_INTEGER);

export function createOperationTracer({ submit, debug = false, codes = [], contextKeys = [] }) {
  if (typeof submit !== 'function' || typeof debug !== 'boolean' || !Array.isArray(codes)
    || !Array.from(codes).every(isErrorCode)
    || !Array.isArray(contextKeys) || contextKeys.length > 16
    || !Array.from(contextKeys).every(key => typeof key === 'string' && keyPattern.test(key) && !reserved.has(key))) {
    throw new TypeError('Invalid operation tracer options.');
  }
  const acceptedCodes = new Set(codes);
  const allowedKeys = new Set(contextKeys);
  let admissionFailures = 0;
  let submitting = false;

  function record(name, suffix, level, operationId, context, start, details) {
    // A reporter is synchronous admission only; it must not call a destination here.
    if (submitting) {
      admissionFailures = count(admissionFailures);
      return;
    }
    submitting = true;
    try {
      const duration = start === undefined ? {} : { durationMs: Math.round(performance.now() - start) };
      const submitted = submit({ timestamp: new Date().toISOString(), level, event: `${name}.${suffix}`,
        fields: { ...context, operationId, ...duration, ...details },
      });
      // An accidentally asynchronous reporter still cannot create an unhandled rejection.
      if (submitted === 0) admissionFailures = count(admissionFailures);
      else if (typeof submitted?.then === 'function') {
        Promise.resolve(submitted).catch(() => { admissionFailures = count(admissionFailures); });
      }
    } catch {
      admissionFailures = count(admissionFailures);
    } finally {
      submitting = false;
    }
  }

  return Object.freeze({
    getHealth: () => ({ admissionFailures }),
    async run(name, action, context = {}) {
      if (typeof name !== 'string' || !namePattern.test(name)) {
        admissionFailures = count(admissionFailures);
        return await action();
      }
      const values = Object.create(null);
      let operationId;
      let start;
      try {
        operationId = randomUUID();
        start = performance.now();
        for (const key of allowedKeys) {
          const value = context?.[key];
          if (Number.isFinite(value) || typeof value === 'boolean'
            || (typeof value === 'string' && idPattern.test(value))) values[key] = value;
        }
      } catch {
        admissionFailures = count(admissionFailures);
        return await action();
      }
      if (debug) record(name, 'started', 'debug', operationId, values);
      try {
        const result = await action();
        if (debug) record(name, 'completed', 'debug', operationId, values, start);
        return result;
      } catch (error) {
        const details = summarizeError(error, acceptedCodes);
        const cancelled = isCancellation(error);
        record(name, cancelled ? 'cancelled' : 'failed', cancelled ? 'warn' : 'error', operationId, values, start, details);
        throw error;
      }
    },
  });
}
