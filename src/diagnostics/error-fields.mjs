const errorTypes = new Set([
  'Error', 'TypeError', 'SyntaxError', 'RangeError', 'ReferenceError', 'ResponseError', 'AbortError', 'AggregateError',
]);

export const isErrorCode = code => Number.isSafeInteger(code)
  || (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code));

export function errorField(object, key) {
  try { return object?.[key]; } catch { return undefined; }
}

export function isCancellation(error) {
  for (let depth = 0, cause = error; depth < 8 && cause != null; depth++, cause = errorField(cause, 'cause')) {
    if (errorField(cause, 'name') === 'AbortError' || errorField(cause, 'code') === 'ABORT_ERR') return true;
  }
  return false;
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
