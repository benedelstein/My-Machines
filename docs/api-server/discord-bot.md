# Discord bot and integration session requests

This repo supports external-client session creation in two pieces:

1. `apps/discord-bot` is a Cloudflare Worker Discord Interactions adapter.
2. `services/api-server` owns generic integration auth, account linking, repo routing, and session creation.

The Discord Worker stays thin: it verifies Discord signatures, acknowledges `/session`, adapts Discord's user shape into the generic integration request payload, calls the API, and edits the original Discord interaction response.

## Current command

```text
/session prompt: make a change to the auth in the birthday repo
```

Discord normal `@botname ...` message mentions are not delivered to Interactions endpoints. Those require a Gateway connection. The API endpoint is reusable by a future Gateway bot or other external clients: call `POST /integrations/session-requests` with an integration API token.

## Generic API shape

```http
POST /integrations/session-requests
Authorization: Bearer <integration-session-request-token>
Content-Type: application/json
```

```json
{
  "externalUser": {
    "provider": "discord",
    "id": "123456789012345678",
    "displayName": "Ben",
    "username": "ben"
  },
  "prompt": "make a change to the auth in the birthday repo"
}
```

`externalUser` is a discriminated union. Current providers are `discord`, `slack`, and `generic`. The first implementation starts with text prompts only; image attachments can be added to this payload later.

## Account linking

External users are linked to My Machines users with short-lived, single-use link attempts:

1. An external user sends a session request through an integration client.
2. The client calls `POST /integrations/session-requests` with the external user and prompt.
3. If the external account is not linked, the API creates a 15-minute link attempt and returns `linkUrl`.
4. The client shows that link to the user.
5. The user opens the link in the web app.
6. If needed, the user signs in through the existing GitHub OAuth flow.
7. The web app calls `POST /integrations/link/claim` with the token.
8. The API consumes the link attempt and stores an integration account link for the signed-in My Machines user.

Account links expire after 90 days. Use does not extend the expiry: `last_used_at` is tracked, but `expires_at` stays fixed from the claim, so even active users must relink every 90 days. Once expired, the next integration request creates a fresh link URL and asks the user to reconnect. Link attempts store only a SHA-256 token hash, and each new link request replaces the user's previous outstanding attempt.

## Routing design

Routing is API-side in `IntegrationSessionRequestService`:

1. Resolve `{ provider, externalUser.id }` to an active, unexpired My Machines account link.
2. Load the linked user's valid GitHub token from stored My Machines credentials.
3. Enumerate the user's accessible repos from the existing repo listing/cache path.
4. Heuristically rank repos by exact owner/name, repo name, token matches, and description.
5. Fetch README excerpts for top candidates as lightweight RAG context.
6. Ask Claude Haiku to choose one candidate from repo names, descriptions, and README excerpts.
7. Fall back to a strong unique heuristic match, otherwise return candidate repos and ask for a more exact repo hint.
8. Create the session through the existing `SessionsService` with the external prompt as the initial message.

## API server configuration

Set this Cloudflare Worker secret on `services/api-server`:

```bash
cd services/api-server
pnpm wrangler secret put INTEGRATION_SESSION_REQUEST_TOKEN
```

Use the same `INTEGRATION_SESSION_REQUEST_TOKEN` value on the API server and every trusted integration client, including the Discord Worker.

Apply the D1 migration before using the feature remotely:

```bash
cd services/api-server
pnpm db:migrate:prod
```

## Discord Worker configuration

Set this secret on `apps/discord-bot` (`DISCORD_PUBLIC_KEY` is a public Worker var in `wrangler.jsonc`):

```bash
cd apps/discord-bot
pnpm wrangler secret put INTEGRATION_SESSION_REQUEST_TOKEN
```

Deploy:

```bash
pnpm --filter @repo/discord-bot deploy
```

Use the deployed Worker URL as the Discord Interactions Endpoint URL.

## Register the slash command

For fast iteration, register as a guild command:

```bash
cd apps/discord-bot
DISCORD_APPLICATION_ID=... \
DISCORD_BOT_TOKEN=... \
DISCORD_GUILD_ID=... \
pnpm register-command
```

Omit `DISCORD_GUILD_ID` to register globally.
