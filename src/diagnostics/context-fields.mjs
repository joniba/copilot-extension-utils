const keyPattern = /^[a-z][A-Za-z0-9]{0,63}$/;
const labelPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function snapshotContextKeys(keys, reserved) {
  if (!Array.isArray(keys)) return null;
  const length = keys.length;
  if (!Number.isSafeInteger(length) || length < 0 || length > 16) return null;
  const snapshot = new Set();
  for (let index = 0; index < length; index++) {
    const key = keys[index];
    if (typeof key !== 'string' || !keyPattern.test(key) || reserved.has(key)) return null;
    snapshot.add(key);
  }
  return snapshot;
}

export function isContextValue(value) {
  return Number.isFinite(value) || typeof value === 'boolean'
    || (typeof value === 'string' && labelPattern.test(value));
}
