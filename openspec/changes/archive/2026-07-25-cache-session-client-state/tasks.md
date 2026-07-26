## 1. Cached state model

- [x] 1.1 Add the curated per-session Domain snapshot with repository, status, agent settings, agent mode, setup run, pull request, pushed and base branches, and responding flag.
- [x] 1.2 Add its SwiftData entity and observable entity model, register the additive model in the current schema, and use the shared `EntityStore` for load, save, delete, and delete-all operations.
- [x] 1.3 Add Entities tests for flat field mapping, snapshot round trips, replacement including cleared optionals, deletion, and reopening an existing on-disk cache with the new model.

## 2. Dependency and cache lifecycle wiring

- [x] 2.1 Expose one shared session-state cache store through the application, Home, and AgentSession Needle dependencies.
- [x] 2.2 Clear all session-state snapshots from `CacheResetAction` and clear the matching snapshot only after a session deletion succeeds.

## 3. Agent session restoration

- [x] 3.1 Load cached session state before cached messages and socket connection for existing sessions, while skipping the cache for drafts.
- [x] 3.2 Restore cached client-state fields as canonical, while continuing to read title and missing-snapshot fallback values from the existing session summary.
- [x] 3.3 Replace restored values from live state and sync responses, and persist curated snapshots after relevant mutations.
- [x] 3.4 Save the latest snapshot before `unbind()` resets local responding and socket state.

## 4. Regression coverage and verification

- [x] 4.1 Add AgentSession tests for cache-first field restoration, precedence over overlapping summary values, title and missing-cache summary fallback, live replacement, inactive sync clearing, draft exclusion, and disappear-time saving.
- [ ] 4.2 Run Entities tests, SwiftLint fix and strict checks, the generic iOS simulator build, and the repository build, lint, typecheck, and test commands.
