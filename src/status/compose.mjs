import { validStatusIdentity, validStatusRecord } from './record.mjs';

export function composeStatusLine(base, records, { sessionId, now = Date.now(), maxContributions = 4 } = {}) {
  if (typeof base !== 'string' || !Array.isArray(records) || !validStatusIdentity(sessionId)
    || !Number.isSafeInteger(now) || !Number.isSafeInteger(maxContributions) || maxContributions < 0) {
    throw new TypeError('Invalid status composition options.');
  }
  const active = new Map();
  for (const record of records) {
    if (!validStatusRecord(record) || record.sessionId !== sessionId || record.expiresAt <= now || record.value === null) continue;
    const previous = active.get(record.provider);
    if (!previous || previous.expiresAt < record.expiresAt) active.set(record.provider, record);
  }
  const formatted = [...active.values()].sort((a, b) => b.value.priority - a.value.priority
    || (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0))
    .slice(0, maxContributions).map(record => record.value.text);
  return formatted.length ? [...(base ? [base] : []), ...formatted].join(' | ') : base;
}
