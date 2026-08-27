# Deployment Sequence

Implement these as five separate production deployments. Do not combine the
first activation of adjacent phases. Component task groups below retain stable
numbers for review references; execute them according to this phase map rather
than numeric task-group order.

Completion decision (2026-08-27): Phases 1–5 are the complete scope of this
change. The final registry is startup toolchain, Sprite labels, connector, Git
cutover, and network policy. Reusable-process reconciliation, destructive
compatibility cleanup, an operator query surface, and additional combined manual
cohorts are deferred to future changes; this record does not claim those
deferred operations were executed.

## Phase 1 — Transactional Local Migration Foundation

Scope: task group 1 only.

- [x] P1.1 Confirm the phase contains no runtime mutex, runtime migration repository, runtime registry, Sprite reconciliation, connector mutation, or process behavior change.
- [x] P1.2 Deploy only additive/dual-read local schemas and state shapes that the previous deployment can safely ignore or parse. Satisfied trivially: no row is rewritten and no version is recorded, so a rollback sees byte-identical local state.
- [x] P1.3 Pass historical DO/SDK fixtures, atomic rollback, pre-hydration ordering, no-broadcast tests, build, lint, typecheck, and strict OpenSpec validation.
- [x] P1.4 Advance with the additive representation intact. Phase 2 subsequently shipped without Phase 1 removing persisted state.

## Phase 2 — Runtime Boundary and Turn Admission, No Runtime Migrations

Scope: task group 6's mutex/readiness/dispatch work only. Runtime migration
types, tables, coordinator, registry, and definitions must not exist in the
production path yet.

- [x] P2.1 Ship `RuntimeBoundaryMutex`, the branded lease, `_ensureReady(lease)`, and the readiness-to-`beginTurn()` race fix with zero registered runtime migrations.
- [x] P2.2 Keep Phase 2 `_ensureReady(lease)` limited to initialization and provisioning/setup; keep turn admission and process dispatch in the surrounding orchestrator, and do not call a migration coordinator.
- [x] P2.3 Add crash-boundary coverage from synchronous turn claim through dispatch invocation so a Worker stop cannot leave an unrecoverable claimed turn that permanently blocks readiness.
- [x] P2.4 Prove webhooks remain outside the application mutex and can complete an active turn while readiness callers queue.
- [x] P2.5 Pass concurrency, non-reentrancy, claim/dispatch recovery, existing readiness, build, lint, typecheck, and strict OpenSpec validation suites.
- [x] P2.6 Accept the runtime-boundary rollout and advance independently to the inert engine; Phase 3 subsequently shipped without reverting the boundary.

## Phase 3 — Inert Runtime Migration Engine

Scope: task groups 2–5, engine-level portions of 11–12, and the Phase 3
readiness extension. The production registry must be exactly empty.

- [x] P3.1 Add revision APIs, hashing, the `RuntimeMigrationRepository` schema/API, coordinator, lease plumbing, and observability with `RUNTIME_MIGRATIONS = []`.
- [x] P3.2 Extend `_ensureReady(lease)` to call the coordinator, but prove an empty registry returns `current`, writes no migration record, and makes no Sprite/connector/process call.
- [x] P3.3 Keep every setup executor free of targeted `ensureMigration` calls and register no placeholder/tombstone production migration.
- [x] P3.4 Pass migration-record crash matrices and non-empty fixture definitions entirely in tests without activating a production adopter.
- [x] P3.5 Deploy the additive unused `session_runtime_migrations` table and preserve rollback compatibility with code that ignores it.
- [x] P3.6 Advance from the empty-registry deployment only after its no-effect behavior was covered and retained in the next phase.

## Phase 4 — Startup Toolchain First Adopter

Scope: setup immutability/targeted-ensure foundation in task group 7 and all of
task group 8. The production registry contains only `sprite.startup-toolchain`.

- [x] P4.1 Make stored setup task arrays immutable before using setup as a targeted migration caller.
- [x] P4.2 Register only `sprite.startup-toolchain` and keep the legacy ServerState checkpoint compatibility path enabled.
- [x] P4.3 Cover new sessions, completed legacy sessions, incomplete historical setup, active turns, and failed toolchain checks through the focused adopter suites and subsequent late-waking-session canary.
- [x] P4.5 Advance to Phase 5 while retaining the legacy checkpoint; its eventual removal is outside this completed change.

## Phase 5 — Connector, Git, and Network Adopters

Scope: Phase 5 setup call sites from task group 7 and task group 10. The
production registry is toolchain, Sprite labels, connector, Git cutover, then
network policy.

- [x] P5.1 Append `sprite.session-labels`, `session.connector-resource`, `sprite.git-ephemeral-token-cutover`, and `sprite.network-policy` without reordering `sprite.startup-toolchain`.
- [x] P5.2 Add targeted setup ensures only at each complete postcondition and retain all legacy cleanup material required for rollback.
- [x] P5.3 Prove the production registry does not contain `agent.reusable-process` and no contract-driven process termination occurs.
- [x] P5.4 Cover connector disagreement, uncertain create, existing-clone Git repair, policy update, active-turn deferral, and late-waking legacy sessions through focused tests plus the recorded live canary.
  - [x] On 2026-08-14, use a late-waking completed local session to verify active-turn deferral occurs before attempt writes or provider calls.
  - [x] After clearing the active turn, verify connector ID disagreement repairs ServerState from the existing external connector and restores `/health`.
  - [x] Verify the same pass repairs an existing clone's `credential.useHttpPath`, replaces a drifted two-rule network policy, and records each adopter once in registry order.
  - [x] Restart `pnpm dev:local` and verify all active migrations are `current`, with unchanged attempt counts and timestamps and no repeated provider mutations.
  - [x] Accept the automated uncertain-create response-loss coverage in place of a second manual fault-injection cohort; no manual injection is claimed.
- [x] P5.5 Accept Phase 5 as the final rollout boundary on 2026-08-27. The combined legacy end-to-end cohort is deferred rather than recorded as executed.

## 1. Transactional Local Migration Foundation — Phase 1

Shipped in PR #176 on `codex/runtime-migrations-phase-1`, the bottom layer of
the phase stack.

Decision taken during implementation: Phase 1 registers **no data migration**.
Every live session already stores ServerState and client state at the current
shape, so a whole-shape normalization step would persist only what each read
already computes, and would freeze live defaults into append-only history. The
deliverable is the pre-hydration ordering guarantee plus the registration seam;
steps are appended surgically when a field actually changes. Tasks below are
marked against that decision.

- [x] 1.1 Add historical Durable Object fixtures that can set repository versions, seed raw SQLite/JSON rows, construct `SessionAgentDO`, and inspect state before normal application access.
- [x] 1.2 Give local JSON state a schema a future surgical migration can validate against and roll back on. `ServerState` and the startup-toolchain checkpoint are now derived from zod schemas. `ServerStateRepository.get()` deliberately keeps merging onto defaults **without** parsing: a parse failure during construction would leave the session unreachable, so row-rejecting validation belongs in a migration where a throw rolls the transaction back. (Supersedes the original "add a ServerState migration example" task; the example ships as a documented step pattern plus fixture tests instead of a production step.)
- [x] 1.3 Add a migration-only repository adapter for the Agents SDK `cf_agents_state` row at `cf_state_row_id`, registered in the constructor with an empty migration array so appending a step is the only work a future client-state migration requires.
- [x] 1.4 Make the adapter treat an absent SDK row as a no-op whose local repository version can still be recorded. The documented step pattern returns early on an absent row; proven by fixture migration.
- [x] 1.5 Reorder `SessionAgentDO` construction so `migrateAll()` runs after `super()` but before ServerState load, service construction that reads state, socket snapshots, and explicit SDK state access.
- [x] 1.6 Keep normal client-state reads/writes/broadcasts on the Agents SDK rather than the migration adapter.
- [x] 1.7 Add tests for historical SDK state, absent state, invalid old data, atomic rollback, first read observing the migrated value, and no migration broadcast. Transform, rollback, no-op, and already-applied-skip cases run a fixture migration through the real `migrateAll` runner, since production registers no step.
- [x] 1.8 Add an SDK contract test for expected table creation, row ID, and pinned-version constructor ordering.
- [x] 1.9 Add a test proving existing repository migration arrays are append-only and document that array index is persisted history.
- [x] 1.10 Add a fingerprint test pinning every existing migration step so the first appended client-state migration surfaces as a deliberate change.

## 2. Runtime Revision Types and Declaration API — Phase 3

- [x] 2.1 Define `RuntimeMigrationRevision` as a discriminated union of `{ kind: "version"; version }` and `{ kind: "contract"; hash }`.
- [x] 2.2 Keep execution policy out of the initial declaration API: every registered runtime migration is awaited serially and must be current before turn dispatch.
- [x] 2.3 Define the coordinator success-outcome union as `current | applied | deferred_active_turn`; keep failures in the tagged `Result` error branch and keep pending/running as migration-record status or observability vocabulary.
- [x] 2.4 Implement `defineVersionedRuntimeMigration` with positive-safe-integer validation and an explicit scoped version revision.
- [x] 2.5 Implement `defineContractRuntimeMigration` so it builds the desired contract at runtime, hashes it once, and passes the same in-memory desired value to apply.
- [x] 2.6 Ensure callers cannot provide a precomputed arbitrary `desiredHash` that bypasses canonicalization and domain separation.
- [x] 2.7 Define one static ordered registry with immutable stable IDs and descriptions, with tests preserving the relative order of existing definitions when new entries are inserted.
- [x] 2.8 Add startup validation for duplicate IDs and revision-kind changes.
- [x] 2.9 Document that a version bump may skip intermediate implementations and therefore its current apply must converge from every lower stored version; otherwise use separate IDs.
- [x] 2.10 Add API examples for one arbitrary version migration, one contract migration, and one future local-service migration.

## 3. Canonical Contract Hashing and Secret Fingerprints — Phase 3

- [x] 3.1 Implement a deterministic canonical JSON serializer that recursively sorts object keys and preserves array order.
- [x] 3.2 Reject `undefined`, functions, symbols, non-finite numbers, `Date`, `Map`, `Set`, `BigInt`, cyclic values, and other non-JSON contract inputs.
- [x] 3.3 Hash with SHA-256 over a versioned domain separator, stable migration ID, and canonical JSON.
- [x] 3.4 Add canonicalization fixtures for nested key reordering, array ordering, Unicode strings, null, numbers, and invalid inputs.
- [x] 3.5 Add `SecretFingerprint` and a helper for high-entropy SHA-256 fingerprints without exposing raw input in returned diagnostic data.
- [x] 3.6 Establish a keyed-fingerprint or durable-version escape hatch for any future low-entropy secret.
- [x] 3.7 Add tests proving `sha256(canonical({ fingerprint: sha256(secret), otherInputs }))` changes on rotation while neither migration records nor logs contain the secret.
- [x] 3.8 Add logger tests preventing contract preimages, secret values, raw connector payloads, and unbounded process output from entering structured migration logs.

## 4. Runtime Migration Repository — Phase 3

- [x] 4.1 Add the Durable Object-local `session_runtime_migrations` schema migration.
- [x] 4.2 Persist migration ID, serialized attempted revision, nullable serialized applied revision, status (`running`, `failed`, or `applied`), attempt count, timestamps, and sanitized error code/message.
- [x] 4.3 Add one stable serializer and untrusted-row parser for the `RuntimeMigrationRevision` discriminated union; reject malformed JSON, invalid members, mismatched applied/attempted kinds, and registry-kind conflicts.
- [x] 4.4 Keep `RuntimeMigrationRepository` CRUD-only with `get`, `beginAttempt`, `markApplied`, and `markFailed`; keep status-aware retry/backoff policy in the coordinator service.
- [x] 4.5 Make `beginAttempt` retain the prior applied revision while replacing the attempted revision and incrementing attempts.
- [x] 4.6 Make `markApplied` conditional on the matching attempted revision so a stale completion cannot overwrite a newer attempt.
- [x] 4.7 Treat `running` as retry evidence rather than a durable lock.
- [x] 4.8 Add tests for serialized parsing into `appliedRevision`/`attemptedRevision`, missing rows, version rows, contract rows, malformed JSON, invalid union members, kind mismatch, attempt increment, retained prior applied revision, conditional completion, stale running recovery, and error truncation.
- [x] 4.9 Add repository parsing that treats every SQLite row as untrusted boundary input.

## 5. Awaited Runtime Migration Coordinator — Phase 3

- [x] 5.1 Implement version comparison: missing/lower applies, equal skips, and higher stored version skips after rollback while emitting a distinct lifecycle event.
- [x] 5.2 Implement contract comparison: missing or unequal applies and equal skips.
- [x] 5.3 Prepare and compare revisions before any Sprite/connector request.
- [x] 5.4 Check `activeUserMessageId` once at the start of the shared range executor; return range-level `deferred_active_turn` without a migration ID and before contract preparation, migration-record reads, attempt writes, or external calls.
- [x] 5.5 Record running, call idempotent apply, return `applied` only after apply-owned verification and the repository records success, return `current` on a comparison skip, and record sanitized failure otherwise.
- [x] 5.6 Implement one shared serial range executor for full-registry and targeted-prefix execution: apply the active-turn gate before iteration, then continue on `current` or `applied`, stop on failure, and return `applied` for a satisfied range when any entry was freshly applied.
- [x] 5.7 Implement targeted `ensureMigration(id, context, lease)` for setup using the shared range loop over the registry prefix through the target ID; require the boundary already held by readiness and do not expose a direct migration-record mutation API or acquire the runtime mutex again.
- [x] 5.8 Treat the repository's applied revision as the sole initial reconciliation checkpoint; do not add generic invalidation state or compare secondary process/connector/toolchain hashes when the revision is current.
- [x] 5.9 Reject a targeted setup integration whose earlier registry prefix cannot be satisfied at that setup point; reorder/regroup rather than bypassing entries.
- [x] 5.10 Add tests for first apply returning `applied`, current skip returning `current` with zero external calls, a prefix continuing through both outcomes to its target, aggregate `applied` propagation, active-turn deferral before any definition preparation/read, failure stopping the range, contract change, version increase, higher-version rollback, kind mismatch, stale attempt retry, and desired revision changing between attempts.
- [x] 5.11 Add a crash-boundary matrix that simulates interruption before attempt write, after attempt write, after each external effect, after verification, and after applied write.
- [x] 5.12 Add a registry-order test rather than introducing a dependency graph or parallel executor.
- [x] 5.13 Add tests proving equal applied revisions remain local no-ops even when secondary process/connector/toolchain metadata is absent; document that observed-drift repair is outside the initial coordinator API.
- [x] 5.14 Ship the Phase 3 production registry as exactly `[]`; exercise non-empty versioned and contract definitions only through test fixtures.
- [x] 5.15 Add an empty-registry integration test proving readiness returns current with zero migration records, zero setup targeted ensures, and zero Sprite, connector, process-manager, or network-policy calls.

## 6. Runtime Boundary Mutex and Readiness Pipeline — Phase 2, Extended in Phase 3

- [x] 6.1 Implement a rejection-safe FIFO `RuntimeBoundaryMutex` for application-level runtime transitions.
- [x] 6.1a In Phase 2, add a module-private branded `RuntimeBoundaryLease` yielded by `runExclusive` and require it on `_ensureReady`.
- [x] 6.1b In Phases 3–4 extend the same lease requirement to `ensureMigrations` and targeted `ensureMigration`, with no independently callable mutating coordinator RPC/entry point.
- [x] 6.2 Make every `ensureRuntimeReadyAndDispatchNextTurn()` call queue on the mutex and re-evaluate readiness after acquisition; do not add a separate `ensureReadyPromise` in the initial implementation.
- [x] 6.3 Keep `ctx.blockConcurrencyWhile` limited to `initializeSessionState`; do not place long Sprite migrations under the Durable Object global concurrency block.
- [x] 6.4 Keep private `_ensureReady(lease)` readiness-only; it requires proof that the runtime-boundary mutex is held and never acquires it. The surrounding admission orchestrator may accept a prepared message.
- [x] 6.5a Give Phase 2 readiness explicit `ready`, `setup_incomplete`, and tagged failure outcomes.
- [x] 6.5b When Phase 3 connects the coordinator, add `deferred_active_turn` and treat migration-range `current` and `applied` as ready.
- [x] 6.6a In Phase 2 order admission as interrupted-claim recovery, initialization, provision/resume setup, terminal-success gate, and pending initial-message claim; keep the readiness method limited to the middle runtime-preparation stages.
- [x] 6.6b In Phase 3 insert awaited migrations after terminal setup success and before admission.
- [x] 6.7 Preserve `handleInit` latency by awaiting durable initialization only and queueing readiness through `keepAliveWhile`.
- [x] 6.8 Keep `onConnect` snapshot/history delivery and queue readiness on the shared mutex.
- [x] 6.9 Refactor direct chat into mutation-free preparation followed by acquisition of the shared runtime boundary, private `_ensureReady(lease)`, synchronous message persistence/`beginTurn`, boundary release, and spawn after claim.
- [x] 6.10 Ensure there is no `await` between the final ready decision and persistence of non-null `activeUserMessageId`.
- [x] 6.11 Allow the mutex to release after the active-turn write and before process spawn for both direct and pending turns; preserve spawn-failure cleanup of active state.
- [x] 6.12 Split `maybeDispatchPendingMessage()` into a synchronous pending-turn claim inside the readiness-held runtime boundary and asynchronous `spawnClaimedTurn()` after release.
- [x] 6.13 Keep inbound agent webhooks outside the application mutex so terminal chunks can clear active state; document that current regular readiness does not globally block webhooks and retain `blockConcurrencyWhile` only for initialization.
- [x] 6.14 In Phase 2 queue readiness from every turn-completion, abort, or failure path that may unblock pending admission; in Phase 3 use those same hooks to unblock deferred migrations.
- [x] 6.15 Preserve service-local provisioning single-flight guards as defensive direct-call protection until all call sites are proven to use the runtime boundary.
- [x] 6.16a In Phase 2 add concurrency tests for two connections, init plus connection, attachment preparation during queued readiness, pending initial dispatch versus direct chat, mutex release on failure, claim-to-dispatch crash recovery, and webhook progress.
- [x] 6.16b Add chat-during-migration and turn-completion-after-deferral cases in Phase 3.
- [x] 6.17 Add a regression test for the current await-sized race: no Sprite mutation may begin between direct-chat readiness and `beginTurn`.
- [x] 6.18a Add compile-time tests/fixtures rejecting Phase 2 ownership-requiring calls without a lease, plus runtime non-reentrancy tests proving direct chat `_ensureReady(lease)` reuses the existing boundary without reacquiring the mutex.
- [x] 6.18b In Phases 3–4 prove setup targeted ensure and coordinator ownership-requiring calls reuse the existing lease at compile time and runtime.

## 7. Immutable Setup and Targeted Ensure Integration — Foundation in Phase 4, Additional Call Sites in Phase 5

- [x] 7.1 Replace object-key enumeration with one canonical ordered setup task-definition array.
- [x] 7.2 Remove `ensureBackfilledTasksPresent`, `ensureSessionConnectorTaskPresent`, and `ensureNetworkPolicyTaskPresent`.
- [x] 7.3 Limit `repairOnStart()` to metadata/state repair for task IDs already present in the stored run.
- [x] 7.4 Preserve incomplete, completed, and failed stored task arrays byte-for-byte in membership and order.
- [x] 7.5 Gate post-setup runtime migrations on terminal setup success.
- [x] 7.6 Preserve retry of failed stored tasks that explicitly have `canRetry`; exclude failed runs with no retryable task from post-setup runtime work.
- [x] 7.7 Inject targeted coordinator access into setup executors without allowing them to call `RuntimeMigrationRepository.markApplied`.
- [x] 7.8 Make the cloud-container task call `ensureMigration("sprite.startup-toolchain", context, lease)` after Sprite creation and before repository/startup-script work.
- [x] 7.9 Make the session-connector task call `ensureMigration("session.connector-resource", context, lease)`.
- [x] 7.10 Make repository setup call the versioned Git cutover at the point its complete postcondition can be verified.
- [x] 7.11 Make network-policy setup call `ensureMigration("sprite.network-policy", context, lease)`.
- [x] 7.12 For any migration spanning multiple tasks, call low-level reconcilers early as needed but call targeted ensure only at the earliest complete postcondition.
- [x] 7.13 Add tests for canonical new order, unchanged old incomplete arrays, unchanged terminal arrays, compatibility prerequisites inside old executors, and no creation-time pre-stamping.
- [x] 7.14 Add two crash tests: effect before migration-record write and migration-record write before setup-task completion.
- [x] 7.15 Add a new-Sprite test where the required state already exists and targeted ensure verifies/no-ops rather than reinstalling.

## 8. Startup Toolchain Contract Migration — Phase 4

- [x] 8.1 Register `sprite.startup-toolchain` as an awaited contract migration.
- [x] 8.2 Reuse common and provider-specific check contract objects as desired inputs.
- [x] 8.3 Reuse each check's idempotent apply/verification logic while moving hash comparison and applied revision ownership to the coordinator.
- [x] 8.4 Add common-check coverage proving a shared binary/version/script change alters every affected provider's desired hash.
- [x] 8.5 Add provider coverage for minimum version, install URL, explicit script revision, and script body changes.
- [x] 8.6 Add one-time compatibility adoption from `ServerState.startupToolchain.contractHash`: matching legacy hash creates the applied migration record with zero Sprite calls; mismatching hash reconciles.
- [x] 8.7 Remove the setup-time `!startupToolchain` guard and replace the call site with targeted coordinator ensure.
- [x] 8.8 Remove the separate readiness-time toolchain stage from the old plan; readiness uses only the runtime registry.
- [x] 8.9 Preserve first-run ordering before repository clone and environment startup script.
- [x] 8.10 Add tests for completed legacy setup, incomplete historical setup, current hash skip, changed hash repair, failed check, retry, and setup checklist failure reporting.
- [x] 8.11 Retain the legacy ServerState checkpoint at completion; its eventual local migration and compatibility-read removal are deferred to a future cleanup change.

## 9. Reusable Agent Process Contract — Deferred

No reusable-process migration is part of this change. New process spawns already
hash-compare and upload the embedded vm-agent bundle; an existing process exits
after its bounded post-turn idle window. Immediate process turnover may be
proposed separately if it becomes necessary.

## 10. Connector, Git, and Network Migrations — Phase 5

- [x] 10.1 Extend `@repo/sprites-client` with the official connector access-policy update operation and parsed response types if not already present.
- [x] 10.2 Build `SessionConnectorContract` from provider, base/test URLs, and allowed/blocked endpoints; exclude the webhook token, which `apply` ensures exists locally before minting and which is not rotated today.
- [x] 10.2a Build `SessionSpriteLabelsContract` from the session id and persisted environment snapshot, and reconcile its exact label set through a dedicated service before connector reconciliation.
- [x] 10.3 Exclude allocated connector ID and incidental connector name from the desired contract.
- [x] 10.3a Register `sprite.session-labels` as an awaited contract migration immediately before `session.connector-resource`.
- [x] 10.4 Register `session.connector-resource` as an awaited contract migration.
- [x] 10.5 Extract an idempotent connector reconciler that treats external state as authoritative, ServerState ID as a hint, D1 as a mirror, and writes ServerState last.
- [x] 10.6 Update and read back policy-only changes, including newly allowed internal endpoints.
- [x] 10.7 Replace rather than falsely checkpoint connectors when base URL or credential changes cannot be applied in place.
- [x] 10.8 Persist secret-safe desired-revision and attempt-identity metadata sufficient to distinguish a connector created by the current attempt from an unverifiable abandoned connector.
- [x] 10.8a Handle uncertain create, abandoned external connector, replacement rollback window, failed cleanup, and D1 write failure without losing the authoritative external ID; replace rather than adopt when attempt provenance cannot be proven.
- [x] 10.9 Verify connector configuration through API readback and do not ping the connector URL.
- [x] 10.10 Register `sprite.git-ephemeral-token-cutover` as an awaited versioned migration for historical existing-clone repair.
- [x] 10.11 Make Git apply inspect and reconcile existing remote URLs, helper bundle contents, credential settings, proactive auth, and persisted `gitAuthMode`.
- [x] 10.12 Verify Git locally and do not ping the proxy/gateway.
- [x] 10.13 Retire the legacy Git proxy secret only after the new local Git configuration verifies.
- [x] 10.14 Register `sprite.network-policy` as an awaited contract migration based on the persisted session environment snapshot, provider, Worker/gateway hostnames, and exact deployment-owned allowlist rules.
- [x] 10.15 Treat a successful provider policy mutation response as the apply postcondition; do not add policy readback or endpoint reachability to readiness.
- [x] 10.16 Preserve the current behavior that source environment edits do not mutate existing session snapshots.
- [x] 10.17 Keep intentional future snapshot-row updates outside this change; any such update must add its own network-contract regression coverage.
- [x] 10.18 Make toolchain, Sprite labels, connector, Git cutover, and network policy the final registry order for this change; reusable-process reconciliation remains unregistered.
- [x] 10.19 Accept the focused legacy-session integration tests and live canary as Phase 5 closure; a combined next-turn gateway end-to-end cohort is deferred and is not claimed as executed.
- [x] 10.20 Add connector tests for endpoint addition, policy correction, base URL change, missing checkpointed connector, abandoned create, D1 disagreement, and no secret leakage.
- [x] 10.20a Add focused label-service tests for fresh-snapshot reuse, authoritative fallback, no-op, exact replacement, omitted labels, and failed update verification.
- [x] 10.21 Leave obsolete Sprite-held Git/webhook cleanup disabled and undefined here; retain the connector-injected server-held webhook credential and defer cleanup to a future change.
- [x] 10.22 Assert the Phase 5 production registry exactly matches its five-entry snapshot and cannot perform contract-driven process termination.

## 11. Extensibility and Regression Scenarios — Engine Fixtures in Phase 3, Adopter Regressions Thereafter

- [x] 11.1 Add a documented example of `sprite.git-direct-connector-url` as a future versioned migration that removes helper state without conflicting with the already-applied historical cutover.
- [x] 11.2 Add a documented example of a helper bundle update using a new migration ID or safe scoped version bump.
- [x] 11.3 Add a documented contract migration for a future Sprite-local session service using bundle, service-definition, protocol, and configuration hashes.
- [x] 11.4 Add a paired versioned data/layout migration example that must precede the future local-service contract.
- [x] 11.5 Document service removal through desired absence or a versioned uninstall plus retired/tombstone contract.
- [x] 11.6 Add a contract-retirement regression test proving a superseded recurring migration cannot reinstall legacy state.
- [x] 11.7 Add a late-waking-session test that skips historical applied versions and converges every current contract from old external state.
- [x] 11.8 Add a code-rollback test proving higher versioned state is not downgraded.
- [x] 11.9 Add a contract-rollback test documenting controller-style reconciliation to the old desired hash and requiring staged compatibility for destructive cutovers.
- [x] 11.10 Add a static-registry test proving no dependency graph or category enum is required when registering a new arbitrary migration.

## 12. Observability, Rollout, and Operations — Added Incrementally Per Phase

- [x] 12.1 Add structured secret-safe lifecycle events for prepared, pending, current, running, applied, failed, deferred, interrupted retry, and newer-version skip states; keep them distinct from coordinator outcomes.
- [x] 12.2 Include migration ID, revision kind, hash/version, attempt, duration, and sanitized error code without contract preimages.
- [x] 12.3 Define bounded exponential retry/backoff, cap, and repeated-failure operator threshold.
- [x] 12.4 Prevent new migration claims after session teardown begins.
- [x] 12.5 Use structured lifecycle logs as the initial operator surface; defer a dedicated pending/failed-record query to a future operations change rather than adding an unused list API.
- [x] 12.6 Document forward-only local/version rules, contract rollback semantics, compensating migrations, contract retirement, and preparation/cutover/cleanup windows.
- [x] 12.7 Accept focused phase coverage plus the recorded Phase 5 live canary; no reusable-process cohort is required because that adopter was removed.
- [x] 12.8 Keep per-adopter lifecycle events and defer a separate backlog-reporting surface to a future operations change.
- [x] 12.9 Retain legacy ServerState toolchain compatibility at completion; remove it only through a future local migration after a separate cleanup decision.

## 13. Validation — Required Before Every Phase Advances

- [x] 13.1 Run focused API-server repository, constructor, SDK-state, setup, readiness, mutex, coordinator, toolchain, process-manager, connector, Git, and network-policy tests.
- [x] 13.2 Accept the focused scenario suites and recorded live canary in place of an additional combined new/legacy end-to-end suite; no unrun suite is claimed.
- [x] 13.3 Run `pnpm build`.
- [x] 13.4 Run `pnpm lint`.
- [x] 13.5 Run `pnpm typecheck`.
- [x] 13.6 Run `pnpm test`.
- [x] 13.7 Run strict OpenSpec validation and resolve all artifact errors.
- [x] 13.8 Re-read the implementation against every edge-case row in `design.md` and add any missing regression test before rollout.
- [x] 13.9 For each deployment, assert the exact production registry snapshot and prove definitions assigned to later phases are not reachable.
- [x] 13.10 Record final deployment PR #180 / commit `99792e3b`, the Phase 5 live canary details above, retention of rollback compatibility state, and explicit scope-completion approval on 2026-08-27.
