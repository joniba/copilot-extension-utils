const errorTypes = new Set([
  'Error', 'TypeError', 'SyntaxError', 'RangeError', 'ReferenceError', 'ResponseError', 'AbortError', 'AggregateError',
]);

export const isErrorCode = code => Number.isSafeInteger(code)
  || (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code));

export function errorField(object, key) {
  try { return object?.[key]; } catch { return undefined; }
}

export function isCancellation(error) {
  let remaining = 32;
  function cancelled(cause, depth) {
    if (cause == null || depth >= 8 || remaining-- <= 0) return false;
    const name = errorField(cause, 'name');
    if (name === 'AggregateError') {
      const children = errorField(cause, 'errors');
      const length = errorField(children, 'length');
      // A partial inspection cannot establish that every branch cancelled.
      if (!Number.isSafeInteger(length) || length < 1 || length > remaining) return false;
      for (let index = 0; index < length; index++) {
        if (!cancelled(errorField(children, index), depth + 1)) return false;
      }
      return true;
    }
    if (name === 'AbortError' || errorField(cause, 'code') === 'ABORT_ERR') return true;
    return cancelled(errorField(cause, 'cause'), depth + 1);
  }
  return cancelled(error, 0);
}

export function summarizeError(error, codes) {
  const type = errorField(error, 'name');
  let code = 'UNKNOWN';
  const pending = [error];
  const seen = new Set();
  for (let index = 0; index < 8 && index < pending.length; index++) {
    const cause = pending[index];
    if (cause == null || seen.has(cause)) continue;
    seen.add(cause);
    const candidate = errorField(cause, 'code');
    if (codes.has(candidate)) {
      code = candidate;
      break;
    }
    pending.push(errorField(cause, 'cause'));
    if (errorField(cause, 'name') === 'AggregateError') {
      const errors = errorField(cause, 'errors');
      const length = errorField(errors, 'length');
      if (Number.isSafeInteger(length)) {
        for (let child = 0; child < 3 && child < length; child++) pending.push(errorField(errors, child));
      }
    }
  }
  return { code, errorType: errorTypes.has(type) ? type : 'UNKNOWN' };
}

export function safeRecordedError(record, codes) {
  const code = errorField(record, 'code');
  const errorType = errorField(record, 'errorType');
  if (!codes.has(code) && !errorTypes.has(errorType)) return undefined;
  return { code: codes.has(code) ? code : 'UNKNOWN', errorType: errorTypes.has(errorType) ? errorType : 'UNKNOWN' };
}
