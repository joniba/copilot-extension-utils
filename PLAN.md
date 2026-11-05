# Milestones and review gates

Each milestone is independently reviewable. Acceptance is evidence, not merely
finished code or a passing unit-test count. Future milestones are not started
automatically. Adopt the utilities in two early consumers before a final adopter.

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
| M2: early adoption | Pinned, bundled utility copies in two early consumers | Both installed payloads, existing settings and actual behavior verified; preserve unrelated adaptations and state |
| M3: installation | Guarded installation, progress and atomic version receipts | Failed preparation cannot advance the receipt; concurrent edits and partial activation report their actual effects in both early consumers |
| M4: status composition | Ownership-checked, expiring session contributions | Agree a generic protocol; retain the prior renderer; prove expiry and contention in both early consumers |
| M5: repeated policies | Only proven shared command, lifecycle and notification helpers | Keep each capability separate; prove cancellation boundaries, independent cleanup and acceptance-versus-completion semantics in both early consumers |
| M6: final adoption | Integrate the final consumer last | Every selected capability already verified in both earlier consumers; repeat all review gates and public privacy approval |

M2 requires M1. M3 and M4 require M2 but are independent of each other. M5 uses
evidence from M2-M4. M6 is gated on verified earlier adoption, not just library tests.

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
