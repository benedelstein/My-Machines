# Runtime Migrations

Runtime migrations reconcile per-session state that cannot be changed atomically
with Durable Object SQLite, such as Sprite files, connector configuration, and
process state. They are separate from constructor-time repository migrations and
deployment-managed D1 migrations.

Phase 5 registers `sprite.startup-toolchain`, `session.connector-resource`,
`sprite.git-ephemeral-token-cutover`, and `sprite.network-policy` in that order.
Readiness reconciles them after terminal setup and before admitting the next
turn. `agent.reusable-process` remains inactive until Phase 6, so Phase 5 never
terminates an idle process solely because a launch contract changed.

## Declaration API

Use a versioned migration for an idempotent historical transition. Its version
is scoped to one stable migration ID. A version bump may skip intermediate
implementations, so the current `apply` must converge from every lower stored
version. Use separate ordered IDs when every intermediate transition must run.

```ts
defineVersionedRuntimeMigration({
  id: "sprite.git-direct-connector-url",
  description: "Replace the helper flow with a direct connector remote",
  version: 1,
  apply: async ({ context }) => {
    await reconcileDirectConnectorRemote(context);
    return success(undefined);
  },
});
```

Use a contract migration for deployment-owned desired state. The helper builds
the contract at runtime, hashes canonical JSON with the migration ID, and passes
the same in-memory contract object to `apply`.

```ts
defineContractRuntimeMigration({
  id: "sprite.helper-bundle",
  description: "Keep the helper bundle current",
  buildContract: (context) => ({
    schema: 1,
    bundleHash: context.bundles.helperHash,
    installPath: "/opt/my-machines/helper",
  }),
  apply: async ({ context, desired }) => {
    await installAndVerifyHelper(context, desired);
    return success(undefined);
  },
});
```

For a one-time helper bundle update, append a new stable ID such as
`sprite.helper-bundle-v2`. A scoped version bump on an existing versioned ID is
also valid only when its current apply can converge directly from every lower
stored version.

A future local Sprite service can pair an ordered versioned data/layout
migration with a later contract migration:

```ts
defineVersionedRuntimeMigration({
  id: "sprite.local-service-data-v2",
  description: "Upgrade local service data to layout v2",
  version: 1,
  apply: migrateAndVerifyLocalServiceData,
});

defineContractRuntimeMigration({
  id: "sprite.local-service",
  description: "Keep the local session service current",
  buildContract: (context) => ({
    schema: 1,
    bundleHash: context.bundles.localServiceHash,
    serviceDefinitionHash: context.bundles.serviceDefinitionHash,
    protocolVersion: context.protocolVersion,
  }),
  apply: installStartAndVerifyLocalService,
});
```

The registry is a static serial list. A targeted setup ensure executes the
registry prefix through its target; it never bypasses an earlier definition.
The caller passes a compile-time-only lease proving that it already owns the
runtime-boundary mutex, and the coordinator never acquires that mutex itself.

## Persistence and retry

`session_runtime_migrations` retains both the prior applied revision and the
current attempted revision. An interrupted `running` record is retry evidence,
not a lock. Apply functions must be idempotent and return success only after
verifying their postcondition.

Retries use bounded exponential backoff: one second initially, capped at five
minutes. Five attempts marks the structured lifecycle event for operator
attention. The repository remains CRUD-only; a future operator-visible query
surface will expose pending and failed records without leaking contract inputs.

Structured telemetry uses lifecycle `event` values rather than calling every
state an outcome. An interrupted `running` record emits `interrupted_retry` when
retried. A higher stored version emits `newer_version_skipped`: it is safely
skipped during rolling deployment or rollback, but remains visible because old
code is running against state previously touched by newer code. The event
includes both the desired and higher applied versions.

## Security

Contracts may contain JSON values only. Contract preimages are never persisted
or logged. High-entropy secrets that must affect desired state use
`fingerprintHighEntropySecret`; low-entropy secrets use an authority-owned
durable version (or a future keyed fingerprint), never plain SHA-256. Migration
errors store a bounded, sanitized message and logs exclude integration output.

## Evolution and rollback

- Never reuse an ID for unrelated work or change its revision strategy.
- Higher stored versions remain current after application rollback; correct a
  faulty versioned migration with a new compensating ID.
- Contract rollback may reconcile the old desired hash. Destructive changes
  need additive preparation, cutover, observation, and later cleanup phases.
- When replacing a recurring contract, first move it to desired absence,
  explicitly supersede it, or retain a retired/tombstone definition for
  late-waking sessions. Do not leave an old definition able to reinstall state.
- Removing a helper bundle uses a new versioned uninstall migration; changing a
  bundle under continuing desired-state ownership changes its contract hash.

No runtime migration begins after session teardown starts. An active user turn
defers the complete requested range before contract construction or repository
reads; terminal webhook handling queues readiness again after the turn clears.
