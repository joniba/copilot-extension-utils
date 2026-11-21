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
