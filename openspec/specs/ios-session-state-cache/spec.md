# ios-session-state-cache Specification

## Purpose
TBD - created by archiving change cache-session-client-state. Update Purpose after archive.
## Requirements
### Requirement: iOS persists a curated session-state snapshot

The iOS app SHALL persist a per-session presentation snapshot containing repository full name, session status, agent settings, agent mode, setup-run state, pull request state, pushed and base branches, and a derived responding flag. It MUST NOT persist raw `SessionClientState`, pending messages, active-turn identifiers, editor URLs, provider connection state, todos, plans, or errors.

#### Scenario: Curated state is saved
- **WHEN** an existing session receives repository, status, model settings, agent mode, setup, branch, responding, or pull request state
- **THEN** iOS stores those values in the snapshot identified by the session ID

#### Scenario: Transient live state is excluded
- **WHEN** live client state contains a pending message, active-turn ID, editor URL, provider connection state, todos, plans, or an error
- **THEN** those values are not written to the session-state snapshot

### Requirement: Cached client state is canonical over the session summary

iOS SHALL use restored client-state values instead of overlapping values from `SessionSummaryStore`. It SHALL continue to read the session title from the summary and SHALL use available summary values only when no client-state snapshot exists.

#### Scenario: Client state and summary disagree
- **WHEN** a cached client-state snapshot differs from the cached summary for status, provider, responding, branch, or pull request
- **THEN** the session screen presents the client-state snapshot value

#### Scenario: No client-state snapshot exists
- **WHEN** a session has a cached summary but no cached client-state snapshot
- **THEN** the session screen uses the available summary values until live client state arrives

#### Scenario: Session title is restored
- **WHEN** a cached session summary contains a title
- **THEN** the session screen presents that title because title is not part of client state

### Requirement: Cached state loads before cached messages

For an existing session, iOS SHALL load its cached session-state snapshot before loading cached transcript messages and before connecting the session socket. Draft sessions SHALL skip session-state restoration.

#### Scenario: Cached provider is available during transcript restoration
- **WHEN** a cached snapshot and cached messages exist for a session
- **THEN** iOS restores the snapshot first and builds the cached transcript with its agent provider settings

#### Scenario: Draft session opens
- **WHEN** the user opens a new session draft without a server session ID
- **THEN** iOS does not read or write a session-state snapshot

### Requirement: Server state replaces cached presentation state

After socket connection, iOS SHALL replace cached curated values with the corresponding values from complete live client state. A sync response SHALL replace the cached responding flag using the server-reported active-turn state, including clearing stale cached state.

#### Scenario: Live state replaces cached values
- **WHEN** any cached curated field differs from a received live client-state frame
- **THEN** the session screen and persisted snapshot use the live values

#### Scenario: Server reports no active turn
- **WHEN** cached state says the session is responding and a sync response reports no active turn
- **THEN** iOS clears the restored responding state and persists the inactive snapshot

### Requirement: Snapshot writes follow relevant state mutations

iOS SHALL save a session-state snapshot after mutations that can affect its curated values and SHALL save the latest value before view disappearance resets local response state.

#### Scenario: Curated presentation state changes
- **WHEN** live or local state changes a field included in the curated snapshot
- **THEN** iOS persists the current curated snapshot

#### Scenario: Session view disappears while responding
- **WHEN** the session view disappears while its presentation state is responding
- **THEN** iOS saves the responding snapshot before clearing local socket and response state

### Requirement: Session-state cache follows user and session cleanup

iOS SHALL clear all cached session-state snapshots on sign-out and SHALL clear a session's snapshot after that session is successfully deleted.

#### Scenario: User signs out
- **WHEN** the authenticated session ends
- **THEN** all cached session-state snapshots are deleted

#### Scenario: Session deletion fails
- **WHEN** deletion of a session fails on the server
- **THEN** iOS retains that session's cached state for the restored session summary

#### Scenario: Session deletion succeeds
- **WHEN** deletion of a session succeeds on the server
- **THEN** iOS deletes that session's cached state

