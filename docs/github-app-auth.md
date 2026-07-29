# Authentication

## Overview

My Machines uses a GitHub App for repository access. Each session gets a scoped, short-lived installation access token that's automatically refreshed.

## How It Works

### Flow

```
1. Admin installs the GitHub App on an org/user account
2. GitHub sends installation webhooks → stored in D1
3. Client creates session: POST /sessions { repoId: 123456789 }
4. API resolves numeric repo id → installation and verifies user access
5. Durable Object provisions the Sprite, clones with a read-only installation token, and points both git remotes at the Worker git proxy
6. Git proxy requests authenticate with short-lived ephemeral git tokens, then mint or reuse scoped installation tokens through `GitHubAppService`
7. After a successful pushed branch and terminal agent turn, the Durable Object uses the same GitHub App service to create the pull request server-side
```

### Installation return

First-time sign-in can chain OAuth and installation in one browser journey
without enabling GitHub's coupled OAuth-on-install setting. `/auth/callback`
exchanges and stores the user's GitHub credential and marks the sign-in attempt
`identity_ready`. When the GitHub user has no installation, the API creates a
one-time installation callback state bound to that attempt and sends the same
browser to GitHub's installation URL.

Where the attempt is claimed differs by client, because the clients regain
control at different points:

- **Web** claims first. The API returns the tab to the BFF completion route, the
  BFF sets the session cookie, and only then does the browser continue to the
  installation URL. Abandoning setup cannot undo the login.
- **Native** has no control point between browser navigations. The setup
  callback returns to the app's OAuth custom scheme carrying `attemptId`, and
  the app claims there with the callback's one-time completion code. If the
  browser is dismissed first, iOS stays signed out and starts a fresh attempt
  when the user retries; it never completes without the final callback.

Authenticated repository management is separate: the iOS client starts it with
`POST /auth/github/install/start`, which creates a one-time state row bound to
an allowlisted native callback and appends the nonce to GitHub's installation
URL. GitHub preserves that state when it sends the browser to the configured
`/github/install/complete` setup page, which forwards to the public
`GET /auth/github/install/callback` route through the web API proxy.

Consuming an installation state authorizes only the stored return redirect and a
repository-listing refresh. Clients treat the redirect purely as browser
completion and read actual access from the authenticated repository listing;
the `installation_id` and `setup_action` supplied to the setup page are never
trusted. Zero repositories is a valid signed-in state, and repository management
remains available from the repository picker.

### User And Installation Authorization

GitHub App user access tokens are intersection-scoped. They can access only the
repositories and permissions available to both:

- the signed-in GitHub user
- the GitHub App installation
- the permissions granted to the GitHub App

That means organization membership or direct repo access is not enough by itself. The repository
must also be available through a GitHub App installation that the user can access. The inverse is
also true: installing the app on a repository does not let a user act on that repository unless the
user also has GitHub access to it.

GitHub exposes this intersection through:

- `GET /user/installations`
- `GET /user/installations/{installation_id}/repositories`

The repo picker uses those endpoints through `GitHubAppService.listInstallationsForAuthenticatedUser(...)`
and `GitHubAppService.listInstallationReposForAuthenticatedUser(...)`, so users only see repositories
inside installations they can access.

The API server stores GitHub App user access/refresh tokens in `user_github_credentials`, encrypted
with `TOKEN_ENCRYPTION_KEY`. App auth does not load these credentials. GitHub-dependent routes
explicitly resolve them with `getValidGitHubCredentialByUserId(...)`.

Session creation and existing-session access use the same rule through `assertUserRepoAccess(...)` and
`assertSessionRepoAccess(...)`. Those checks resolve the repository's installation, then call
`getUserAccessibleInstallationRepoById(...)`, which lists the repositories visible to the current
user inside that installation and requires the selected repo id to be present.

Installation access tokens do not carry the signed-in user's authorization boundary. They are used
for clone, push, fetch, compare, and pull-request operations only after the API server or Durable
Object has already checked the user/installation intersection for the session.

If the stored GitHub user credential is missing, revoked, or cannot be refreshed, routes that need
the user/installation intersection return `GITHUB_AUTH_REQUIRED`. The app cannot mint a GitHub user
access token from only the GitHub App private key or an installation id; it must either refresh a
stored refresh token or send the user through the GitHub OAuth flow again. This reauth flow updates
`user_github_credentials` only and does not replace the app auth session.

References:

- [Generating a user access token for a GitHub App](https://docs.github.com/en/enterprise-cloud@latest/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#about-user-access-tokens)
- [REST API endpoints for GitHub App installations](https://docs.github.com/en/rest/apps/installations?apiVersion=2022-11-28)
- [Authorizing GitHub Apps](https://docs.github.com/en/apps/using-github-apps/authorizing-github-apps)

### Token Resolution

When a session is created, repo access is checked by `assertUserRepoAccess(...)` in `services/api-server/src/modules/sessions/services/session-repo-access.service.ts`. GitHub App token minting for clone/push goes through `GitHubAppService`:

1. Resolve or refresh the current user's GitHub user credential from `user_github_credentials`.
2. Resolve the numeric repo id to an installation with `findInstallationForRepoId(...)`.
3. Verify the current user can access the repo through that installation.
4. Check D1 installation token cache (valid if expires > now + 5 minutes).
5. On cache miss, generate a new installation token via `octokit App.getInstallationOctokit()`.
6. Cache the installation token in D1 and return it.

If no installation is found in D1, the code falls back to GitHub API installation lookup and records the result.

Pull request creation also uses `GitHubAppService`. The manual route and the automatic post-turn path both reuse `createPullRequestForSession(...)` so PR text generation, existing-PR handling, and DO state persistence stay in one place.

### Git Authentication on the VM

Git setup lives in `SessionProvisionService.cloneRepo(...)`:

- **Clone**: the API server mints a read-only installation token with `getReadOnlyTokenForRepo(...)`, base64-encodes `x-access-token:<TOKEN>`, and runs clone with an `http.extraHeader`:
  ```
  git -c http.extraHeader="Authorization: Basic <base64(x-access-token:TOKEN)>" clone ...
  ```
  The token exists only for the clone command and never persists on the VM.
- **Fetch/push after clone**: both remotes point at `WORKER_URL/git-proxy/:sessionId/github.com/owner/repo.git` in every network mode (the Worker hostname is always allow-listed by `buildFinalNetworkPolicy(...)`). The Sprite holds no long-lived git credential. A per-session credential helper installed at `/home/sprite/.local/bin/mm-git-credential-<sessionId>` supplies an ephemeral git token on demand:
  1. Git invokes the helper — proactively via `http.<proxy>.proactiveAuth basic` on git >= 2.46, otherwise after the proxy's 401 Basic challenge.
  2. The helper POSTs to `/internal/session/:sessionId/git-token` through the session connector gateway. The gateway injects the session's webhook token, which is what binds the mint request to the calling Sprite's identity; the helper script itself carries no credential.
  3. The Durable Object validates the token and returns `{ token, expiresAt }`: a 5-minute ephemeral token, reused while it has more than 60 seconds left, then rotated with a grace window that keeps the previous unexpired token valid.
  4. Git presents the token as HTTP Basic auth (`x-ephemeral-git-token:<token>`). The Worker git proxy validates it in the DO (`SessionGitProxyService.authenticateGitRequest(...)`) and forwards to GitHub with a fresh or cached installation token from `getInstallationTokenForRepo(...)`. Push requests additionally enforce the session branch policy (session branch prefix plus the session's branch suffix).

The session connector task is blocking and ordered before repository setup, so a missing connector gateway fails provisioning (`cloneRepo` throws) instead of downgrading git auth. Session teardown revokes outstanding ephemeral git tokens and the webhook token before external cleanup, so a stolen unexpired token dies with the session.

**Legacy sessions** (provisioned before ephemeral-token auth) have `gitAuthMode: "legacy_secret"` in DO server state. For those, the proxy accepts only the session's `git_proxy_secret` bearer, which their VM git config sends via `http.extraHeader`. Nothing mints new legacy secrets: new sessions are always `"ephemeral_token"` mode, and the cutover deletes any leftover secret via `retireGitProxySecret()`.

## Architecture

### Key Files

| File | Purpose |
|------|---------|
| `services/api-server/src/modules/github/services/github-app.service.ts` | `GitHubAppService` - token resolution, installation lookup, webhook handling |
| `services/api-server/src/modules/sessions/services/session-repo-access.service.ts` | Session repo access checks for create/read/connect/chat paths |
| `services/api-server/src/modules/repo-environments/services/repo-environments.service.ts` | Repo environment ownership/access checks and session environment snapshot resolution |
| `services/api-server/src/modules/session-agent/services/session-provision.service.ts` | Sprite provisioning, read-only clone, git remote setup |
| `services/api-server/src/modules/session-agent/services/session-git-proxy.service.ts` | Session-scoped git proxy adapter: ephemeral git token mint/rotation and request authentication |
| `services/api-server/src/shared/integrations/git/git-proxy.service.ts` | Session-agnostic git proxy: GitHub forwarding and push branch validation |
| `services/api-server/src/modules/session-agent/routes/internal.routes.ts` | Gateway-facing internal routes, including the ephemeral git token mint endpoint |
| `services/api-server/src/modules/sessions/services/session-pull-request.service.ts` | GitHub pull request creation helper used by the DO lifecycle |
| `services/api-server/src/runtime/session-pull-request-lifecycle.service.ts` | Manual and automatic pull request state, text generation context, and D1 persistence |
| `services/api-server/src/runtime/session-auto-pull-request.service.ts` | Post-turn automatic pull request queueing from the Durable Object |
| `packages/sprites-client/src/network-policy.ts` | Bootstrap/final Sprite network policy construction |
| `services/api-server/src/modules/webhooks/routes/webhooks.routes.ts` | `POST /webhooks/github` - receives GitHub webhook events |
| `services/api-server/migrations/0001_github_app.sql` | D1 schema for installations, repos, token cache |

### D1 Tables

- **`github_installations`** — One row per GitHub App installation. Tracks account, permissions, repo selection mode, suspension status.
- **`github_installation_repos`** — Tracks which repos are accessible when `repository_selection = "selected"`. When `"all"`, every repo under the account is accessible (no rows needed).
- **`user_github_credentials`** — Stores encrypted GitHub App user access/refresh tokens separately from app auth sessions.
- **`installation_token_cache`** — Caches encrypted installation access tokens. Runtime cache keys include the repo id and permission scope, and reads require `expires_at` to be more than 5 minutes in the future.
- **`github_user_repo_access_cache`** — Caches per-user repo access checks for 5 minutes. This is used by session creation and existing-session access checks.
- **`repo_environments`** — Stores repo-scoped environment presets. Session creation snapshots the selected environment; provisioning uses the snapshot for final network policy, plain env vars, and startup script behavior.

### Webhook Events

The app listens at `POST /webhooks/github` for:

| Event | Action | Effect |
|-------|--------|--------|
| `installation.created` | Upsert installation + selected repos in D1 |
| `installation.deleted` | Delete installation (CASCADE cleans up repos + cache) |
| `installation.suspend` | Set `suspended_at` timestamp |
| `installation.unsuspend` | Clear `suspended_at` |
| `installation_repositories.added` | Update installation repo rows and invalidate affected repo-access/listing caches |
| `installation_repositories.removed` | Delete repo rows, invalidate affected caches, and block sessions for removed repos |
| `github_app_authorization.revoked` | Delete stored GitHub user credentials for the sender without deleting app auth sessions |

Webhook signature verification is handled by `octokit`'s `app.webhooks.verifyAndReceive()`.

### Error Handling

`GitHubAppError` with codes:
- `INSTALLATION_NOT_FOUND` — No GitHub App installation for the repo's owner
- `REPO_NOT_ACCESSIBLE` — Installation exists but repo not in selected repos list
- `INVALID_REPO` — Repo id/name was invalid or no longer resolvable
- `GITHUB_AUTH_ERROR` — User OAuth token is invalid and could not be refreshed
- `GITHUB_API_ERROR` — GitHub API call failed

Session creation maps these through `SessionsService.createSession(...)`: access denials return **403**, invalid repo input returns **400**, GitHub auth failures return **401**, and temporary GitHub API failures return **503**.

Credential-provider failures use stable route-level codes:
- `GITHUB_AUTH_REQUIRED` — Stored GitHub user credentials are missing, revoked, or need reauth.
- `GITHUB_UNAVAILABLE` — GitHub credential refresh/API failed transiently.

The web client treats these GitHub-specific failures as session-preserving: they do not dispatch the global app logout event.

## Configuration

These non-secret vars live in `services/api-server/wrangler.jsonc`:

| Var | Description |
|-----|-------------|
| `GITHUB_APP_ID` | Numeric app ID from GitHub App settings |
| `GITHUB_APP_CLIENT_ID` | OAuth client ID |
| `GITHUB_APP_SLUG` | GitHub App slug used for install URLs |

Set these via `wrangler secret put`:

| Secret | Description |
|--------|-------------|
| `GITHUB_APP_PRIVATE_KEY` | PEM private key (PKCS#8 format) |
| `GITHUB_WEBHOOK_SECRET` | Webhook secret configured in GitHub App settings |
| `GITHUB_APP_CLIENT_SECRET` | OAuth client secret |
| `TOKEN_ENCRYPTION_KEY` | Encrypts GitHub OAuth tokens and cached installation tokens |
| `NATIVE_ACCESS_TOKEN_SIGNING_KEY` | Signs short-lived native JWT access tokens |

## Setup

1. Create a GitHub App at https://github.com/settings/apps/new
2. Set webhook URL to `https://<api-domain>/webhooks/github`
3. Grant permissions: `Contents: Read & write`, `Metadata: Read-only`
4. Subscribe to events: `Installation`, `Repository`
5. Generate a private key and download it
6. Ensure `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, and `GITHUB_APP_SLUG` are configured in `wrangler.jsonc`, then set secrets:
   ```bash
   wrangler secret put GITHUB_APP_PRIVATE_KEY
   wrangler secret put GITHUB_WEBHOOK_SECRET
   wrangler secret put GITHUB_APP_CLIENT_SECRET
   wrangler secret put TOKEN_ENCRYPTION_KEY
   wrangler secret put NATIVE_ACCESS_TOKEN_SIGNING_KEY
   ```
7. Install the app on the target org/user account
