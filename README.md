# copilot-extension-utils

Small ESM utilities with one responsibility per module. Import only the capability
you need; there is deliberately no root barrel, extension framework, SDK dependency,
global service, import-time filesystem access, or background timer.

Node.js 22 or later is required. Use these helpers in new extensions; using one
does not require migrating an existing extension. See the plan for review gates.

## Use in your own extension

```text
Pin a reviewed revision -> bundle the installer's dependencies -> install the runtime files
                           npm runs this package's bin             Copilot loads this copy later
```

There is no npm registry release. Pack a checkout at a reviewed full commit
SHA (`npm pack`) and use the resulting tarball as the dependency. In PowerShell,
set `$utilsTarball` to its absolute path, then run this in your extension package:

```powershell
npm install --save-exact $utilsTarball
```

Keep that tarball available to reproducible builds (or package from the same
full commit again), and retain the dependency lockfile. Import only the subpath
you use, for example:

```js
import { defineSlashCommand } from 'copilot-extension-utils/commands/slash';
```

The starter's package manifest exposes `install.mjs` through `bin` and lists
`copilot-extension-utils` in `bundleDependencies`, so the packaged installer can
resolve it. The installed runtime is a separate copy: the starter deploys
`extension.mjs`, `command.mjs`, and the command helper with its diagnostics
dependency under `lib`. In the deployed `command.mjs`, the starter imports
the installed file rather than the package:

```js
import { defineSlashCommand } from './lib/commands/slash.mjs';
```

Keep the copied modules' relative dependency paths intact, or bundle the
needed runtime code at build time. Do not rely on the npm cache or your
checkout to be present when Copilot starts the extension.

## Independent entry points

| Import suffix | Responsibility | Dependencies within this package |
| --- | --- | --- |
| `/diagnostics/operation` | Operation outcomes and opt-in metadata-only debug traces | None |
| `/diagnostics/trace` | Record evidence around already-awaited operations without waiting for delivery | Internal context and error-field validation |
| `/logging/redaction` | Bounded, recursive credential-pattern redaction | None |
| `/logging/logger` | Allowlisted structured records and injected sinks | Redaction |
| `/logging/delivery` | Independently bounded delivery queues and destination health | Internal context and error-field validation |
| `/logging/rotating-file` | Size-bounded JSON-lines output and rotation | File lock |
| `/files/lock` | Exclusive, ownership-checked cooperative file locking | Operation diagnostics |
| `/files/atomic` | Guarded, atomic single-file text updates | File lock, operation diagnostics |
| `/settings/jsonc` | Pure, surgical JSONC object-property edits | None |
| `/settings/store` | Validated settings updates under the file guard | Atomic updates, JSONC edits, operation diagnostics |
| `/settings/scope` | Explicit defaults, global and session precedence | None |
| `/install/npx` | Package binary argument handling and installer/doctor dispatch | Operation diagnostics |
| `/install/progress` | Named installation stage output | None |
| `/install/managed-files` | Plan, back up, apply and verify scoped UTF-8 files | Atomic updates, operation diagnostics |
| `/install/run` | Sequence installation and commit the installed version receipt | Atomic updates, file lock, operation diagnostics |
| `/status/compose` | Preserve base text and append active session contributions | Internal status record schema |
| `/status/contributions` | Publish and read expiring provider records | Atomic updates, operation diagnostics, internal status lock and schema |
| `/commands/slash` | Build native command definitions with typed and menu input | Operation diagnostics |
| `/lifecycle/cleanup` | Drain independent cleanup actions once | Operation diagnostics |
| `/notifications/session` | Queue and deduplicate owning-session notifications | Operation diagnostics |

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

### Diagnostics that do not wait for log delivery

```js
import { createOperationTracer } from 'copilot-extension-utils/diagnostics/trace';
import { createLogDelivery } from 'copilot-extension-utils/logging/delivery';

const delivery = createLogDelivery({
  destinations: [{ name: 'file', write: fileSink }, { name: 'host', write: hostSink }],
  codes: ['EIO', 'ETIMEDOUT', -32603],
  contextKeys: ['event', 'operationId', 'requestId'],
  onLoss: health => console.error(JSON.stringify({ event: 'log.delivery_loss', health })),
});
const trace = createOperationTracer({
  submit: delivery.submit,
  debug: true,
  contextKeys: ['requestId'],
  codes: ['ETIMEDOUT', -32603],
});

const result = await trace.run('request.send', () => sendRequest(), { requestId });
```

The tracer is for operations the extension already awaits. Debug-enabled starts
are submitted before calling the operation; completion and elapsed time follow
when it settles. Errors and aborts remain observable with debug off. The caller
gets the original value or thrown/rejected value. Only selected scalar context
fields and allowlisted string or integer codes are included. Do not whitelist
payloads, secrets, paths, or other sensitive data.

Supply a synchronous admission function to the tracer, not a sink. Delivery
accepts already-sanitized JSON records, copies them at admission, and reports the
number of destinations that queued them. Each destination processes its own
queue with one active write. The default bounds are 64 waiting records,
16 KiB per encoded record, and 1 MiB of encoded records waiting per destination.
An asynchronously stalled writer doesn't delay other destinations. These queues
cannot isolate a callback that blocks the JavaScript thread synchronously.
Delivery reports sink completion, not power-loss durability. To suppress
duplicates, configure `suppressionMs` and pass a stable
`{ suppressionKey }` to `submit`. Suppression applies only after that
destination acknowledges a preceding record with the same key; failed writes are
not retried. Include any distinctions that must not be suppressed in the key.

`trace.getHealth()` reports admission failures, including an explicit zero
from the admission function. `delivery.getHealth()` reports
admissions, completed writes, suppression, overflow, failed or uncertain writes,
errors after a confirmed write, and discarded records separately. It retains
only the most recent safe failure summary per destination. `codes` adds
approved string and integer error codes to that summary. `contextKeys` opts
in to retaining up to 16 explicitly named fields in `lastFailure.original`.
For flat records, fields come from the record; for nested records, `fields`
takes precedence except for an outer `event`. Only bounded label strings,
finite numbers, and booleans are included. Opt in only to caller-sanitized
identifiers or other safe context, never raw payloads or errors. Optional `onLoss`
receives coalesced snapshots outside the operation and sink paths. Use an
independent destination such as stderr, not a sink on the same queue. A stalled
loss reporter holds at most one active callback and one pending notification.
`delivery.close()` discards queued records, refuses new ones, and does not wait
for writes already in flight or for the loss reporter. The optional rotator's
lock retry timer does not keep the process alive; an open, already-started
file write still gets its ordinary cleanup. Delivery cannot cancel work inside
a caller-supplied destination.

For recoverable JSON-lines files, pass `separatePartialLine: true` to
`createRotatingFileSink`. A later append starts on a new line without removing
an uncertain tail, or rotates first if the record and separator do not fit.
Readers should parse lines independently and report malformed ones. The sink
reports failure before append, uncertain append, and failure after confirmed
append separately; it does not retry or change normal retention.

This is an opt-in alternative; existing `observeOperation` and `createLogger`
still await their configured destinations.

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
Return the exported `keepText` sentinel to leave a file untouched even when it
doesn't exist. `readTextFile(path, { maxBytes })` reads a regular UTF-8 file
without locking or writing, returning `null` for absence. Both operations accept
an optional byte limit. An advanced `guard` can replace the default file lock
if it provides mutual exclusion and awaits the action through release. If
release fails after replacement, the error carries `fileCommitted: true`.

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

`resolveScopedSettings({ defaults, global, session })` returns `{ value, sources }`
with per-key session > global > default precedence. It is shallow: a present
key overrides the whole value, including `false` and `null`. Omit unset keys.
Validate values and decide where each scope is stored in the extension.

## Install a new extension

An extension exposes its own `package.json` `bin`. `runInstallerCli(argv, options)`
parses `--help`, `--version`, `--update`, `--doctor`, and `--copilot-home`. The
installer receives `{ copilotHome, update }`; doctor must return `{ ok: true }`
to succeed. The utility neither downloads packages itself nor changes host
settings, runs a shell, or triggers a reload.

```text
npm prepares and launches the binary -> installer writes and verifies files -> version receipt
from the local tarball in the sample    in the selected Copilot home            written last
```

`runInstallation({ receiptPath, version, preflight, prepare, activate, verify,
progress })` locks by receipt path, calls the hooks in order, then publishes
`{ "version": "..." }` atomically. A failed hook before receipt publication
(including `verify` returning `false`) does not advance the receipt. It can
still leave changed files if activation started. Later failures can occur after
the receipt was written; inspect `activation` and `receipt` before retrying.
Use a new version for each shipped code revision.
Progress is emitted at stage boundaries; this code runs only after npm acquires
and starts the binary. A progress sink failure is reported as a warning and
counted without invalidating a successful installation. Progress sinks and
hooks must settle and must not reenter an active install.

`planManagedFiles({ root, files: [{ path, text }], update })` uses an explicit
allowlist under a trusted, canonical root with existing directories, rejecting
changed files unless update is explicit. The planner uses the filesystem to
resolve filename aliases and checks the resolved location and duplicate entries.
Pass the resulting plan to
`backupManagedFiles(plan, backupParent)`, `applyManagedFiles(plan)` and
`verifyManagedFiles(plan)`. Backups retain exact UTF-8 bytes and are verified
before activation in the starter; use the same plan and outer install guard for
all stages. These helpers neither infer managed files nor delete old ones.
Installation is **not a multi-file transaction**. The runner exposes `stage`,
`activation` and `receipt` on failure, and managed-file failures expose known
`changed` paths and the last `attemptedPath`. Inspect actual files before retrying.
Use install and backup directories with appropriate access restrictions.
On Windows, replacement files and backups inherit directory permissions;
file-specific access rules are not preserved. Doctor verifies installed content,
not Windows permissions.

### Try the starter: build from a checkout, then install in isolation

Prerequisites: a checkout of this repository, Node.js 22+, npm, PowerShell
7.4+, and access to your configured npm registry during the build. Start from
the checkout root. The build copies the required files into a temporary directory
and uses a separate npm cache there. It leaves the starting checkout, default
npm cache and normal Copilot home untouched.

**Build the sample tarball:**

```powershell
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$source = (Get-Location).Path
$scratch = Join-Path ([IO.Path]::GetTempPath()) ("extension-utils-demo-" + [guid]::NewGuid())
$build = Join-Path $scratch 'utils'
$starter = Join-Path $scratch 'starter'
$cache = Join-Path $scratch 'npm-cache'
New-Item -ItemType Directory -Path $scratch, $build, $starter | Out-Null
foreach ($file in 'package.json', 'package-lock.json', 'README.md', 'PLAN.md', 'src') {
  Copy-Item -LiteralPath (Join-Path $source $file) -Destination $build -Recurse
}
$sampleSource = Join-Path $source 'examples\starter'
foreach ($file in 'package.json', 'install.mjs', 'extension.mjs', 'command.mjs') {
  Copy-Item -LiteralPath (Join-Path $sampleSource $file) -Destination $starter
}
Push-Location -LiteralPath $build
try {
  npm --cache $cache ci --ignore-scripts
  $utils = (npm --cache $cache pack --json --pack-destination $scratch | ConvertFrom-Json).filename
} finally {
  Pop-Location
}
Push-Location -LiteralPath $starter
try {
  npm --cache $cache install --ignore-scripts --save-exact (Join-Path $scratch $utils)
  $sample = (npm --cache $cache pack --json --pack-destination $scratch | ConvertFrom-Json).filename
} finally {
  Pop-Location
}
```

**Install and verify the tarball offline in the same PowerShell session.** The
sample bundles its installer dependency and copies only the runtime modules it uses.
`npx` may be quiet while it prepares the package; installer progress starts
at `Checking prerequisites`. Confirm any execution prompt only for the sample
you just built.

```powershell
$artifact = Join-Path $scratch $sample
$copilotHome = Join-Path $scratch 'isolated-home'
Push-Location -LiteralPath $scratch
try {
  npx --cache $cache --offline --ignore-scripts "--package=$artifact" -- extension-utils-starter --copilot-home $copilotHome
  npx --cache $cache --offline --ignore-scripts "--package=$artifact" -- extension-utils-starter --doctor --copilot-home $copilotHome
} finally {
  Pop-Location
}
```

The installer prints `Installation complete`; doctor prints
`Installed sample files and version verified.` The temporary directory is
retained for inspection. These messages verify files on disk, not registration
in a running host. The starter does not configure a reload monitor, load
Copilot, or request a reload. It exposes `/utils-greet hello` when loaded by a
compatible host; automated tests exercise the installed command with a simulated host.

## Status, commands and lifecycle

- `createStatusPublisher({ directory, sessionId, provider })` publishes plain-text
  contributions via `publish(text, priority)`; call it again to renew. Use a
  trusted existing directory and lowercase portable IDs. No timer starts.
  An active record from another owner returns `busy`; an expired record permits
  takeover. An old publisher cannot overwrite or clear a successor. `close()`
  drains admitted writes and clears only the record it still owns. Shutdown
  does not wait for diagnostic callbacks; a final log message may still be
  pending when it returns. Windows uses a lock released at process exit;
  other platforms use the existing
  file-lock policy. Readers ignore malformed or oversized records and report
  the count. `composeStatusLine(base, records, { sessionId })` appends a bounded,
  priority-ordered selection of live contributions without changing the base
  or configuring the host's renderer.
- `defineSlashCommand({ name, getSession, usage, parse, execute, menu })`
  produces an SDK-compatible command object. Register it with the host, and
  supply the extension's own parser and actions. The handler checks ownership,
  supports help and a typed fallback, and treats a menu `null` as cancellation
  and a parser `null` as invalid input. It does not catch and replay a failed
  command. `execute` owns any post-write confirmation semantics.
- `createCleanupScope()` collects callbacks with `defer`; `close()` runs them
  once in reverse order, preserves failures, and shares its result across
  concurrent callers. Do not await `close()` from its own callbacks. The
  extension wires host hooks and controls how long callbacks may take.
- `createSessionNotifier({ session })` queues trusted application-authored
  system notices via `notify(key, { prompt, displayPrompt })`. It deduplicates
  pending and recently accepted keys in process. Acceptance is not delivery
  or completed work. `ERR_NOTICE_UNCERTAIN` means no automatic retry; a manual
  resend can duplicate a notice. `dispose()` stops new notices and waits for
  pending sends, not diagnostic delivery; it cannot retract an accepted notice.
  A send adapter must not wait on its own notification or on disposal.

## Built-in operation diagnostics

Locking, atomic updates and settings persistence report failures as structured
stderr records by default. Successful operations are quiet. Enable debug traces or
inject an extension-owned destination through the same options object:

```js
import { createLogger } from 'copilot-extension-utils/logging/logger';
import { updateSettings } from 'copilot-extension-utils/settings/store';

const logger = createLogger({
  debug: true,
  fields: ['operationId', 'durationMs', 'attempts', 'changed', 'code', 'errorType'],
  sinks: [record => console.error(JSON.stringify(record))],
});

await updateSettings(absoluteSettingsPath, [
  { path: ['preferences', 'enabled'], value: true },
], {
  diagnostics: {
    debug: true,
    write: record => logger.record(record.level, record.event, record.fields),
  },
});
```

Set `diagnostics.debug: false` to disable debug traces while retaining failures
and explicit warning traces.
Built-in records exclude paths, text, settings values and raw error messages.
Trace delivery is deferred until the operation releases its resources, so a
destination cannot hold the same lock recursively. Individual observed calls
await their writers; status and notification shutdown wait only for the
underlying work. Consumers must supply a destination that completes.

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

Application policy, binary asset deployment, whole-install rollback, and
changing existing extensions are out of scope.

## Validation

From a checkout, run `npm ci --ignore-scripts`, then `npm test`. Tests include real independent
processes contending for a file, JSONC preservation, sink failures, rotation,
ownership changes, dependency-isolated imports, and a packed `npx` install.
Success means a zero exit status and no failed tests. Adverse-path tests deliberately
emit error-level diagnostic records; those records alone do not indicate a failed suite.
