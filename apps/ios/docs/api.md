# API (networking)

All server communication goes through `Modules/API`. It is the transport
layer: it owns HTTP, auth headers, and the mapping from wire types to domain
types. Three packages are involved:

- `CoreAPI`: generated wire types (request/response shapes). Never edited by
  hand; regenerated from the Zod schemas in `packages/api-contract`.
- `API`: `APIClient`, `APIRequest`, and one API type per server surface
  (`SessionsAPI`, `ReposAPI`, ...). Depends on CoreAPI and Domain.
- `Domain`: the structs the rest of the app speaks.

## Anatomy of an endpoint

Each endpoint is a private `APIRequest` struct colocated with its API type:

```swift
private struct ListRepoEnvironments: APIRequest {
    typealias Response = ListRepoEnvironmentsResponse  // CoreAPI wire type

    var repoId: Int
    var headers: [String: String]

    var path: String { "repos/\(repoId)/environments" }
    var method: HTTPMethod { .get }
}
```

`Body` (for writes), `queryItems`, and `responseDecoder` are optional
associated requirements with defaults. `APIClient.fetch(_:)` encodes the typed
body, sends the request, and decodes the typed response. Non-2xx responses
throw `APIError` (`unauthenticated` on 401, otherwise `httpError` with the
server's code/message).

Each surface exposes a public `XxxAPIProviding` protocol (so features can be
tested against fakes) plus a concrete `XxxAPI` struct that holds the shared
`APIClient` and an `AuthTokenProviding`. Authed requests attach
`try await tokenProvider.bearerHeaders()`. Both are wired in
`ApplicationComponent`. See [`auth.md`](auth.md) for session restoration,
Keychain storage, access-token refresh, and the UI auth state machine.

## Return domain structs

Public API methods return `Domain` structs (or small `Sendable` structs
composed of them, such as `SessionSummaryPage`), never CoreAPI wire types.
Wire types must not escape `Modules/API` — that is a layering invariant, see
`ARCHITECTURE.md`.

Map at the boundary with a computed property on the CoreAPI type, next to the
API that uses it:

```swift
extension CoreAPI.RepoEnvironment {
    var domainEnvironment: Domain.RepoEnvironment {
        Domain.RepoEnvironment(id: id, repoId: repoId, name: name, updatedAt: updatedAt)
    }
}

public func listEnvironments(repoId: Int) async throws -> [Domain.RepoEnvironment] {
    try await client.fetch(ListRepoEnvironments(
        repoId: repoId,
        headers: tokenProvider.bearerHeaders()
    )).environments.map(\.domainEnvironment)
}
```

Guidelines:

- The domain struct carries only the fields callers actually use; drop the
  rest at the boundary (server-only config stays server-side).
- Requests may take CoreAPI types as *input* where the shape is the wire
  contract itself (e.g. `CreateSessionRequest`), but responses are mapped.
- Larger mappings get their own file (see `SessionSummaryMapping.swift`).
- Some older methods still return wire types. Do not copy that pattern for
  new endpoints; migrate existing ones opportunistically when touching them.

## Cursor pagination

Map cursor-paginated responses to `CursorPage<Value>` in the API module. A
page keeps its returned values and the cursor that fetches the following page;
nested pagination uses nested pages. For example, the session list returns a
`CursorPage<SessionRepoPage>`, and each repository contains a
`CursorPage<SessionSummary>`.

Keep cursor ownership with its page instead of flattening the response and
storing cursors separately. This prevents repository and per-repository
session cursors from being mixed up.

## Adding an endpoint checklist

1. If the shape is new, add/adjust the schema in `packages/api-contract/src/`
   and regenerate with `pnpm --filter @repo/api-contract codegen`
   (`docs/api-type-codegen.md` at the repo root).
2. Add a private `APIRequest` struct in the surface's API file.
3. Add the method to the `XxxAPIProviding` protocol and concrete type,
   returning a Domain struct and mapping the response at the boundary.
4. For a new surface, wire the API type in `ApplicationComponent`.
