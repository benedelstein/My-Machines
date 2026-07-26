## Why

Opening an iOS agent session restores cached transcript messages immediately, but session presentation state remains empty until the socket delivers fresh state. Cache the small subset of session state needed to restore the screen consistently with its transcript while keeping live server state authoritative.

## What Changes

- Add a per-session SwiftData cache for curated client-state fields needed by the iOS session screen.
- Restore cached state before cached messages, then replace it when live session state arrives.
- Treat the cached client-state snapshot as canonical over overlapping session summary fields.
- Cache repository, status, setup-run state, agent settings, agent mode, pull request, pushed and base branches, and a derived responding flag.
- Continue using the session summary for title and as a fallback when no client-state snapshot exists.
- Persist the curated snapshot after relevant client-state mutations and when the session view disappears.
- Clear the new cache on sign-out and when its session is deleted.

## Capabilities

### New Capabilities

- `ios-session-state-cache`: Restore a curated per-session presentation snapshot before socket hydration and replace it with authoritative live state.

### Modified Capabilities

None.

## Impact

This affects the iOS Domain and Entities modules, SwiftData model registration, application dependency injection and cache reset, and the AgentSession view model lifecycle and tests. It does not change server APIs, wire contracts, or the existing session summary cache.
