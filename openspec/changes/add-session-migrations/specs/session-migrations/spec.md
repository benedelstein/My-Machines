## ADDED Requirements

### Requirement: Transactional local state migrations
The system SHALL apply versioned Durable Object-local schema and data migrations
before normal application reads and SHALL record each repository version only in
the same successful SQLite transaction as its effect.

#### Scenario: A stored JSON shape is transformed
- **WHEN** a registered local migration runs against a stored JSON row at an older repository version
- **THEN** the migration SHALL parse the historical shape as `unknown`, transform only the fields that changed, validate the result against that state's current schema, update the row, and record the new repository version atomically

#### Scenario: Local migration fails validation
- **WHEN** a local JSON transformation cannot produce valid current state
- **THEN** the system SHALL roll back the data update and SHALL NOT record that repository version

#### Scenario: Stored state is already at the current shape
- **WHEN** every live session already stores a given state at its current shape
- **THEN** the system SHALL register no migration step for it and SHALL rely on that state's own schema and read-time defaults, rather than shipping a whole-shape normalization step that only persists what each read already computes

#### Scenario: Reading a row that fails validation
- **WHEN** application code reads a stored JSON row it cannot validate
- **THEN** the read path SHALL NOT throw during Durable Object construction, because a constructor failure leaves the session unreachable and unrecoverable; validation that can reject a row belongs in a migration, where a throw rolls the transaction back

#### Scenario: Repository migrations are reordered
- **WHEN** an implementation attempts to remove or reorder an existing repository migration array entry
- **THEN** tests and review SHALL treat that change as invalid because repository migration indexes are append-only history

### Requirement: Agents SDK client state migrates before hydration
The system SHALL adapt the Agents SDK-owned client-state SQLite row to the local
repository migration runner without using that adapter for normal client-state
reads, writes, or broadcasts.

#### Scenario: Historical client state exists
- **WHEN** a Durable Object starts with an older client-state row in `cf_agents_state` and a client-state migration step is registered
- **THEN** construction SHALL migrate and validate that row before code hydrates `this.state`, constructs services that read client state, or creates a socket snapshot

#### Scenario: No client-state migration is registered
- **WHEN** every live session already stores client state at its current shape
- **THEN** the adapter SHALL register no migration step, SHALL rewrite no row and record no version, and SHALL exist as the registration point where a future surgical step is appended

#### Scenario: New session has no SDK state row
- **WHEN** a registered client-state migration runs on a Durable Object without the SDK client-state row
- **THEN** that step SHALL no-op while its repository version is still recorded, without creating or broadcasting state, and the SDK SHALL initialize current state normally

#### Scenario: Migration code broadcasts
- **WHEN** a client-state migration step runs during construction
- **THEN** it SHALL NOT write state through the SDK or broadcast, because migration precedes any connection

#### Scenario: SDK storage contract changes
- **WHEN** the pinned Agents SDK no longer creates the expected table, row ID, or compatible constructor ordering
- **THEN** an integration contract test SHALL fail before deployment

### Requirement: One runtime migration engine supports two revision strategies
The system SHALL use one `RuntimeMigrationCoordinator`, one registry, one
runtime-boundary concurrency model, and one per-session
`RuntimeMigrationRepository` for both
versioned and contract runtime migrations.

#### Scenario: Versioned migration is declared
- **WHEN** a migration uses `defineVersionedRuntimeMigration` with a positive integer version
- **THEN** the coordinator SHALL treat that integer as the desired revision scoped to the migration ID

#### Scenario: Contract migration is declared
- **WHEN** a migration uses `defineContractRuntimeMigration`
- **THEN** the coordinator SHALL build its desired contract at runtime, canonicalize it, hash it, and treat the resulting SHA-256 digest as the desired revision

#### Scenario: New migration category is needed
- **WHEN** a future change installs a service, changes Git configuration, replaces a Sprite, modifies filesystem layout, or performs another external transition
- **THEN** it SHALL be expressible by choosing a versioned or contract declaration without changing the `RuntimeMigrationRepository` schema or adding a coordinator category

#### Scenario: Revision strategy changes for an existing ID
- **WHEN** code attempts to change a registered migration ID from versioned to contract or from contract to versioned
- **THEN** the coordinator SHALL fail the invariant rather than reinterpret persisted revision data

### Requirement: Runtime migration definitions are static and desired values are runtime-built
The system SHALL declare an explicit ordered registry in code while allowing each
contract definition to construct its desired value from current deployment
inputs and persisted per-session state.

#### Scenario: Readiness starts
- **WHEN** the coordinator evaluates registered migrations
- **THEN** it SHALL use the statically declared definitions and SHALL compute each desired revision from the current session context

#### Scenario: Registry order matters
- **WHEN** one migration must precede another
- **THEN** the registry SHALL encode and test that serial order without constructing a dependency graph

#### Scenario: New migration needs a particular position
- **WHEN** a future definition is inserted into the registry
- **THEN** its placement MAY be chosen explicitly while the relative order and IDs of existing definitions remain stable

#### Scenario: Migration execution begins
- **WHEN** a registered migration is pending
- **THEN** readiness SHALL await it serially before running later migrations or dispatching a turn

### Requirement: Coordinator outcomes have one meaning at every range boundary
The coordinator SHALL use `current`, `applied`, and `deferred_active_turn` as
its success-outcome union. A failure SHALL use the `Result` error branch rather
than a success outcome. Full-registry and targeted-prefix execution SHALL apply
the same exhaustive loop rule.

#### Scenario: Migration was already satisfied
- **WHEN** migration-record comparison skips a migration
- **THEN** `ensurePrepared` SHALL return `current` and range execution SHALL continue

#### Scenario: Migration is freshly applied
- **WHEN** apply succeeds, verifies its postcondition, and records the desired revision
- **THEN** `ensurePrepared` SHALL return `applied` and range execution SHALL continue

#### Scenario: Migration defers for an active turn
- **WHEN** a migration range begins while a turn is active
- **THEN** the range SHALL return `deferred_active_turn` before preparing any definition and SHALL NOT attach a migration ID to that range-level outcome

#### Scenario: A range applies one or more migrations
- **WHEN** every entry in the requested registry range is satisfied and at least one returned `applied`
- **THEN** the range SHALL return `applied`; otherwise it SHALL return `current`

### Requirement: Runtime migration repository records attempted and applied revisions
The system SHALL persist attempted and applied revisions as serialized
discriminated unions, status (`running`, `failed`, or `applied`), attempt count,
timestamps, and sanitized failure information per stable migration ID. The
repository SHALL parse the serialized columns into nullable `appliedRevision`
and non-null `attemptedRevision` domain values.

#### Scenario: Serialized version revision is read
- **WHEN** a revision column contains `{"kind":"version","version":2}`
- **THEN** the repository SHALL expose `{ kind: "version", version: 2 }`

#### Scenario: Serialized contract revision is read
- **WHEN** a revision column contains `{"kind":"contract","hash":"<sha256>"}`
- **THEN** the repository SHALL expose `{ kind: "contract", hash }`

#### Scenario: Serialized revision is malformed
- **WHEN** a revision column contains malformed JSON, an invalid revision member, mismatched applied/attempted kinds, or a kind that conflicts with the static migration definition
- **THEN** repository parsing SHALL fail with a typed boundary error before migration comparison or external work

#### Scenario: Missing migration succeeds
- **WHEN** a registered migration has no migration record
- **THEN** the coordinator SHALL record a running attempt, apply and verify the desired state, and record the desired revision as applied

#### Scenario: Desired contract changes
- **WHEN** the stored applied contract hash differs from the newly computed desired hash
- **THEN** the coordinator SHALL apply and verify the new desired contract before replacing the applied hash

#### Scenario: Desired version increases
- **WHEN** a versioned migration's stored version is lower than its desired version
- **THEN** the coordinator SHALL run its current idempotent apply function and record the higher version only after verification

#### Scenario: Code rollback sees a higher stored version
- **WHEN** a versioned migration's stored version is greater than the version desired by rolled-back code
- **THEN** the coordinator SHALL treat the migration as already applied, SHALL NOT run the older imperative transition, and SHALL emit a distinct lifecycle event so the mixed-version or rollback state is visible

#### Scenario: Worker stops after an external effect
- **WHEN** a migration record remains running because execution stopped before success was recorded
- **THEN** a later pass SHALL retry the idempotent migration and verify the desired revision

#### Scenario: Migration fails
- **WHEN** apply or migration-specific verification fails
- **THEN** the coordinator SHALL retain the prior applied revision, record the attempted revision and sanitized failure, and leave the desired revision pending

#### Scenario: Migration is current
- **WHEN** status is applied and the applied revision satisfies the desired revision
- **THEN** the coordinator SHALL skip apply without making a Sprite or connector request

#### Scenario: Applied revision is the sole checkpoint
- **WHEN** the repository's applied revision is current
- **THEN** the system SHALL trust the last verified apply and SHALL NOT compare a second process, connector, or toolchain hash or periodically contact the external system

#### Scenario: External state drifts without a desired-revision change
- **WHEN** an external resource changes or disappears after its desired revision was recorded as applied
- **THEN** the initial coordinator SHALL NOT automatically reapply that revision; a future repair trigger requires its own explicitly designed producer and recovery contract

### Requirement: Contract hashing is deterministic and secret-safe
The system SHALL hash canonical JSON with a migration-ID domain separator and
SHALL persist only the final hash rather than the desired contract preimage.

#### Scenario: Object key order differs
- **WHEN** two contract objects contain the same JSON values with different object insertion order
- **THEN** canonicalization SHALL produce the same contract hash

#### Scenario: Contract contains an unsupported value
- **WHEN** a contract builder returns `undefined`, a function, a non-finite number, `Date`, `Map`, `Set`, `BigInt`, or another non-JSON value
- **THEN** preparation SHALL fail before an attempt record or external effect

#### Scenario: Future contract input requires rotation detection
- **WHEN** a future contract input must reflect rotation of a secret value
- **THEN** the contract SHALL include a stable `SecretFingerprint` and SHALL NOT contain or persist the raw secret

#### Scenario: Credential material is present at launch
- **WHEN** process launch uses a legacy bearer webhook token, a connector-held webhook credential, or provider credentials
- **THEN** the initial contract SHALL exclude that credential material and SHALL NOT automatically restart the process solely because it changed

#### Scenario: Migration emits logs
- **WHEN** a contract migration is prepared, applied, deferred, or fails
- **THEN** logs and migration records SHALL omit contract preimages, raw secrets, and unsanitized integration output

### Requirement: Migration apply includes postcondition verification
The system SHALL record an applied runtime revision only when the
migration-specific `apply` function has completed its external effects and
verified its postcondition.

#### Scenario: External effect succeeds but readback disagrees
- **WHEN** an API mutation returns success but the observable external state does not match the desired contract
- **THEN** the migration SHALL return failure and SHALL NOT advance the applied revision

#### Scenario: Verification requires asynchronous external work
- **WHEN** verification requires connector readback, Sprite execution, file hashing, service status, or process termination
- **THEN** the migration's asynchronous `apply` SHALL own that verification rather than exposing a generic coordinator `verify` callback

#### Scenario: Verification does not require network traffic
- **WHEN** a migration can verify local Git configuration or file contents on the Sprite
- **THEN** it SHALL use those observations and SHALL NOT ping an application URL merely to prove reachability

### Requirement: Stored setup runs are immutable
The system SHALL create new setup runs from one canonical ordered task
definition and SHALL treat every stored run's task array as an immutable
historical snapshot.

#### Scenario: New setup run is built
- **WHEN** a session starts setup after a new task definition is deployed
- **THEN** its run SHALL contain the current definitions in canonical order

#### Scenario: Incomplete run lacks a new task
- **WHEN** an incomplete stored run predates a newly declared setup task
- **THEN** restart repair SHALL preserve its original task array, resume only its stored tasks, and apply later requirements through runtime migrations after terminal success

#### Scenario: Completed run lacks a new task
- **WHEN** a completed stored run predates a newly declared task
- **THEN** the system SHALL leave the run completed and SHALL use runtime migrations

#### Scenario: Existing task needs a new prerequisite
- **WHEN** current code requires a new prerequisite for an old stored task to finish
- **THEN** that task executor SHALL reconcile the prerequisite idempotently without inserting, deleting, or reordering stored tasks

### Requirement: Setup uses targeted migration ensure rather than pre-completion
The system SHALL let setup call
`runtimeMigrationCoordinator.ensureMigration(id, context, lease)` and SHALL restrict
`RuntimeMigrationRepository` writes to the coordinator. Setup SHALL pass the
opaque runtime-boundary lease already held by readiness rather than acquiring
the non-reentrant mutex again.

#### Scenario: Setup task owns a complete migration postcondition
- **WHEN** a setup task reaches the earliest point where a migration can be fully applied and verified
- **THEN** it SHALL call `ensureMigration(id, context, lease)`, the coordinator SHALL ensure the registry prefix through that ID, and the task SHALL complete only after the call reports current/applied

#### Scenario: Earlier migration is pending
- **WHEN** setup targets a later migration ID
- **THEN** `ensureMigration(id, context, lease)` SHALL first ensure every earlier registry entry, continue after both `current` and `applied`, and stop before the target only if an earlier entry fails or defers

#### Scenario: Setup point cannot satisfy an earlier migration
- **WHEN** a targeted ID's registry prefix contains a migration whose prerequisites do not yet exist
- **THEN** the registry/setup integration SHALL be treated as invalid and reordered or regrouped rather than bypassing the earlier migration

#### Scenario: Migration spans multiple setup tasks
- **WHEN** no single early task can satisfy the full migration postcondition
- **THEN** earlier tasks MAY call shared low-level reconcilers but SHALL call `ensureMigration(id, context, lease)` only once the complete postcondition is satisfiable

#### Scenario: Session is merely created
- **WHEN** a new session has not performed a migration's external work
- **THEN** the system SHALL NOT pre-stamp that migration as applied

#### Scenario: Setup effect succeeds before interruption
- **WHEN** setup performs an external effect but stops before the repository records success
- **THEN** the next targeted or normal runtime pass SHALL repeat idempotently and verify it

#### Scenario: Migration record succeeds before setup task completion
- **WHEN** the coordinator records the applied revision but setup stops before marking the task complete
- **THEN** the retried task SHALL observe the current revision, avoid duplicate mutation, and complete

#### Scenario: New Sprite already satisfies a migration
- **WHEN** the Sprite image already contains the required binary or local service
- **THEN** apply SHALL verify the existing state, return success without unnecessary installation, and allow the coordinator to record the revision

### Requirement: Runtime boundary serializes readiness with the turn claim
The system SHALL use one application-level runtime-boundary mutex to serialize
readiness external mutation, targeted setup migration execution, and the
synchronous transition from idle state to `beginTurn()`. The mutex SHALL yield
an opaque branded lease required by private readiness and mutating coordinator
methods that assume boundary ownership.

#### Scenario: Background dispatch is called concurrently
- **WHEN** multiple init or connection events call `ensureRuntimeReadyAndDispatchNextTurn()` while one call is in flight
- **THEN** each call SHALL queue on the same runtime-boundary mutex and the later call SHALL re-evaluate current state after acquiring it

#### Scenario: Earlier readiness made every migration current
- **WHEN** a queued dispatch call acquires the mutex after an earlier successful readiness pass
- **THEN** it SHALL rerun the pipeline and normally skip migration apply through local migration-record equality without external calls

#### Scenario: Direct chat preparation yields
- **WHEN** attachment or message preparation awaits before a direct chat starts
- **THEN** preparation SHALL avoid state mutation, the admission orchestrator SHALL enter the shared runtime-boundary mutex afterward, recover an interrupted claim, call private `_ensureReady(lease, preparedInputs)`, and synchronously claim the turn without another await between the ready decision and active-turn persistence

#### Scenario: Direct chat already owns the boundary
- **WHEN** direct chat needs to run readiness while holding the non-reentrant runtime mutex
- **THEN** the admission orchestrator SHALL pass the current lease to private `_ensureReady(lease, ...)` and SHALL NOT acquire a second mutex

#### Scenario: Chat arrives during a migration
- **WHEN** readiness mutation already owns the runtime boundary
- **THEN** chat SHALL wait, rerun readiness after acquiring the mutex, and begin only after required migration work is current

#### Scenario: Runtime boundary is released before process spawn completes
- **WHEN** the direct chat path has synchronously persisted `activeUserMessageId`
- **THEN** it MAY release the mutex before awaiting process spawn because later readiness observes the active turn and defers pending migration work

#### Scenario: Pending initial message is ready
- **WHEN** `_ensureReady(lease)` reports current state and `pendingUserMessage` exists
- **THEN** the admission orchestrator SHALL synchronously claim that pending turn inside the runtime boundary, release the boundary, and the dispatch orchestrator SHALL then perform process attach/spawn I/O

#### Scenario: Initialization runs
- **WHEN** `handleInit` mutates durable initialization state
- **THEN** it SHALL use `ctx.blockConcurrencyWhile` for initialization only and SHALL NOT wrap long runtime migrations in a global Durable Object concurrency block

#### Scenario: Setup calls targeted ensure inside readiness
- **WHEN** provisioning already owns the runtime-boundary mutex and calls `ensureMigration(id, context, lease)`
- **THEN** setup SHALL pass the current branded lease to targeted ensure, which SHALL NOT attempt to acquire the non-reentrant mutex again

#### Scenario: Coordinator mutation has no independent entry point
- **WHEN** code outside readiness or its nested setup execution needs runtime migration work
- **THEN** it SHALL queue the shared dispatch orchestrator rather than invoking a mutating coordinator method directly

#### Scenario: Ungated code calls an ownership-requiring method
- **WHEN** code attempts to call `_ensureReady(lease, ...)`, `ensureMigrations(context, lease)`, or `ensureMigration(id, context, lease)` without the current runtime-boundary lease
- **THEN** the TypeScript API SHALL reject the call at compile time

#### Scenario: Runtime behavior still needs verification
- **WHEN** code holds or receives a branded lease
- **THEN** focused tests SHALL still verify FIFO release and that nested paths do not reacquire the non-reentrant mutex

#### Scenario: Agent webhook arrives during regular readiness
- **WHEN** a chunk or event webhook arrives while the application runtime mutex is owned
- **THEN** webhook handling SHALL not acquire that mutex and SHALL remain dispatchable; only the existing `handleInit` `blockConcurrencyWhile` initialization window may globally gate events

### Requirement: Readiness has explicit stage order and outcomes
The system SHALL run initialization, setup/provisioning, and awaited runtime
migrations in that order and SHALL return a typed outcome. Admission SHALL use
that outcome as a prerequisite before claiming pending work, without an
ambiguous progress value.

#### Scenario: Setup remains incomplete
- **WHEN** provisioning does not reach terminal setup success
- **THEN** readiness SHALL return `setup_incomplete` or a typed failure and SHALL NOT run post-setup migrations or dispatch

#### Scenario: Migration defers
- **WHEN** readiness reaches runtime migrations while a turn is active
- **THEN** readiness SHALL return `deferred_active_turn` before preparing the registry and SHALL NOT run later stages

#### Scenario: Migration fails
- **WHEN** a runtime migration returns failure
- **THEN** readiness SHALL stop before later migrations and dispatch

#### Scenario: Pending initial message exists
- **WHEN** setup is complete and the migration range returns `current` or `applied`
- **THEN** the admission orchestrator SHALL claim the pending initial message within the runtime boundary and SHALL perform process attach/spawn after releasing that boundary

#### Scenario: Init handler returns
- **WHEN** durable session initialization succeeds
- **THEN** `handleInit` SHALL queue the shared readiness/admission/dispatch orchestrator through the Durable Object lifetime mechanism without awaiting provisioning or migration completion

### Requirement: Active turns defer the complete migration range
The system SHALL use persisted `activeUserMessageId` as the authoritative turn
state and SHALL check it once before preparing or iterating the requested
migration range.

#### Scenario: Active turn enters migration readiness
- **WHEN** `activeUserMessageId` is non-null
- **THEN** the coordinator SHALL return range-level `deferred_active_turn` without building contracts, reading migration records, recording attempts, or contacting the Sprite

#### Scenario: Every migration would already be current
- **WHEN** a turn is active and a later idle pass would find every migration current
- **THEN** the active pass SHALL still return `deferred_active_turn`; it SHALL prefer the coarse range-level gate over computing revisions during the turn

#### Scenario: Turn completion clears active state
- **WHEN** a terminal webhook clears `activeUserMessageId`
- **THEN** turn completion SHALL queue another readiness pass that evaluates the complete migration range while idle

#### Scenario: Webhook arrives while readiness is deferred
- **WHEN** an agent webhook belongs to the active turn
- **THEN** webhook handling SHALL remain outside the runtime-boundary mutex and SHALL be able to finish the turn

### Requirement: Startup toolchain is a contract runtime migration
The system SHALL move common and provider-specific startup-toolchain desired
state into one contract migration and SHALL remove the separate readiness-time
toolchain comparison after compatibility adoption.

#### Scenario: Toolchain contract matches
- **WHEN** the migration record's applied hash equals the desired provider/check contract hash
- **THEN** readiness SHALL make no Sprite request for the toolchain

#### Scenario: Toolchain input changes
- **WHEN** a minimum version, script URL, script version, repair script body, common check, or provider check changes
- **THEN** the desired contract hash SHALL change and existing sessions SHALL reconcile on the next eligible readiness pass

#### Scenario: Legacy ServerState checkpoint matches
- **WHEN** the runtime migration record is absent and the existing `startupToolchain.contractHash` equals the desired contract hash
- **THEN** the compatibility path SHALL adopt that verified revision into `RuntimeMigrationRepository` without a Sprite request

#### Scenario: Legacy checkpoint differs
- **WHEN** the migration record is absent and the existing checkpoint differs from desired
- **THEN** the contract migration SHALL run and verify the current checks before recording the new revision

#### Scenario: New setup reaches cloud container task
- **WHEN** the Sprite exists and the blocking cloud-container task is non-terminal
- **THEN** the executor SHALL ensure the startup-toolchain migration before repository clone and the environment startup script

#### Scenario: Old setup cloud task is terminal
- **WHEN** an immutable historical run already completed that task
- **THEN** the system SHALL NOT reopen it and SHALL reconcile the toolchain through post-setup readiness

### Requirement: Reusable agent process is governed by one launch contract
The system SHALL build one reusable process contract and paired concrete launch
input from all semantic values frozen at spawn and SHALL use the same prepared
values for readiness comparison and process creation.

#### Scenario: Bundle contents change
- **WHEN** the vm-agent bundle hash changes while an idle process exists
- **THEN** the process contract SHALL change, the old process SHALL be terminated, and the next dispatch SHALL write and run the new bundle

#### Scenario: Webhook environment changes
- **WHEN** webhook URL or authentication mode changes
- **THEN** the process contract SHALL change

#### Scenario: Webhook secret changes
- **WHEN** a legacy bearer webhook token or connector-held webhook credential changes
- **THEN** that change alone SHALL NOT alter the initial reusable-process contract

#### Scenario: Stable environment changes
- **WHEN** a process-frozen plain environment value, provider identity, command wrapper, working directory, or relevant deployment value changes
- **THEN** the process contract SHALL change

#### Scenario: Per-turn input changes
- **WHEN** process run ID, initial message path, user message ID, provider resume `agentSessionId`, or per-turn model/effort/mode changes
- **THEN** those values SHALL NOT change the reusable process contract

#### Scenario: Provider credentials rotate
- **WHEN** provider credentials are refreshed or rotated server-side
- **THEN** the reusable process contract SHALL NOT change and readiness SHALL NOT refresh provider credentials to build or compare it

#### Scenario: Dispatch spawns a new process
- **WHEN** dispatch cannot reuse an existing process
- **THEN** it SHALL refresh provider credentials server-side and pass the concrete snapshot to spawn outside the contract

#### Scenario: Existing process is reused after credential rotation
- **WHEN** a dispatch reuses an existing process after provider credentials rotated
- **THEN** the process MAY continue on its spawn-time credentials; delivering refreshed credentials to reused processes is a documented follow-up change outside this capability

#### Scenario: Applied process contract is current
- **WHEN** the migration record's applied process-contract hash equals the prepared desired hash
- **THEN** readiness SHALL trust that record and dispatch MAY reuse the persisted process without comparing a second process-contract hash

#### Scenario: Desired process contract differs from the migration record
- **WHEN** no turn is active and the migration record's applied process-contract hash differs from the prepared desired hash
- **THEN** the migration SHALL terminate any existing process, clear process ID and run ID together, preserve `agentSessionId`, record the desired revision only after verified termination, and SHALL NOT spawn from readiness

#### Scenario: Process migration has no migration record
- **WHEN** a legacy session has an existing process but no applied process-contract revision
- **THEN** first apply SHALL treat the process contract as unknown and terminate the process before recording the desired revision

#### Scenario: Process termination fails
- **WHEN** SIGTERM fails for a reason other than the process already being gone
- **THEN** termination SHALL return a typed failure and readiness SHALL abort without recording the desired process revision as applied

#### Scenario: Process is already gone
- **WHEN** termination reports a 404-equivalent absence
- **THEN** the system SHALL clear process metadata and continue as `already_gone`

#### Scenario: New process starts
- **WHEN** dispatch spawns from prepared launch inputs
- **THEN** it SHALL use the exact inputs paired with the already-applied desired revision and SHALL persist process ID and process run ID through the existing process lifecycle path without writing a second contract hash

### Requirement: Session environment snapshots remain authoritative
The system SHALL build environment-derived contracts from the persisted session
environment snapshot and SHALL NOT automatically read mutable source environment
configuration during readiness.

#### Scenario: Source environment changes after session creation
- **WHEN** the D1 source environment's network or plain environment values are edited
- **THEN** the existing session's desired contracts SHALL remain based on its persisted snapshot

#### Scenario: Future feature updates the session snapshot
- **WHEN** authorized future code updates the Durable Object's persisted session snapshot
- **THEN** the next readiness pass SHALL naturally derive new relevant contract hashes and reconcile them

### Requirement: Network policy is contract-based and mutation-confirmed
The system SHALL hash the desired normalized network policy derived from the
session snapshot, provider, Worker/gateway hosts, and deployment policy inputs.

#### Scenario: Allowed policy input changes
- **WHEN** a persisted snapshot or deployment-owned default policy input changes
- **THEN** the desired network-policy hash SHALL change and the Sprite policy SHALL be reapplied

#### Scenario: Network policy is unchanged
- **WHEN** the applied hash matches the normalized desired policy
- **THEN** readiness SHALL not contact the Sprite network-policy API

#### Scenario: Network policy mutation succeeds
- **WHEN** policy apply succeeds
- **THEN** the successful provider response SHALL be the apply postcondition, including a no-content response, and readiness SHALL NOT add policy readback or ping an allowed endpoint

### Requirement: Connector desired state is contract-based and identity-independent
The system SHALL hash functional connector desired state, including base URL,
test URL, required Sprite labels, and endpoint policy, without treating an
allocated connector ID or the unrotated webhook token as desired configuration.

#### Scenario: Connector ID checkpoint exists
- **WHEN** `sessionConnectorId` is present
- **THEN** the reconciler SHALL treat it as a hint, read external connector state, and verify it before trust

#### Scenario: Connector policy changes
- **WHEN** allowed endpoints, blocked endpoints, or required labels change
- **THEN** the contract hash SHALL change and the reconciler SHALL update and read back the replacement policy

#### Scenario: Webhook token is needed before minting
- **WHEN** the connector migration's apply runs for a session without a webhook token
- **THEN** apply SHALL ensure the token exists as a local Durable Object write before creating the connector, and the token SHALL NOT participate in the desired contract hash

#### Scenario: Connector is discovered after an interrupted create
- **WHEN** provider readback cannot reveal the stored credential
- **THEN** the reconciler SHALL adopt the discovered connector only when durable attempt metadata ties it to the same desired revision, and otherwise SHALL replace the unverifiable connector

#### Scenario: Connector base URL changes
- **WHEN** the desired base URL changes and the provider cannot update it in place
- **THEN** the reconciler SHALL replace rather than incorrectly marking the old connector current

#### Scenario: Connector name or ID changes incidentally
- **WHEN** allocated identity differs but functional desired state and verified ownership are correct
- **THEN** incidental identity SHALL NOT alone change the contract hash

#### Scenario: External, D1, and ServerState disagree
- **WHEN** connector sources disagree
- **THEN** verified external state SHALL be authoritative, D1 SHALL be rewritten as a mirror, and ServerState SHALL be checkpointed last

#### Scenario: Connector verification runs
- **WHEN** connector reconciliation completes
- **THEN** it SHALL use provider readback and SHALL NOT ping the configured base URL

### Requirement: Historical Git changes use versioned migrations
The system SHALL express the initial existing-clone Git connector cutover and
future arbitrary Git transport transitions as idempotent versioned migrations
unless a future design deliberately introduces recurring Git desired state.

#### Scenario: Legacy repository already exists
- **WHEN** the ephemeral-token cutover runs against an already-cloned repository
- **THEN** it SHALL inspect and repair remotes, helper file contents, and credential configuration before switching persisted authentication mode

#### Scenario: Helper bundle changes
- **WHEN** a helper-content change must be applied to existing sessions
- **THEN** the change SHALL use a new migration ID or a safe version increase whose current apply can converge from every earlier version

#### Scenario: Git returns to direct connector URL
- **WHEN** a future deployment removes the helper and uses a direct connector URL
- **THEN** a new versioned migration SHALL set the direct URL, remove helper-specific configuration, verify local Git state, and coexist with the previously applied cutover history

### Requirement: Future Sprite-local services fit either revision strategy
The system SHALL allow a future local service to use a contract migration for
its current bundle/configuration and versioned migrations for required
historical data or layout transitions.

#### Scenario: Local service is introduced
- **WHEN** a deployment requires a Sprite-local communication service
- **THEN** a contract migration MAY hash its bundle, service definition, protocol version, and configuration and SHALL install/start/verify it idempotently

#### Scenario: Service data requires ordered transition
- **WHEN** a service upgrade requires one-time persistent-data migration
- **THEN** a versioned migration SHALL perform that transition before the new service contract is applied

#### Scenario: Service is removed
- **WHEN** a future deployment no longer wants the service
- **THEN** the design SHALL transition the old contract to desired absence or use a versioned uninstall and retire/tombstone the old recurring definition so it cannot reinstall legacy state

### Requirement: Deployment phases isolate orchestration risk from migration activation
The system SHALL be implemented and activated through separate production
phases. A phase SHALL pass its verification and observation gate before the next
phase registers additional runtime behavior, and adjacent phases SHALL NOT have
their first production activation in the same deployment.

#### Scenario: Phase 1 deploys local migration support
- **WHEN** constructor-time Durable Object and Agents SDK state migration support first ships
- **THEN** it SHALL use additive or dual-read-compatible persistence and SHALL NOT introduce the runtime mutex, runtime migration repository, production registry, or external reconciliation behavior

#### Scenario: Phase 2 deploys the readiness race fix
- **WHEN** the runtime-boundary mutex, branded lease, private readiness body, and readiness-to-turn claim refactor first ship
- **THEN** no runtime migration type, runtime migration repository, registry, setup targeted ensure, or external runtime migration effect SHALL be active, and the phase SHALL be independently deployable and rollbackable

#### Scenario: Phase 2 readiness executes
- **WHEN** `_ensureReady(lease)` runs before the runtime migration engine is deployed
- **THEN** it SHALL perform initialization, provisioning/setup, and turn admission only and SHALL NOT call a runtime migration coordinator

#### Scenario: Phase 2 Worker stops after claiming a turn
- **WHEN** `activeUserMessageId` becomes durable but the Worker stops before dispatch is confirmed
- **THEN** the next readiness pass SHALL reconcile the claimed-turn state before treating it as a live active turn, and SHALL NOT leave turn admission or future migrations permanently blocked

#### Scenario: Phase 3 deploys the runtime engine dark
- **WHEN** revision types, hashing, `RuntimeMigrationRepository`, coordinator, and observability first ship
- **THEN** the production registry SHALL be exactly empty and readiness SHALL produce no runtime migration records or Sprite, connector, process-manager, setup-targeted-ensure, or network-policy calls

#### Scenario: Phase 4 activates the first adopter
- **WHEN** runtime migration behavior first activates in production
- **THEN** the registry SHALL contain exactly `sprite.startup-toolchain`, setup history SHALL remain immutable, and connector, Git, network, and reusable-process definitions SHALL remain unreachable

#### Scenario: Phase 5 activates session networking adopters
- **WHEN** connector, Git cutover, and network-policy reconciliation activate
- **THEN** the registry SHALL be ordered as startup toolchain, connector resource, Git cutover, and network policy, and `agent.reusable-process` SHALL remain unregistered

#### Scenario: Phase 6 activates reusable-process reconciliation
- **WHEN** the earlier adopter cohorts have passed their observation gates
- **THEN** `agent.reusable-process` SHALL be appended after the unchanged Phase 5 registry prefix and SHALL be the first phase allowed to terminate an idle process solely because its desired launch contract changed

#### Scenario: An adopter first activates
- **WHEN** a phase registers production migration definitions for the first time
- **THEN** destructive cleanup of compatibility state SHALL remain disabled until a later deployment after the rollback window

#### Scenario: A phase is rolled back
- **WHEN** application code rolls back to the preceding phase
- **THEN** additive tables and migration records MAY remain, preceding code SHALL ignore them safely, and already-applied versioned external work SHALL be corrected only through a forward compensating migration

#### Scenario: A phase attempts to activate later definitions early
- **WHEN** the production registry differs from the exact snapshot assigned to the current deployment phase
- **THEN** registry tests SHALL fail and deployment SHALL stop before external reconciliation begins

### Requirement: Forward-compatible rollout and compensation
The system SHALL preserve forward-only local/version history and SHALL stage
contract changes whose rollback cannot safely reconcile to an older desired
state.

#### Scenario: Persisted field is removed
- **WHEN** a server or client-state field will be renamed or deleted
- **THEN** rollout SHALL first introduce an additive or dual-read compatible shape before a later local migration removes the old representation

#### Scenario: Applied versioned migration is faulty
- **WHEN** some sessions have already recorded a faulty historical migration
- **THEN** correction SHALL use a new compensating migration ID rather than reusing its completed meaning

#### Scenario: Contract code rolls back
- **WHEN** rolled-back code computes the previous contract hash
- **THEN** the coordinator MAY reconcile the previous desired state, and any change that cannot safely do so SHALL use preparation, cutover, observation, and cleanup stages

#### Scenario: Contract is superseded
- **WHEN** a new design replaces state previously enforced by a contract migration
- **THEN** rollout SHALL retire/tombstone or safely supersede the old definition so late-waking sessions do not reapply conflicting state

### Requirement: Runtime migration failures are observable and secret-safe
The system SHALL emit structured lifecycle events for prepared, pending,
current, running, applied, failed, deferred, interrupted-retry, and
newer-version-skip states without exposing secret material.
`pending` and `running` are observability/migration-record vocabulary, not additional
coordinator return outcomes.

#### Scenario: Migration repeatedly fails
- **WHEN** attempt count exceeds the configured operator threshold
- **THEN** the session and migration ID SHALL become operator-visible with bounded retry/backoff information

#### Scenario: Failure includes integration output
- **WHEN** an integration error contains request bodies, stdout, stderr, URLs, or credentials
- **THEN** the repository SHALL store only a bounded sanitized error code/message and structured logs SHALL follow the same secret policy

#### Scenario: Session teardown begins
- **WHEN** teardown owns Sprite and connector cleanup
- **THEN** readiness SHALL not begin new runtime migration attempts
