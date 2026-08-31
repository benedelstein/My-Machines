# Authentication Flow

## Overview

GitHub OAuth via a GitHub App. The API server owns one sign-in state machine
for every client; each client only starts an attempt and later claims the
completed identity with its own credential type. Web receives an opaque session
token that the Next.js BFF stores in an HTTP-only cookie, so the token never
touches client-side JavaScript. iOS receives an access/refresh pair.

The production GitHub App's "User authorization callback URL" is
`https://api.mymachines.dev/auth/callback` — pinned to the api-server, not the
web app. The api-server owns OAuth state, exchanges the authorization code
itself, and decides where the browser goes next. This is how sign-in works on
Vercel preview branches as well as prod.

Local GitHub Apps used for development can point at a tunnel URL for the web
dev server. The web app accepts `/auth/callback` as a compatibility bridge and
`/api/auth/callback` through the API proxy; both forward to the api-server and
preserve its redirect response.

## Sign-in attempts

A `sign_in_attempts` row carries the identity transition from "browser left for
GitHub" to "this client issued its session". It records:

| Field | Meaning |
|-------|---------|
| `id` | Non-secret attempt id; travels on client callback URLs. |
| `client_type` | `web` or `native`, set by the start route, never by a request field. |
| `claim_token_hash` | SHA-256 of the raw claim token, which is returned exactly once to the initiating adapter. |
| `completion_code_hash` | SHA-256 of the raw one-time code issued only at the final browser handoff. |
| `status` | `awaiting_oauth` → `identity_ready` → `completion_ready` → `claimed`, or `failed`. |
| `user_id` | Populated after the OAuth exchange. |
| `completion_target` | Web: the allowlisted origin. Native: the allowlisted custom-scheme URI. |
| `return_to` | Web only: validated relative application path. |
| `install_url` | Set when the OAuth callback chained GitHub App installation. |
| `expires_at` | Fixed at creation and never extended by a state transition. |

Lifetimes:

- Web attempts: 10 minutes. Web claims its session immediately after OAuth.
- Native attempts: 30 minutes. One `ASWebAuthenticationSession` has to cover
  OAuth, repository selection, and an organization-approval request.
- OAuth state rows: 10 minutes. Installation callback state: 30 minutes.

`status` never reflects installation progress: installation is a repository
grant, not an authentication step.

### Claim security

Completion requires two independent bearer proofs: the initiating adapter's
`claimToken` and the final callback's `completionCode`. Neither alone can issue
a session, so transferring an authorization URL does not transfer the starter's
ability to claim the callback receiver's identity.

- Completion verifies both stored hashes with constant-time comparisons before
  disclosing status. Any mismatch, pending/failed state, expiry, wrong client,
  or replay returns `INVALID_SIGN_IN_ATTEMPT`.
- The claim is consumed by a conditional `UPDATE ... WHERE status =
  'completion_ready' RETURNING`, so concurrent or repeated completions can issue
  at most one session.
- Claim tokens never appear in redirect URLs or logs. Completion codes appear
  only in the necessary final callback, are never persisted raw, and are
  immediately removed from the browser URL by the BFF's next redirect.

## Routes

```text
POST /auth/github/web/start        { origin, returnTo }  -> { authorizeUrl, attemptId, claimToken }
POST /auth/github/web/complete     { attemptId, claimToken, completionCode } -> { token, user, redirectUrl }
POST /auth/github/native/start     { redirectUri }       -> { authorizeUrl, attemptId, claimToken }
POST /auth/github/native/complete  { attemptId, claimToken, completionCode } -> { accessToken, refreshToken, refreshTokenExpiresAt, user }
GET  /auth/callback                                       (GitHub OAuth callback)
GET  /auth/github/install/callback                        (GitHub App setup callback)
```

The route determines client type and response shape. There is no `clientType`,
`sessionType`, or repository-setup field in any request, and neither completion
response is polymorphic.

## Web flow (same tab)

```
Browser                    Next.js BFF                  API Server              GitHub
  |                            |                            |                      |
  |-- click "Sign in" -------->|                            |                      |
  |   (top-level navigation to /api/auth/github/start?returnTo=/path)              |
  |                            |-- POST /auth/github/web/start ------------------->|
  |                            |   { origin, returnTo }     # validate origin +    |
  |                            |                            #   relative returnTo  |
  |                            |                            # create attempt +     |
  |                            |                            #   fresh oauth state  |
  |                            |<-- { authorizeUrl, attemptId, claimToken } --------|
  |<-- 302 authorizeUrl + Set-Cookie github_sign_in_attempt (HttpOnly, 600s) -------|
  |                                                                                 |
  |                  (user authorizes on GitHub)                                    |
  |<-- redirect to api.mymachines.dev/auth/callback?code=X&state=Y ------------------|
  |                                                         # consume state         |
  |                                                         # exchange code         |
  |                                                         # upsert user + creds   |
  |                                                         # status=identity_ready |
  |                                                         # chain install if none |
  |<-- 302 <origin>/api/auth/github/complete?attemptId=<id>&completionCode=<code> ----|
  |-- GET /api/auth/github/complete ->|                     |                       |
  |                            |-- POST /auth/github/web/complete ----------------->|
  |                            |   { attemptId, claimToken, completionCode }         |
  |                            |<-- { token, user, redirectUrl } -------------------|
  |<-- Set session_token cookie, clear attempt cookie, 302 redirectUrl -------------|
```

`redirectUrl` is the GitHub App installation URL when one was chained, otherwise
`<origin><returnTo>`. **The session cookie is set before installation
navigation**, so abandoning or delaying repository setup never discards a
completed login. The installation setup callback then returns the browser to the
same stored application route.

There is no popup, opener, `postMessage`, or polling anywhere in web sign-in.

### BFF completion precedence

`/api/auth/github/complete` resolves in a fixed order:

1. A claim cookie whose attempt id matches the query is processed — even when a
   valid session already exists, whose cookie is then replaced.
2. Otherwise a valid existing session means a revisited completion URL, so the
   browser is sent to the default signed-in route.
3. Otherwise the browser goes to the same-origin signed-out retry surface
   (`/?signInError=<code>`).

A non-matching attempt cookie belongs to a newer tab and is preserved. Starting
sign-in in a second tab overwrites the cookie; if the older tab returns first it
reaches the retry surface and the newer attempt still completes. This
last-start-wins behavior is intentional.

`GET /api/auth/github/start` is a state-changing GET on purpose, because sign-in
must begin with a top-level navigation. A cross-site page can trigger that
navigation but cannot read or set the same-origin HttpOnly claim cookie and
cannot supply a cross-origin `returnTo`, so it cannot fix the resulting session
to an attacker-chosen attempt or account.

## Native flow (iOS)

One `ASWebAuthenticationSession` covers OAuth and, when needed, installation:

1. `POST /auth/github/native/start { redirectUri }` — the redirect URI is
   exact-matched against a hardcoded allowlist (`cloudecode://auth/callback`;
   `cloudecode-dev://auth/callback` outside production).
2. The app opens `authorizeUrl` with the custom callback scheme.
3. `/auth/callback` exchanges the code server-side, then redirects either to
   GitHub App setup (whose callback returns to
   `cloudecode://auth/callback?attemptId=<id>&completionCode=<code>`) or issues
   the completion code and redirects straight to that URI.
4. The app verifies the returned attempt ID and completion code, then calls
   `POST /auth/github/native/complete` and adopts the token pair.

If the browser is dismissed before the final callback, the app stays signed out
silently and makes no completion call. Retrying creates a new attempt; GitHub
will usually fast-path an authorization already granted. No callback means no
session. See `apps/ios/docs/auth.md`.

## OAuth denial and failure

A GitHub denial (or a failed code exchange) consumes the OAuth state, marks the
attempt `failed`, and returns the browser to the bound client with a stable,
non-secret code:

- Web: `<bound-origin>/api/auth/github/complete?attemptId=<id>&error=OAUTH_DENIED`
- Native: `<bound-custom-scheme>?attemptId=<id>&error=OAUTH_DENIED`

No completion route can issue a session for a failed attempt.

## GitHub App installation

Installation is a repository-access grant with its own lifecycle, and it is
never an authentication gate.

- Installation navigation uses distinct one-time purposes for post-claim web
  sign-in, chained native sign-in finalization, and authenticated repository
  management. Native sign-in state references the attempt but never contains
  the raw completion code; web state owns its final application route and may
  outlive the shorter claimed attempt.
- Consuming it authorizes only the stored return redirect and a repository
  listing refresh.
- `installation_id`, `setup_action`, and repository parameters on the callback
  are browser-supplied and are never treated as authorization evidence. Webhook
  processing and a fresh `/repos` listing remain authoritative.

## Key Design Decisions

- **HTTP-only cookies**: both the web session token and the temporary sign-in
  claim are HttpOnly, `SameSite=Lax`, Secure outside local development, and
  AES-GCM encrypted with `SESSION_COOKIE_SECRET`. The claim cookie is scoped to
  `/api/auth/github` with `Max-Age=600`, matching the web attempt lifetime.
- **Server-side sessions**: web session tokens are random opaque bearer tokens,
  not JWTs. D1 stores only a SHA-256 verifier hash, so the raw cookie value is
  not recoverable from the database; sessions remain revocable.
- **BFF proxy**: the Next.js `/api/[...path]` catch-all extracts the cookie and
  forwards it as a `Bearer` token. The API server only deals with Bearer auth.
- **Identity-only app auth**: auth middleware validates only the app session
  token and returns user identity. It does not join, decrypt, validate, or
  refresh GitHub credentials.
- **Encrypted GitHub tokens**: GitHub access/refresh tokens are stored in
  `user_github_credentials`, encrypted with `TOKEN_ENCRYPTION_KEY`, and are
  persisted at OAuth time — before and independently of any client session.
- **The GitHub authorization code never reaches a client**: `/auth/callback`
  exchanges it server-side and forwards only the attempt id plus the one-time
  completion code needed to claim that attempt.
- **Single-purpose one-time state**: OAuth state is consumed when the
  authorization response is validated. It is never reused as a completion or
  installation credential.
- **Preview-origin allowlist**: `PREVIEW_ORIGIN_ALLOWLIST_REGEX` pins the Vercel
  project name *and* team slug as literals (e.g.
  `^https://my-machines-[a-z0-9][a-z0-9-]*-benedelsteins-projects\.vercel\.app$`).
  Vercel team slugs are globally unique. The prod origin (`WEB_ORIGIN`) is
  exempt. Validated both on write and on read.
- **Allowlist**: only GitHub logins in `ALLOWED_GITHUB_LOGINS` can authenticate.
- **GitHub credential provider**: routes and services that need GitHub
  user-scoped access explicitly resolve credentials with
  `getValidGitHubCredentialByUserId(...)`. Missing, revoked, or unrefreshable
  credentials return `GITHUB_AUTH_REQUIRED`; transient refresh/API failures
  return `GITHUB_UNAVAILABLE`.
- **Expiry and pruning**: expiration is checked on every state/attempt read, and
  creation paths opportunistically delete expired rows to bound storage.
- **Rate limiting**: unauthenticated attempt creation is deliberately not
  rate-limited beyond fixed expirations and prune-on-create, matching the prior
  unauthenticated sign-in start.
- **GitHub reauth without app logout**: authenticated reauth endpoints
  (`POST /auth/github/reauth/start`, `POST /auth/github/reauth/token`) run the
  GitHub OAuth flow again in a popup, verify the returned GitHub user id matches
  the current app user, and update only `user_github_credentials`. They do not
  create or replace an app auth session.

## Authenticated Requests

```
Browser                    Next.js proxy (/api/*)       API Server
  |                            |                            |
  |-- fetch /api/sessions ---->|                            |
  |   (cookie sent auto)       |                            |
  |                            |-- GET /sessions ---------->|
  |                            |   Authorization: Bearer <token>
  |                            |                            |
  |                            |   (middleware validates app session
  |                            |    and returns user identity only)
  |                            |                            |
  |                            |<-- response ---------------|
  |<-- response ---------------|                            |
```

## Native Client Sessions (Access + Refresh Tokens)

Native clients (the iOS app) claim their session through
`POST /auth/github/native/complete` and then use `/auth/native/*` for its
lifecycle. Web sign-in instead returns the 30-day opaque session token used by
the BFF cookie flow.

The native credential is a short-lived access token plus a long-lived rotating refresh token:

- `accessToken` — stateless JWT access token, 15-minute TTL, signed with `NATIVE_ACCESS_TOKEN_SIGNING_KEY`. The server verifies issuer, audience, type, signature, and expiry. The iOS app decodes only `sub` and `exp` for local cache lookup and refresh scheduling.
- `refreshToken` — opaque 32-byte base64url token, 60-day sliding TTL. Stored only as a SHA-256 hash in `auth_refresh_sessions`; the raw value is returned exactly once per rotation.

A native session is a "family": one `auth_refresh_sessions` row plus stateless JWT access tokens minted from that family. `auth_sessions` stores web sessions only.

### Refresh rotation

`POST /auth/native/refresh` accepts `{ refreshToken }` with no Authorization header (the refresh token is the credential) and is registered without auth middleware. A valid refresh:

1. Rotates the refresh token: the new hash becomes current, the presented hash is kept as `previous_refresh_token_hash` with `previous_rotated_at`.
2. Mints a new JWT access token.
3. Extends the refresh expiry (sliding 60 days).
4. Returns `{ accessToken, refreshToken, refreshTokenExpiresAt }`.

Invalid, expired, or reused tokens return `401` with `INVALID_REFRESH_TOKEN`.

### Grace window and reuse detection

The previous refresh token stays valid for 60 seconds after rotation so a client that lost the response to a network failure can retry. Presenting the previous token *outside* that window is treated as token theft: the refresh-token family is revoked, so no token in that family can mint future access tokens.

Native access tokens are intentionally stateless JWTs. Revoking a refresh-token family does not perform a per-request database lookup or invalidate access JWTs already minted from that family; those remain accepted until their 15-minute `exp`. This is the explicit tradeoff for native auth: immediate refresh revocation, bounded access-token lifetime.

### Logout

`POST /auth/native/logout` accepts `{ refreshToken }` and revokes the refresh-token family. Already minted native access JWTs may remain valid until their 15-minute expiry. `POST /auth/logout` remains web-only and deletes the opaque web session row.

### Native sign-in flow (iOS)

See "Native flow (iOS)" above and `apps/ios/docs/auth.md`. The app never
exchanges a GitHub authorization code: it starts an attempt, opens one
`ASWebAuthenticationSession`, verifies the callback's `attemptId`, and claims
the session with `POST /auth/github/native/complete`.

### Dev: minting a native session locally

The real exchange needs a GitHub OAuth code, so for local testing insert a session family directly into local D1 (server can be running; D1 state is shared):

```bash
cd services/api-server

# 1. Generate a token pair + hashes
python3 - <<'EOF'
import secrets, hashlib, base64, uuid, datetime
b64url = lambda b: base64.urlsafe_b64encode(b).rstrip(b'=').decode()
access, refresh = b64url(secrets.token_bytes(32)), b64url(secrets.token_bytes(32))
now = datetime.datetime.now(datetime.timezone.utc)
print("access token: ", access)
print("refresh token:", refresh)
print("refresh hash: ", hashlib.sha256(refresh.encode()).hexdigest())
print("family id:    ", uuid.uuid4())
print("access exp:   ", (now + datetime.timedelta(minutes=30)).strftime('%Y-%m-%dT%H:%M:%S.000Z'))
print("refresh exp:  ", (now + datetime.timedelta(days=60)).strftime('%Y-%m-%dT%H:%M:%S.000Z'))
EOF

# 2. Find your user id
pnpm exec wrangler d1 execute cloude-code-db --local \
  --command "SELECT id, github_login FROM users"

# 3. Insert the refresh family (substitute values from steps 1-2)
pnpm exec wrangler d1 execute cloude-code-db --local --command "
INSERT INTO auth_refresh_sessions (id, user_id, refresh_token_hash, refresh_expires_at)
VALUES ('<family-id>', '<user-id>', '<refresh-hash>', '<refresh-exp>');
"

# 4. Verify
curl -s -X POST http://localhost:8787/auth/native/refresh \
  -H "Content-Type: application/json" -d '{"refreshToken":"<refresh-token>"}'
```

Paste the refresh token + user id into the iOS Dev scheme's signed-out DEBUG form to sign the simulator in (the app refreshes immediately, so the rotated-out raw tokens above stop mattering).

## GitHub Reauth Flow

GitHub remains the only app identity provider, but app auth and GitHub API credentials are separate runtime concerns.

- Sign-in state uses `purpose = "github_login"` plus a `sign_in_attempt_id`; the API exchanges the code itself and the client later claims the attempt.
- Reauth state uses `purpose = "github_reauth"` plus the current `user_id`, and still bounces its code to the originating web origin.
- `/auth/callback` reads the state purpose: sign-in is completed server-side, reauth is forwarded to `/api/auth/github/reauth/finalize`.
- Sign-in completion sets the app session cookie at `/api/auth/github/complete`. Reauth finalize posts a reauth popup message and does not set the session cookie.
- Reauth token exchange rejects a GitHub account mismatch before updating credentials.
- Revoking GitHub App user authorization deletes the stored GitHub credentials, not the app session.

After credentials are missing or revoked, identity-only routes still work: `/auth/me`, `/auth/logout`, sidebar/session list, settings shell, and other routes that need only `user.id`. GitHub-dependent routes return `GITHUB_AUTH_REQUIRED` until the user reauthenticates.

## Preview Branches

Vercel preview branches share one GitHub App with prod, which means one callback URL. The callback lives on the api-server (`api.mymachines.dev/auth/callback`); GitHub redirects every sign-in there regardless of which web origin started it. The api-server reads the attempt's bound origin — recorded and re-validated server-side — and 302s the tab back to that origin's `/api/auth/github/complete?attemptId=<id>&completionCode=<code>`.

One browser rule forces this hop: cookies are origin-scoped, so the api-server on `api.mymachines.dev` cannot Set-Cookie for `<preview>.vercel.app` (different registrable domain). Both the temporary claim cookie and the session cookie must be written by the origin that started sign-in, which is why the BFF completion route exists.

The claim cookie is also what binds a callback to the tab that started it: only the originating origin holds it, and only a matching attempt id can spend it.

## WebSocket Auth

Browser WebSockets cannot use the normal BFF `Authorization` header path because `new WebSocket()` does not allow custom headers. WebSocket auth is therefore a two-step flow:

1. Use the normal cookie -> BFF -> Bearer-authenticated HTTP path to mint a short-lived WebSocket token.
2. Pass that token as `?token=...` on the WebSocket upgrade URL.

There are two WebSocket surfaces:

| Socket | Token endpoint | Upgrade URL | Token scope |
|--------|----------------|-------------|-------------|
| Session agent | `POST /sessions/{sessionId}/websocket-token` | `/agents/session/{sessionId}?token=...` | `type`, `sessionId`, `userId`, `exp` |
| User sessions sidebar stream | `POST /sessions/updates/token` | `/sessions/updates?token=...` | `type`, `userId`, `exp` |

Both token types are stateless HMAC-SHA256 tokens signed with `WEBSOCKET_TOKEN_SIGNING_KEY`. They expire after 5 minutes and return `{ token, expiresAt }` to the web app.

### Upgrade validation

- The session socket upgrade is handled by `agent.routes.ts`. It verifies the token signature, token type, expiration, and `sessionId`, then re-checks session repo access before routing to the session Durable Object.
- The user sessions stream upgrade is handled by `sessions.routes.ts`. It verifies the token signature, token type, and expiration, then forwards the request to the `UserSessionsDO` named by `userId`.

The token is only checked during the WebSocket upgrade. Once a socket is established, token expiry does not close it or revoke it. A socket opened with a 5-minute token can stay open past that 5-minute window.

### Refresh and reconnect

The web app does not refresh WebSocket tokens on a timer. `useWebSocketToken(...)` owns token minting, transient retry backoff, and terminal auth errors; the socket hooks decide when a fresh token is needed.

Current behavior:

- If no token exists, the token hook mints one before opening the socket.
- If a token is expired or within the 30-second client buffer, the socket hook refreshes before opening or reconnecting.
- If a WebSocket closes and the token is expired or near expiry, the socket hook refreshes instead of continuing with that token.
- Transient token-mint failures retry with exponential backoff, capped at 30 seconds.
- Token-mint `401`, `403`, or `404` responses are treated as terminal auth/access errors and do not retry automatically.

The session page can receive an initial session WebSocket token from session creation. The web app stores that token briefly in memory/sessionStorage and consumes it on first render to avoid an extra HTTP mint. Cached initial tokens are ignored if they are expired or within the 30-second buffer.

Short token TTL is leak mitigation, not socket lifetime control. Query strings are exposed in more places than headers, so the TTL limits the window in which a leaked URL can open a new socket.

### Keep-alive

We don't send app-level pings. Cloudflare answers protocol-level `ping` control frames automatically without waking the DO, but browser JS can't initiate protocol pings (the W3C WebSocket API doesn't expose them). An app-level `{type:"ping"}` message would work but would wake the DO every interval and defeat hibernation — only add it if we see real idle drops on specific networks.

## Relevant Files

| File | Purpose |
|------|---------|
| `services/api-server/src/modules/auth/routes/auth.routes.ts` | Sign-in start/complete routes, `GET /auth/callback`, installation callback, native refresh/logout, GitHub reauth endpoints, logout |
| `services/api-server/src/modules/auth/services/github-sign-in-flow.service.ts` | Attempt creation, OAuth completion, installation decision, and client-specific session issuance |
| `services/api-server/src/modules/auth/services/github-installation.service.ts` | GitHub App installation URLs and setup-callback consumption for both chained sign-in and repository management |
| `services/api-server/src/modules/auth/repositories/sign-in-attempt.repository.ts` | Sign-in attempt storage, claim-token verification, and at-most-once claiming |
| `services/api-server/src/modules/auth/middleware/auth.middleware.ts` | App session validation and identity attachment |
| `services/api-server/src/modules/auth/services/user-session.service.ts` | App session lookup plus explicit GitHub credential resolution/refresh helpers |
| `services/api-server/src/modules/auth/utils/preview-origin.util.ts` | Validates redirect origin against `WEB_ORIGIN` and `PREVIEW_ORIGIN_ALLOWLIST_REGEX` |
| `services/api-server/src/modules/session-agent/routes/agent.routes.ts` | Session WebSocket upgrade token validation and repo-access gate |
| `services/api-server/src/modules/sessions/routes/sessions.routes.ts` | User sessions stream token validation and token mint routes |
| `services/api-server/src/modules/sessions/services/session-websocket-token.service.ts` | Per-session WebSocket token signing and verification |
| `services/api-server/src/modules/sessions/services/user-sessions-websocket-token.service.ts` | User-scoped sidebar stream token signing and verification |
| `services/api-server/src/modules/github/services/github-app.service.ts` | GitHub App OAuth helpers |
| `services/api-server/src/shared/repositories/external-auth-state.repository.ts` | Purpose-aware one-time external-auth callback state (physical table `oauth_states`) |
| `services/api-server/src/shared/utils/crypto.ts` | Token encryption/decryption |
| `apps/web/app/api/auth/github/start/route.ts` | Starts a web attempt, stores the claim cookie, redirects to GitHub |
| `apps/web/app/api/auth/github/complete/route.ts` | Claims the attempt, sets the session cookie, redirects onward |
| `apps/web/lib/sign-in-attempt.ts` | Encrypted HttpOnly claim-cookie read/write/clear |
| `apps/web/lib/sign-in-navigation.ts` | Same-tab start URL, `returnTo` validation, and retry-surface error codes |
| `apps/web/app/api/auth/github/reauth/finalize/route.ts` | Exchanges reauth code, updates GitHub credentials, posts opener without setting app session cookie |
| `apps/web/app/api/[...path]/route.ts` | BFF proxy, cookie -> Bearer translation |
| `apps/web/hooks/use-auth.ts` | Client-side auth hook (same-tab login navigation, logout, sign-in error surfacing) |
| `apps/web/hooks/use-github-reauth.ts` | Client-side GitHub reauth popup management |
| `apps/web/hooks/use-websocket-token.ts` | Shared client token mint/retry lifecycle |
| `apps/web/hooks/use-session-websocket-token.ts` | Session WebSocket token adapter and initial-token handoff |
| `apps/web/hooks/use-user-sessions-websocket-token.ts` | User sessions stream token adapter |
| `apps/web/hooks/use-cloudflare-agent.ts` | Session socket connection through `useAgent` / PartySocket |
| `apps/web/hooks/use-user-sessions-websocket.ts` | Sidebar stream raw WebSocket connection and reconnect loop |
| `apps/web/lib/websocket-token.ts` | Client-side token expiry buffer helpers |

## Authentication Rules

- You can only create a session on a repo if you have access to it via its github app installation.
  We first check the installation that the repo is associated with, and then use the user's github access token to verify that the user can access that repo via the installation.
  Even if a user can access a repo, they may not have access to it via the installation.
- GitHub user access tokens cannot be generated server-side from only the app private key or an installation id. The app can exchange a fresh user authorization code or refresh an existing valid refresh token. If no stored credential exists and no refresh is possible, GitHub user-scoped routes fail with `GITHUB_AUTH_REQUIRED` while the app auth session remains valid.
- You can only create a repo environment for a repo if the same `assertUserRepoAccess(...)` path confirms access. Session creation resolves the selected environment through `RepoEnvironmentsService.resolveEnvironmentSnapshot(...)` and stores that immutable snapshot in the session Durable Object.
- You can only view a session if you created it (for now).
- You can only install the github app on a repo if you have admin access to it (this is a limitation of the github api).

Even after you create a session on a repo you have access to, you may lose access to it if the installation is deleted, you lose access to the repo, or the repo is removed from the installation. We handle this like so:

- Routes to create/get a session, mint a websocket token, connect a websocket, and send `chat.message` all check for access to the repo using `services/api-server/src/modules/sessions/services/session-repo-access.service.ts`.
  a. If we don't know the repo's installation_id, we have to look it up using `github-app.service.ts#findInstallationForRepoId`. This first checks D1 `github_installation_repos`, then falls back to the GitHub API.
  b. Check the `github_user_repo_access_cache` for this (user_id, repo_id, installation_id) (5 minute TTL)
  c. If no cache value exists, look up the repo using the GitHub API (the same route we use to fetch user-accessible repos). This path is slow, since we have to enumerate a user's repos, which is also why we cache it.

We use a D1 table `github_user_repo_access_cache` to cache user access to a repo within an installation. The cache TTL is 5 minutes.
Values are put to the cache when a user creates a session, or calls get /repos to list the repos they have access to.

If a fresh value is found in the cache, we return true in the access check.
If an installation is deleted, or repo is removed from the installation, we clear the relevant values from the cache.
