const plain = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 512
  && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value);

export function validStatusIdentity(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)
    && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(value);
}

export function statusValue(text, priority = 0) {
  if (!plain(text) || !Number.isSafeInteger(priority)) throw new TypeError('Invalid status text or priority.');
  return { text, priority };
}

export function validStatusRecord(record) {
  return record?.version === 1 && validStatusIdentity(record.sessionId)
    && validStatusIdentity(record.provider) && validStatusIdentity(record.owner)
    && Number.isSafeInteger(record.expiresAt) && record.expiresAt >= 0
    && (record.value === null || (plain(record.value?.text) && Number.isSafeInteger(record.value.priority)));
}
