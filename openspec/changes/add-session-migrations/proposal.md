## Why

Session setup is intentionally terminal. Once a session's stored setup run
completes, later deployments do not revisit it, so existing Sprites do not
automatically receive new runtime requirements such as updated binaries,
connector policy, network policy, process launch configuration, helper scripts,
or a newly installed local service.

The existing startup-toolchain hash demonstrates the desired-state technique but
is attached to the wrong lifecycle. Its production caller is inside a terminal
setup task and is skipped whenever a checkpoint exists. Existing sessions
therefore do not reconcile when a minimum version, repair script, or other
toolchain input changes.

A repository of numbered migration records alone would fix one-time historical transitions,
but it would make recurring desired state awkward: every script, environment, or
policy change would require inventing another one-off migration. A contract hash
alone would make arbitrary transitions awkward: it would force the system to
model every future change as a permanent semantic category even when the work is
simply "perform this idempotent transition once."

The runtime needs one coordinator that supports both forms:

- **versioned migrations** for arbitrary, forward-only transitions;
- **contract migrations** for state that should continue matching current
  deployment inputs.

Both forms need the same at-least-once runtime migration repository, active-turn protection, setup
integration, retry behavior, and observability. They should differ only in how
they calculate their desired revision.

Persisted Durable Object and Agents SDK state have a separate atomicity
boundary. Those values still need constructor-time transactional migrations
before application code hydrates or reads them.

## What Changes

- Extend the existing Durable Object repository migration system so it runs
  before normal state hydration and can reach both owned SQLite/JSON state and
  the Agents SDK-owned `cf_agents_state` row. Register migration steps
  surgically, when a field actually changes; state already at its current shape
  gets no step, since read-time defaults already cover it.
- Add one per-session `RuntimeMigrationCoordinator` backed by a
  `RuntimeMigrationRepository` that stores records in
  `session_runtime_migrations`.
- Normalize every runtime migration to:
  `migration id + desired revision + idempotent apply`.
- Provide two declaration helpers:
  - `defineVersionedRuntimeMigration`, whose desired revision is an explicit
    integer;
  - `defineContractRuntimeMigration`, whose desired revision is a canonical
    SHA-256 hash of runtime-built desired inputs.
- Declare migrations statically in code and construct contract values at
  runtime. The coordinator stores only revision hashes and sanitized attempt
  metadata, never contract preimages or secrets.
- Fold the existing startup-toolchain contract into the runtime migration
  registry. Remove the separate readiness-time toolchain system after a
  compatibility handoff from the existing ServerState checkpoint.
- Represent the reusable vm-agent process launch specification as a contract:
  bundle contents, process-frozen command/configuration, stable environment
  values, and webhook URL/authentication mode. The contract deliberately
  excludes the webhook secret and all provider credential material: credentials
  are refreshed server-side at dispatch and delivered outside the contract, so
  rotation never invalidates a process. Delivering refreshed credentials to a
  reused process is a documented follow-up change. A desired hash that differs
  from the migration record's applied hash fail-closed terminates an idle persistent
  process; the existing dispatch path creates its replacement. Do not persist
  or compare a second process-contract hash.
- Represent deterministic connector and network policy as contract migrations.
  Use arbitrary versioned migrations for historical Git transport cutovers and
  other changes whose future shape is not worth encoding into a permanent
  contract type.
- Add a runtime-boundary mutex that serializes external readiness mutation with
  the synchronous transition from idle state to `beginTurn()`. Keep inbound
  agent webhooks outside this mutex so an active turn can finish. Do not add a
  separate `ensureReadyPromise`; queued callers rerun cheap migration-record checks after
  acquiring the mutex. Have the mutex yield an opaque branded lease required by
  `_ensureReady(lease, ...)` and mutating coordinator methods so ordinary ungated calls
  fail compilation.
- Make `ensureReady()` the single readiness pipeline for initialization,
  provisioning, awaited runtime migrations, and pending initial-message
  dispatch.
- Keep background/best-effort maintenance out of the initial migration API.
  Every registered runtime migration is awaited, runs serially, and must be
  current before a turn begins.
- Preserve each stored setup task list as an immutable snapshot. New setup runs
  use one canonical task order; old incomplete and terminal runs are never
  spliced.
- Let setup call `runtimeMigrationCoordinator.ensureMigration(id, context, lease)` at the
  earliest point where the migration can be fully applied and verified, passing
  the lease already held by readiness. Setup never pre-stamps a migration,
  reacquires the non-reentrant mutex, or writes migration records directly.
- Reconcile legacy sessions through the same registry, including connector
  adoption, existing-clone Git repair, connector-aware network policy, and
  process restart when spawn-frozen values change.
- Keep D1 migrations deployment-managed and separate from per-session local and
  runtime migrations.

## Deployment Phases

Implement and deploy this change incrementally. Each phase is independently
reviewable and remains deployed through an observation window before the next
phase activates additional behavior:

1. **Local migration foundation:** add constructor-time Durable Object and
   Agents SDK state migration support only, registering no migration step
   because live sessions are already at the current shape. No runtime mutex,
   runtime migration repository, registry, or Sprite behavior changes.
2. **Readiness and turn-admission boundary:** ship the runtime-boundary mutex,
   branded lease, `_ensureReady()` refactor, and atomic readiness-to-turn claim.
   Register zero runtime migrations and create no runtime migration records. This
   phase independently fixes the current readiness/`beginTurn()` race.
3. **Inert runtime migration engine:** add revision types, canonical hashing,
   `RuntimeMigrationRepository`, coordinator, observability, and a statically empty
   registry. Readiness invokes the empty registry, producing no Sprite,
   connector, process, or setup behavior change.
4. **Startup-toolchain first adopter:** register only
   `sprite.startup-toolchain`, add legacy-checkpoint adoption, and introduce
   immutable setup/targeted-ensure integration.
5. **Connector, Git, and network adopters:** append
   `session.connector-resource`, `sprite.git-ephemeral-token-cutover`, and
   `sprite.network-policy` in that order. Keep reusable-process reconciliation
   disabled during this phase.
6. **Reusable-process adopter:** append `agent.reusable-process` last, after the
   earlier migration cohorts are stable. This is the first phase allowed to
   terminate an idle process solely because its desired launch contract changed.

No phase may combine its first production activation with a later phase's first
activation. Every phase has explicit entry/exit checks and a rollback boundary
in `design.md` and `tasks.md`.

## Capabilities

### New Capabilities

- `session-migrations`: Transactional local state migration plus a unified,
  revisioned runtime migration engine supporting both arbitrary versioned
  transitions and hash-based desired-state reconciliation.

### Modified Capabilities

None.

## Impact

- `SessionAgentDO` construction, initialization, readiness, chat dispatch, and
  turn-completion scheduling.
- A new Durable Object-local runtime migration repository, coordinator, static
  registry, canonical contract hasher, and mutex.
- Agents SDK client-state storage compatibility at the pre-hydration boundary.
- `SessionSetupRunService` and `SessionProvisionService` setup ordering and
  completion handoff.
- Startup-toolchain ownership moves from a ServerState-only checkpoint to a
  contract runtime migration.
- Reusable vm-agent process creation and reuse gain one shared launch-spec
  builder; the runtime migration repository is the sole applied contract
  checkpoint.
- Connector, Git transport, and network-policy reconcilers become explicitly
  idempotent and reusable by setup and legacy migration paths.
- Existing sessions will perform a one-time migration-record adoption and may
  reconcile an idle Sprite or terminate an idle persistent agent process on
  their first readiness pass after rollout.
- No intended client-facing API change and no new external dependency.
