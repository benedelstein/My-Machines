# Deployment Sequence

Implement these as six separate production deployments. Do not combine the
first activation of adjacent phases. Component task groups below retain stable
numbers for review references; execute them according to this phase map rather
than numeric task-group order.

## Phase 1 — Transactional Local Migration Foundation

Scope: task group 1 only.

- [x] P1.1 Confirm the phase contains no runtime mutex, runtime migration repository, runtime registry, Sprite reconciliation, connector mutation, or process behavior change.
- [x] P1.2 Deploy only additive/dual-read local schemas and state shapes that the previous deployment can safely ignore or parse. Satisfied trivially: no row is rewritten and no version is recorded, so a rollback sees byte-identical local state.
- [x] P1.3 Pass historical DO/SDK fixtures, atomic rollback, pre-hydration ordering, no-broadcast tests, build, lint, typecheck, and strict OpenSpec validation.
- [ ] P1.4 Complete an observation window before Phase 2; do not remove any old persisted representation in this phase.

## Phase 2 — Runtime Boundary and Turn Admission, No Runtime Migrations

Scope: task group 6's mutex/readiness/dispatch work only. Runtime migration
types, tables, coordinator, registry, and definitions must not exist in the
production path yet.

- [x] P2.1 Ship `RuntimeBoundaryMutex`, the branded lease, `_ensureReady(lease)`, and the readiness-to-`beginTurn()` race fix with zero registered runtime migrations.
- [x] P2.2 Keep Phase 2 `_ensureReady(lease)` limited to initialization and provisioning/setup; keep turn admission and process dispatch in the surrounding orchestrator, and do not call a migration coordinator.
- [x] P2.3 Add crash-boundary coverage from synchronous turn claim through dispatch invocation so a Worker stop cannot leave an unrecoverable claimed turn that permanently blocks readiness.
- [x] P2.4 Prove webhooks remain outside the application mutex and can complete an active turn while readiness callers queue.
- [x] P2.5 Pass concurrency, non-reentrancy, claim/dispatch recovery, existing readiness, build, lint, typecheck, and strict OpenSpec validation suites.
- [ ] P2.6 Observe dispatch latency, duplicate/blocked turn errors, stale active-turn recovery, and webhook completion before Phase 3.

## Phase 3 — Inert Runtime Migration Engine

Scope: task groups 2–5, engine-level portions of 11–12, and the Phase 3
readiness extension. The production registry must be exactly empty.

- [x] P3.1 Add revision APIs, hashing, the `RuntimeMigrationRepository` schema/API, coordinator, lease plumbing, and observability with `RUNTIME_MIGRATIONS = []`.
- [x] P3.2 Extend `_ensureReady(lease)` to call the coordinator, but prove an empty registry returns `current`, writes no migration record, and makes no Sprite/connector/process call.
- [x] P3.3 Keep every setup executor free of targeted `ensureMigration` calls and register no placeholder/tombstone production migration.
- [x] P3.4 Pass migration-record crash matrices and non-empty fixture definitions entirely in tests without activating a production adopter.
- [ ] P3.5 Deploy the additive unused `session_runtime_migrations` table and confirm rollback code safely ignores it.
- [ ] P3.6 Observe empty-registry readiness latency and error rates before Phase 4.

## Phase 4 — Startup Toolchain First Adopter

Scope: setup immutability/targeted-ensure foundation in task group 7 and all of
task group 8. The production registry contains only `sprite.startup-toolchain`.

- [ ] P4.1 Make stored setup task arrays immutable before using setup as a targeted migration caller.
- [ ] P4.2 Register only `sprite.startup-toolchain` and keep the legacy ServerState checkpoint compatibility path enabled.
- [ ] P4.3 Canary new sessions, completed legacy sessions, incomplete historical setup, active turns, and failed toolchain checks.
- [ ] P4.4 Confirm no connector, Git, network-policy, or process migration records/effects exist.
- [ ] P4.5 Complete an observation window before removing the legacy checkpoint or advancing to Phase 5.

## Phase 5 — Connector, Git, and Network Adopters

Scope: Phase 5 setup call sites from task group 7 and task group 10. The
production registry is toolchain, connector, Git cutover, then network policy.

- [ ] P5.1 Append `session.connector-resource`, `sprite.git-ephemeral-token-cutover`, and `sprite.network-policy` without reordering `sprite.startup-toolchain`.
- [ ] P5.2 Add targeted setup ensures only at each complete postcondition and retain all legacy cleanup material required for rollback.
- [ ] P5.3 Prove the production registry does not contain `agent.reusable-process` and no contract-driven process termination occurs.
- [ ] P5.4 Canary connector disagreement, uncertain create, existing-clone Git repair, policy update, active-turn deferral, and late-waking legacy sessions.
- [ ] P5.5 Complete the legacy end-to-end cohort and an observation window before Phase 6.

## Phase 6 — Reusable Agent Process Adopter

Scope: task group 9. Append `agent.reusable-process` last.

- [ ] P6.1 Add prepared process-contract inputs to the already-shipped readiness boundary without changing prior registry order.
- [ ] P6.2 Canary no-process, idle reusable process, active-turn deferral, termination failure, already-gone process, and preserved `agentSessionId` cohorts.
- [ ] P6.3 Verify readiness only terminates stale idle processes and ordinary dispatch creates replacements from the exact prepared inputs.
- [ ] P6.4 Exercise rollback to the prior process contract and measure restart/reuse/error rates before any cleanup deployment.
- [ ] P6.5 Keep obsolete Git/webhook/process cleanup migrations disabled until a later rollback window closes.

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

## 6. Runtime Boundary Mutex and Readiness Pipeline — Phase 2, Extended in Phases 3 and 6

- [x] 6.1 Implement a rejection-safe FIFO `RuntimeBoundaryMutex` for application-level runtime transitions.
- [x] 6.1a In Phase 2, add a module-private branded `RuntimeBoundaryLease` yielded by `runExclusive` and require it on `_ensureReady`.
- [x] 6.1b In Phases 3–4 extend the same lease requirement to `ensureMigrations` and targeted `ensureMigration`, with no independently callable mutating coordinator RPC/entry point.
- [x] 6.2 Make every `ensureRuntimeReadyAndDispatchNextTurn()` call queue on the mutex and re-evaluate readiness after acquisition; do not add a separate `ensureReadyPromise` in the initial implementation.
- [x] 6.3 Keep `ctx.blockConcurrencyWhile` limited to `initializeSessionState`; do not place long Sprite migrations under the Durable Object global concurrency block.
- [x] 6.4 Keep private `_ensureReady(lease)` readiness-only; it requires proof that the runtime-boundary mutex is held and never acquires it. The surrounding admission orchestrator may accept a prepared message, while Phase 6 may extend readiness with paired prepared process inputs.
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
- [ ] 6.18b In Phases 3–4 prove setup targeted ensure and coordinator ownership-requiring calls reuse the existing lease at compile time and runtime.

## 7. Immutable Setup and Targeted Ensure Integration — Foundation in Phase 4, Additional Call Sites in Phase 5

- [ ] 7.1 Replace object-key enumeration with one canonical ordered setup task-definition array.
- [ ] 7.2 Remove `ensureBackfilledTasksPresent`, `ensureSessionConnectorTaskPresent`, and `ensureNetworkPolicyTaskPresent`.
- [ ] 7.3 Limit `repairOnStart()` to metadata/state repair for task IDs already present in the stored run.
- [ ] 7.4 Preserve incomplete, completed, and failed stored task arrays byte-for-byte in membership and order.
- [ ] 7.5 Gate post-setup runtime migrations on terminal setup success.
- [ ] 7.6 Preserve retry of failed stored tasks that explicitly have `canRetry`; exclude failed runs with no retryable task from post-setup runtime work.
- [ ] 7.7 Inject targeted coordinator access into setup executors without allowing them to call `RuntimeMigrationRepository.markApplied`.
- [ ] 7.8 Make the cloud-container task call `ensureMigration("sprite.startup-toolchain", context, lease)` after Sprite creation and before repository/startup-script work.
- [ ] 7.9 Make the session-connector task call `ensureMigration("session.connector-resource", context, lease)`.
- [ ] 7.10 Make repository setup call the versioned Git cutover at the point its complete postcondition can be verified.
- [ ] 7.11 Make network-policy setup call `ensureMigration("sprite.network-policy", context, lease)`.
- [ ] 7.12 For any migration spanning multiple tasks, call low-level reconcilers early as needed but call targeted ensure only at the earliest complete postcondition.
- [ ] 7.13 Add tests for canonical new order, unchanged old incomplete arrays, unchanged terminal arrays, compatibility prerequisites inside old executors, and no creation-time pre-stamping.
- [ ] 7.14 Add two crash tests: effect before migration-record write and migration-record write before setup-task completion.
- [ ] 7.15 Add a new-Sprite test where the required state already exists and targeted ensure verifies/no-ops rather than reinstalling.

## 8. Startup Toolchain Contract Migration — Phase 4

- [ ] 8.1 Register `sprite.startup-toolchain` as an awaited contract migration.
- [ ] 8.2 Reuse common and provider-specific check contract objects as desired inputs.
- [ ] 8.3 Reuse each check's idempotent apply/verification logic while moving hash comparison and applied revision ownership to the coordinator.
- [ ] 8.4 Add common-check coverage proving a shared binary/version/script change alters every affected provider's desired hash.
- [ ] 8.5 Add provider coverage for minimum version, install URL, explicit script revision, and script body changes.
- [ ] 8.6 Add one-time compatibility adoption from `ServerState.startupToolchain.contractHash`: matching legacy hash creates the applied migration record with zero Sprite calls; mismatching hash reconciles.
- [ ] 8.7 Remove the setup-time `!startupToolchain` guard and replace the call site with targeted coordinator ensure.
- [ ] 8.8 Remove the separate readiness-time toolchain stage from the old plan; readiness uses only the runtime registry.
- [ ] 8.9 Preserve first-run ordering before repository clone and environment startup script.
- [ ] 8.10 Add tests for completed legacy setup, incomplete historical setup, current hash skip, changed hash repair, failed check, retry, and setup checklist failure reporting.
- [ ] 8.11 After the compatibility window, add a local ServerState migration to remove the legacy checkpoint and delete compatibility reads/writes.
- [ ] 8.12 Assert the Phase 4 production registry is exactly `[sprite.startup-toolchain]` and that no other runtime migration ID can produce a migration record.

## 9. Reusable Agent Process Contract — Phase 6

- [ ] 9.1 Add one `PreparedReusableAgentProcess` builder that returns a sanitized semantic contract, its hash, and paired concrete launch inputs.
- [ ] 9.2 Include vm-agent bundle hash, provider identity, semantic wrapper/command, working directory, TTY/detach/timeout semantics, stable plain environment, session ID, relevant minimum-version values, and webhook delivery inputs.
- [ ] 9.3 Exclude process run ID, initial message path, user message ID, provider resume `agentSessionId`, per-turn NDJSON model/effort/mode, and generated launch timestamps.
- [ ] 9.4 Exclude provider credential contents from the process contract; dispatch refreshes credentials server-side and passes the concrete snapshot only to spawn, never into contract comparison.
- [ ] 9.4a Document the known reuse gap with a code TODO: a reused process keeps its spawn-time credentials; a follow-up change delivers refreshed credentials on each dispatch to an existing process (for example as a per-turn NDJSON credential payload applied before the turn).
- [ ] 9.4b Reject an obviously active second chat before expensive preparation, then retain the authoritative mutex-held active check for race safety.
- [ ] 9.5 Exclude the legacy bearer webhook token and connector-held webhook credential from the initial process contract; document that rotation alone does not restart a reusable process.
- [ ] 9.6 In Phase 6 append `agent.reusable-process` as the last migration after the unchanged four-entry Phase 5 registry prefix.
- [ ] 9.7 Use the runtime migration repository as the sole process-contract checkpoint; do not add `agentProcessContractHash` to ServerState.
- [ ] 9.8 Clear process ID and run ID together while preserving provider `agentSessionId`.
- [ ] 9.9 Change process termination to return `confirmed_killed`, `already_gone`, or typed `failed`.
- [ ] 9.10 Make non-404 termination failure abort the migration before applied revision changes; treat 404 as verified absence.
- [ ] 9.11 Make readiness terminate only; keep replacement spawn in the existing dispatch path.
- [ ] 9.12 Require every attach/spawn path to follow mutex-held readiness and trust an equal applied migration-record hash rather than comparing live process-contract metadata.
- [ ] 9.12a Add a test proving the implementation has no secondary `agentProcessContractHash` checkpoint or invalidation branch.
- [ ] 9.13 Make new spawn use the concrete inputs paired with the applied migration contract and persist only the existing process ID/run ID metadata.
- [ ] 9.14 Avoid rebuilding environment/launch inputs independently between comparison and spawn.
- [ ] 9.15 Add tests for bundle-only change, wrapper-only change, plain environment change, credential-rotation non-participation, webhook URL/auth change, webhook-secret non-participation, current reuse, no-process success, termination failure, already-gone process, preserved agent session, and replacement spawn.
- [ ] 9.16 Add a test proving per-turn message/path/model/effort inputs do not invalidate the reusable process.
- [ ] 9.17 Add a test proving provider credential refresh or rotation produces an identical process contract.
- [ ] 9.18 Add a legacy-adoption test where an existing process and missing process-migration record cause first apply to terminate the unknown process before recording the desired hash.
- [ ] 9.19 Assert Phase 6 appends `agent.reusable-process` after the unchanged Phase 5 registry prefix and is the first phase that can terminate an idle process because a desired launch contract changed.

## 10. Connector, Git, and Network Migrations — Phase 5

- [ ] 10.1 Extend `@repo/sprites-client` with the official connector access-policy update operation and parsed response types if not already present.
- [ ] 10.2 Build `SessionConnectorContract` from provider, base/test URLs, required labels, and allowed/blocked endpoints; exclude the webhook token, which `apply` ensures exists locally before minting and which is not rotated today.
- [ ] 10.3 Exclude allocated connector ID and incidental connector name from the desired contract.
- [ ] 10.4 Register `session.connector-resource` as an awaited contract migration.
- [ ] 10.5 Extract an idempotent connector reconciler that treats external state as authoritative, ServerState ID as a hint, D1 as a mirror, and writes ServerState last.
- [ ] 10.6 PATCH and read back policy-only changes, including newly allowed internal endpoints.
- [ ] 10.7 Replace rather than falsely checkpoint connectors when base URL or credential changes cannot be applied in place.
- [ ] 10.8 Persist secret-safe desired-revision and attempt-identity metadata sufficient to distinguish a connector created by the current attempt from an unverifiable abandoned connector.
- [ ] 10.8a Handle uncertain create, abandoned external connector, replacement rollback window, failed cleanup, and D1 write failure without losing the authoritative external ID; replace rather than adopt when attempt provenance cannot be proven.
- [ ] 10.9 Verify connector configuration through API readback and do not ping the connector URL.
- [ ] 10.10 Register `sprite.git-ephemeral-token-cutover` as an awaited versioned migration for historical existing-clone repair.
- [ ] 10.11 Make Git apply inspect and reconcile existing remote URLs, helper bundle contents, credential settings, proactive auth, and persisted `gitAuthMode`.
- [ ] 10.12 Verify Git locally and do not ping the proxy/gateway.
- [ ] 10.13 Retire the legacy Git proxy secret only after the new local Git configuration verifies.
- [ ] 10.14 Register `sprite.network-policy` as an awaited contract migration based on the persisted session environment snapshot, provider, Worker/gateway hostnames, and deployment allowlist revision.
- [ ] 10.15 Verify network policy through normalized apply response or readback rather than endpoint reachability.
- [ ] 10.16 Preserve the current behavior that source environment edits do not mutate existing session snapshots.
- [ ] 10.17 Add tests showing an intentional future snapshot-row update would change the network and process contracts without coordinator redesign.
- [ ] 10.18 Add the Phase 5 registry order: toolchain, connector, Git cutover, network policy; explicitly keep reusable process unregistered until Phase 6.
- [ ] 10.19 Add an end-to-end legacy-session test with terminal setup, existing clone, connector creation/reuse, label repair, Git cutover, network policy, old-process termination, and next-turn gateway webhook delivery.
- [ ] 10.20 Add connector tests for endpoint addition, policy correction, base URL change, missing checkpointed connector, abandoned create, D1 disagreement, and no secret leakage.
- [ ] 10.21 Define but do not prematurely enable a later versioned cleanup migration for obsolete Sprite-held Git/webhook delivery material; retain the connector-injected server-held webhook credential.
- [ ] 10.22 Assert the Phase 5 production registry exactly matches its four-entry snapshot and cannot perform contract-driven process termination.

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
- [ ] 12.5 Add an operator-visible query surface for pending/failed runtime migration records without exposing secret inputs; do not keep an unused repository-wide list API as a placeholder.
- [x] 12.6 Document forward-only local/version rules, contract rollback semantics, compensating migrations, contract retirement, and preparation/cutover/cleanup windows.
- [ ] 12.7 Run separate canary cohorts: Phase 3 empty registry; Phase 4 new/completed/incomplete setup and toolchain adoption; Phase 5 stale rows, active turns, and connector disagreement; Phase 6 idle persistent processes.
- [ ] 12.8 Measure each adopter backlog separately: toolchain checks in Phase 4, connector/Git/network changes in Phase 5, and idle process terminations in Phase 6.
- [ ] 12.9 Keep legacy ServerState toolchain compatibility until canaries prove migration-record adoption, then remove it through the planned local migration.

## 13. Validation — Required Before Every Phase Advances

- [x] 13.1 Run focused API-server repository, constructor, SDK-state, setup, readiness, mutex, coordinator, toolchain, process-manager, connector, Git, and network-policy tests.
- [ ] 13.2 Run the end-to-end new-session and legacy-session scenario suites.
- [x] 13.3 Run `pnpm build`.
- [x] 13.4 Run `pnpm lint`.
- [x] 13.5 Run `pnpm typecheck`.
- [x] 13.6 Run `pnpm test`.
- [x] 13.7 Run strict OpenSpec validation and resolve all artifact errors.
- [x] 13.8 Re-read the implementation against every edge-case row in `design.md` and add any missing regression test before rollout.
- [x] 13.9 For each deployment, assert the exact production registry snapshot and prove definitions assigned to later phases are not reachable.
- [ ] 13.10 Record the phase's deployment identifier, canary cohort, observation window, rollback decision, and explicit approval to advance.
