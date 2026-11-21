function entries(scope) {
  if (scope === null || typeof scope !== 'object'
    || ![null, Object.prototype].includes(Object.getPrototypeOf(scope))) {
    throw new TypeError('Provide each settings scope as a plain object.');
  }
  return Object.entries(scope);
}

export function resolveScopedSettings({ defaults = {}, global = {}, session = {} } = {}) {
  const value = Object.create(null);
  const sources = Object.create(null);
  for (const [source, scope] of [['default', defaults], ['global', global], ['session', session]]) {
    for (const [key, setting] of entries(scope)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key) || setting === undefined) {
        throw new TypeError('Invalid scoped settings key or value; omit unset keys.');
      }
      value[key] = setting;
      sources[key] = source;
    }
  }
  return { value, sources };
}
