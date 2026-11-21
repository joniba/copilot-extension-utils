const keyPattern = /^[a-z][A-Za-z0-9]{0,63}$/;
const labelPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function validContextKeys(keys, reserved) {
  return Array.isArray(keys) && keys.length <= 16
    && Array.from(keys).every(key => typeof key === 'string' && keyPattern.test(key) && !reserved.has(key));
}

export function isContextValue(value) {
  return Number.isFinite(value) || typeof value === 'boolean'
    || (typeof value === 'string' && labelPattern.test(value));
}
