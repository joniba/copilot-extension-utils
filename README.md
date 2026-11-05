# copilot-extension-utils

Small ESM utilities with one responsibility per module. Import only the capability
you need; there is deliberately no root barrel, extension framework, SDK dependency,
global service, import-time filesystem access, or background timer.

Node.js 22 or later is required. The first milestone provides the foundations;
consumer integrations and later capabilities are tracked separately.

## Independent entry points

| Import suffix | Responsibility | Dependencies within this package |
| --- | --- | --- |
| `/diagnostics/operation` | Operation outcomes and opt-in metadata-only debug traces | None |
| `/logging/redaction` | Bounded, recursive credential-pattern redaction | None |
| `/logging/logger` | Allowlisted structured records and injected sinks | Redaction |
| `/logging/rotating-file` | Size-bounded JSON-lines output and rotation | File lock |
| `/files/lock` | Exclusive, ownership-checked cooperative file locking | Operation diagnostics |
| `/files/atomic` | Guarded, atomic single-file text updates | File lock, operation diagnostics |
| `/settings/jsonc` | Pure, surgical JSONC object-property edits | None |
| `/settings/store` | Validated settings updates under the file guard | Atomic updates, JSONC edits, operation diagnostics |

Only the JSONC module uses the pinned `jsonc-parser` dependency. Logging does not
load settings; pure settings editing does not load logging or filesystem code.
Application-specific policy and configuration schemas stay in the consumer.
The milestone and review gates are documented in PLAN.md.

## Logging

```js
import { createLogger } from 'copilot-extension-utils/logging/logger';
import { createRotatingFileSink } from 'copilot-extension-utils/logging/rotating-file';

const logger = createLogger({
  fields: ['elapsedMs', 'error'],
  sinks: [createRotatingFileSink({ path: absoluteLogPath })],
});
await logger.record('warn', 'worker.failed', { elapsedMs: 25, error });
```

An explicit field allowlist excludes unapproved payloads before delivery. Event
names are static identifiers, not message content. Redaction handles recognized
credential keys/patterns, errors, cycles, and bounded strings/collections; it is not
a guarantee of anonymization or arbitrary secret detection. Avoid logging bodies,
policies, or other sensitive material even when fields are allowlisted.

Inject additional sinks for timeline or host logging. All sinks are attempted;
any failure rejects with an `AggregateError`. The caller must handle and surface
that failure. There is no recursive fallback logger or silently swallowed error.
Sinks receive sanitized records; the file sink is a transport and does not
independently redact records passed directly to it.
Debug records are disabled by default; pass `debug: true` to `createLogger` to
enable them. A disabled debug record returns `null` without invoking destinations.

File output defaults to 2 MiB per file and three backups. Oversized records reject
before writing. Successful calls close the file, permitting subsequent rotation
on systems with restrictive file sharing. Separate writers use the same lock.
Each sink queues its calls in order instead of polling its own lock concurrently.
A failed write rejects its caller without preventing subsequent queued writes.
The caller owns the log path, its numbered backups, and its `.lock` path.

## Files and settings

```js
import { updateSettings } from 'copilot-extension-utils/settings/store';

await updateSettings(absoluteSettingsPath, [
  { path: ['preferences', 'enabled'], value: true },
], {
  validate(value) {
    if (typeof value.preferences.enabled !== 'boolean') {
      throw new TypeError('enabled must be boolean');
    }
  },
});
```

All filesystem paths must be absolute, with an existing parent directory.
`updateTextFile(path, updater, options)` passes the existing UTF-8 text or `null`
for a missing file. The updater must return text. Identical text is not rewritten.
An optional `expectedText` rejects a stale view; `null` specifically expects
absence. An optional `lockPath` coordinates callers that need a shared wider lock.
Return values are `{ changed, text }`.

The guard takes a snapshot under the lock, runs the updater, checks for intervening
edits, writes and flushes an exclusive same-directory temporary file, rechecks the
snapshot, then renames. A failed replacement retains temporary-file evidence and
reports its path. This is atomic visibility for one file, not whole-install
rollback, filesystem crash durability, or a compare-and-swap against writers that
ignore the lock. A non-cooperating writer can still race the final check/rename.
Regular target files are required; symlinks are refused. Existing POSIX permission
bits are preserved. Use trusted local parent directories. Windows ACLs and other
extended metadata are not copied.

`withFileLock(path, operation, { timeoutMs, retryMs, signal })` waits up to five
seconds by default. Aborting cancels acquisition, not an already-running operation.
Windows access-denied acquisition errors are retried within that same deadline;
persistent failures retain the original error as their cause. Release verifies
ownership. Existing, stale, malformed, or foreign locks are never
automatically removed. A crash can therefore require explicit owner recovery.
Operation and release failures are both preserved in an aggregate error.

JSONC edits retain comments, BOM, line-ending style and unrelated properties.
Malformed documents and duplicate properties reject rather than silently reset.
Paths address object properties, not array positions or prototype-related keys.
Values must be finite JSON data; scalar parents are never implicitly replaced.
`patchSettings(text, edits)` returns `{ text, value }` without performing I/O.
`parseSettings(text)` validates and reads an object. Parsed objects have null
prototypes, as provided by the parser; use property access or `Object.hasOwn`.

## Built-in operation diagnostics

Locking, atomic updates and settings persistence report failures as structured
stderr records by default. Successful operations are quiet. Enable debug traces or
inject an extension-owned destination through the same options object:

```js
await updateSettings(absoluteSettingsPath, [
  { path: ['preferences', 'enabled'], value: true },
], {
  diagnostics: {
    debug: true,
    write: record => logger.record(record.level, record.event, record.fields),
  },
});
```

For that adapter, configure the logger with `debug: true` and allowlist the fields
`operationId`, `durationMs`, `attempts`, `changed`, `code` and `errorType`.
Set `diagnostics.debug: false` to disable traces without disabling failure records.
Built-in records exclude paths, text, settings values and raw error messages.
Trace delivery is deferred until the operation releases its resources, so a
destination cannot hold the same lock recursively. Writers are awaited; consumers
must supply a destination that completes.

Destination failures are reported through a direct stderr fallback, not recursively
through the logger. An operation failure retains its original exception; if even
fallback delivery throws, both failures are preserved. If delivery fails after an
operation succeeds, `ERR_DIAGNOSTICS_AFTER_SUCCESS` and `operationCompleted: true`
prevent that outcome being described as a failed write. Do not retry such a write
blindly. A failure record can include `changed: true` if replacement committed
before a later cleanup failure.

Pure redaction and JSONC transformations do not log themselves: their typed errors
are recorded at the operation boundary. Logging transports do not recursively log
their own output. These boundaries avoid coupling pure functions to logging and
avoid logging loops.

This milestone does not define global/session precedence, backups, installation
transactions, status-line composition, command policies, or consumer deployment.

## Validation

From a checkout, run `npm ci --ignore-scripts`, then `npm test`. Tests include real independent
processes contending for a file, JSONC preservation, sink failures, rotation,
ownership changes, and dependency-isolated imports.
Success means a zero exit status and no failed tests. Adverse-path tests deliberately
emit error-level diagnostic records; those records alone do not indicate a failed suite.
