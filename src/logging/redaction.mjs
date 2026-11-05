const sensitiveKeys = new Set([
  'authorization', 'password', 'token', 'accesstoken', 'refreshtoken',
  'idtoken', 'clientsecret', 'apikey', 'cookie', 'setcookie', 'privatekey',
  'credential', 'secret',
]);
const patterns = [
  [/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[redacted]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]'],
  [/(\b(?:(?:access|refresh|id)[_-]?token|client[_-]?secret|password|api[_-]?key|token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;|&]+)/gi, '$1[redacted]'],
  [/([?&](?:code|access_token|token|api_key)=)[^&\s]+/gi, '$1[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted]'],
  [/(https?:\/\/)[^/\s@]+:[^/\s@]+@/gi, '$1[redacted]@'],
];

export function redact(value) {
  const ancestors = new WeakSet();
  function visit(item, depth) {
    if (depth > 8) return '[depth limit]';
    if (typeof item === 'string') {
      for (const [pattern, replacement] of patterns) item = item.replace(pattern, replacement);
      return item.length > 8000 ? `${item.slice(0, 8000)}[truncated]` : item;
    }
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') return Number.isFinite(item) ? item : String(item);
    if (typeof item === 'bigint') return String(item);
    if (typeof item !== 'object') return `[${typeof item}]`;
    if (ancestors.has(item)) return '[circular]';
    ancestors.add(item);
    let result;
    if (item instanceof Error) {
      result = { name: visit(item.name, depth + 1), message: visit(item.message, depth + 1) };
      if (item.code !== undefined) result.code = visit(item.code, depth + 1);
      if (item.cause !== undefined) result.cause = visit(item.cause, depth + 1);
      if (item instanceof AggregateError) result.errors = visit(item.errors, depth + 1);
    } else if (Array.isArray(item)) {
      result = item.slice(0, 100).map(entry => visit(entry, depth + 1));
      if (item.length > 100) result.push('[truncated]');
    } else {
      result = Object.create(null);
      const entries = Object.entries(item);
      for (const [key, entry] of entries.slice(0, 100)) {
        result[key] = sensitiveKeys.has(key.toLowerCase().replace(/[^a-z]/g, ''))
          ? '[redacted]' : visit(entry, depth + 1);
      }
      if (entries.length > 100) result['[truncated]'] = true;
    }
    ancestors.delete(item);
    return result;
  }
  return visit(value, 0);
}
