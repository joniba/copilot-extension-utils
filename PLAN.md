# Milestones and review gates

Each milestone is independently reviewable. Acceptance is evidence, not merely
finished code or a passing unit-test count. Future milestones are not started
automatically. Existing extensions inform the contracts; do not migrate them.
Prove the remaining capabilities in a fresh, neutral extension before using them
in new projects. The foundation release and its acceptance evidence still stand.

## Required gates for every milestone

1. Establish contracts, failure cases and observable outcomes before editing.
2. Compare proven community packages with a small local implementation. Record
   semantic fit, maintenance, runtime support, transitive cost and testability.
3. Implement focused tests, including adverse paths. Verify what actually changed:
   a partial write must not be reported as a refusal, nor acceptance as completion.
4. Perform a correctness review against the contracts and regression evidence.
5. Run a separate **SOLID review subagent**, emphasizing single responsibility,
   independent entry points, dependency direction, injected collaborators and the
   absence of consumer-specific assumptions in generic modules.
6. Review diagnostics: failures must be observable, debug traces can be disabled,
   and neither settings contents nor paths, credentials or message bodies appear
   in built-in operation records. Logging failures must not hide operation results.
7. Review changed documentation against actual behavior. Where a runnable journey
   exists, a **human-reviewer subagent** follows only the documentation in an
   isolated directory after the code-review gate. Do not treat source-aware tests
   as proof that the instructions work.
8. Before each public push, an independent **privacy-reviewer subagent** approves
   the exact outgoing commit, every new ancestor, files, commit metadata, examples
   and repository text. Exclude personal data, machine paths, private project
   context, organizational data and secrets. Session identifiers are allowed.
   Any subsequent edit or commit invalidates approval for the changed tip.
9. Record the reviewed revision, tests, remaining limitations and acceptance
   evidence. Publish only that revision. Stop on genuine blockers; consolidate
   nonblocking concerns in the milestone handoff.

## Milestones

| Milestone | Outcome | Additional acceptance evidence |
| --- | --- | --- |
| M1: foundations | Independent logging, diagnostics and guarded file/settings utilities | Node 22 and 24, real cross-process contention, JSONC preservation, dependency-isolated imports, disabled-trace behavior, observable failures, and isolated packed installation |
| Installation | `npx` entry point, guarded file plans and backups, stage progress, doctor and atomic version receipt | Failed preparation or verification cannot advance the receipt; report partial activation and preserve unrelated files |
| Status composition | Expiring, ownership-checked session contributions and a pure compositor | Retain the prior renderer's text; prove expiry, ownership transfer and contention |
| Commands and lifecycle | Native slash-command, explicit settings scope, cleanup and owning-session notifications | Prove cancellation, typed fallback, settings precedence, independent cleanup and acceptance versus completion |
| New-extension validation | Document a minimal extension using the packed utilities | Run real offline `npx` install and doctor in an isolated home; run the installed slash handler against a simulated host using the deployed files, without relying on the checkout or build tree |

The three capability tracks may proceed independently, then converge in the
new-extension validation. No existing extension, installation, or session is
changed by this plan. The version monitor remains a separate package that reads
the same receipt contract. Record the validation evidence against the reviewed
revision. Live Copilot loading, registration, and invocation are separate from
this gate.

## Dependency decisions for M1

| Capability | Decision and reason |
| --- | --- |
| JSONC editing | Use pinned `jsonc-parser`: surgical syntax-aware editing is not a sensible custom parser project. |
| Logging policy | Keep the small allowlist/redaction/sink adapter; a general-purpose logger such as `pino` remains usable as an injected destination, without imposing its full runtime graph on other users. |
| Cooperative locking | Keep a bounded, local-filesystem-only primitive. `proper-lockfile` offers heartbeat/stale-reclamation semantics that differ from the explicit no-automatic-reclamation contract. Do not claim network-filesystem support. |
| Atomic replacement | Keep the snapshot-checked commit step. `write-file-atomic` offers useful atomic writes but attempts temporary-file cleanup on failure; this contract retains evidence and checks snapshots before replacement. Reconsider if scope grows. |
| Operation traces | Use a small injected structured writer rather than a second logging framework. Debug traces are opt-in; default failure records use stderr, never protocol stdout. |

Revisit these decisions at each milestone. Dependency count alone is not a
correctness argument, and a custom implementation is not preferred merely because
it is already written.

## Refreshed design decisions

- Preserve verified backups and competing-edit checks. Keep preparation and
  activation policy with the caller and do not promise a multi-file transaction.
- Report named installation stages, not spinner ticks or an invented percentage.
  npm already handles package acquisition and executable selection. Node's
  `util.parseArgs` covers the fixed installer flags; a general CLI framework
  such as Commander is useful for a larger CLI but unnecessary here.
- Use a short, OS-released Windows lock for status publication; the portable
  file-lock fallback retains its explicit stale-lock policy. Use one owner and
  expiry per session/provider without prescribing a renderer or app payload.
- Separate safe operation diagnostics from app state. Do not extract which
  events, counters or historical reconstruction policies an application uses.
- Use native command objects and explicitly injected application parsing/menu
  callbacks. Keep lifecycle and notifications independently importable.

## Nonblocking diagnostic delivery

Keep the existing awaited observer and logger contracts. Add an independent
tracer for already-awaited operations and a separate bounded transport for
prepared records. The tracer preserves the operation's result or original
failure, including cancellation, regardless of diagnostic admission or delivery.
Record start evidence before an operation settles; preserve approved numeric
error codes in the same field as approved string codes.

Each destination has its own pending limit and one active write. Count admission,
delivery, suppression, overflow, failed writes, and uncertain writes separately.
Suppress only after confirmed delivery; never retry an ambiguous write. Close
must not await diagnostic delivery. Provide health independent of the primary
sinks, without reentering the same delivery queue. An asynchronous queue cannot
isolate a callback that blocks the JavaScript thread synchronously.

`p-limit` 7.3.3 with `yocto-queue` 1.2.2 passed an isolated comparison on Node
22 and 24 for serial, independently bounded writers. It still requires local
admission limits, accounting, and a closed-state check: even with pending task
rejections enabled, clearing the queue does not prevent a selected callback
from starting. Keep the native scheduler rather than adding those dependencies.
Reuse the existing coordinated rotator: a generic rotation stream would still
need the agreed size, overlapping-writer and interrupted-write behavior.

| Consumer evidence to preserve | Shared requirement and integration check |
| --- | --- |
| Startup stage, version and readiness | A dependency-free consumer bootstrap reports import/attach failures. An installed fixture still runs with missing, damaged or pending optional modules. |
| Safe failure detail and actionable warnings | Allowlisted strings and integer error codes survive unchanged. Retain approved original operation and correlation context separately from delivery failures. User warnings stay at their existing decision point; compare text, count and severity. |
| Operation and cancellation lifecycles | Start is observable while work is pending. Success, failure and cancellation retain their original outcomes even if a sink fails or stalls. |
| State transitions, duplicates and recovery | Pass consumer records through unchanged after safe projection; compare transition order and cycle identity. Do not report persistence prematurely. |
| Pressure, escalation and skipped work | Preserve consumer decisions and warning destinations. Suppression must not hide distinct requests, cycles or outcomes. |
| Publication, ownership, expiry and shutdown | Keep consumer state and retry decisions independent of diagnostics. A stalled sink cannot stop publication or shutdown. |
| Renderer, command and configuration warnings | Preserve existing meanings, warning positions and presentation without routing user warnings through file delivery. |

The consumer owns semantic events, file discovery, the minimal bootstrap and
user-visible warnings. Test persistent installer-to-runtime resolution on Node
22 and 24; source imports alone are insufficient. The consumer review compares
baseline and migrated records and warning behavior. Do not add host requests,
polling, retries, deadlines, or startup gates solely for logging.
