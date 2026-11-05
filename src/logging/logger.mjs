import { redact } from './redaction.mjs';

const levels = new Set(['debug', 'info', 'warn', 'error']);

export function createLogger({ sinks, fields, now = () => new Date(), debug = false }) {
  if (!Array.isArray(sinks) || sinks.length === 0 || sinks.some(sink => typeof sink !== 'function')) {
    throw new TypeError('Provide at least one log sink function.');
  }
  if (!Array.isArray(fields) || fields.some(field => typeof field !== 'string')) {
    throw new TypeError('Provide an explicit log-field allowlist.');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function.');
  if (typeof debug !== 'boolean') throw new TypeError('debug must be boolean.');
  const destinations = [...sinks];
  const allowed = new Set(fields);
  return Object.freeze({
    async record(level, event, metadata = {}) {
      if (!levels.has(level) || typeof event !== 'string' || !/^[a-z][a-z0-9._-]{0,127}$/.test(event)) {
        throw new TypeError('Use a supported log level and a static event identifier.');
      }
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new TypeError('Log metadata must be an object.');
      }
      if (level === 'debug' && !debug) return null;
      const record = Object.freeze({
        timestamp: now().toISOString(),
        level,
        event,
        fields: redact(Object.fromEntries(Object.entries(metadata).filter(([key]) => allowed.has(key)))),
      });
      const outcomes = await Promise.allSettled(destinations.map(sink => Promise.resolve().then(() => sink(record))));
      const errors = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason);
      if (errors.length) throw new AggregateError(errors, 'One or more log sinks failed.');
      return record;
    },
  });
}
