# Multi-provider Auth and Model Routing Design

Status: implemented with current file-name drift. Provider metadata now lives
in `packages/shared/src/types/providers-registry.ts`; provider auth dispatch is in
`services/api-server/src/modules/ai-auth/services/provider-auth.service.ts`;
Sprite credential sync is in
`services/api-server/src/modules/ai-auth/services/provider-credential-adapter.service.ts`;
and the DO uses `SpriteAgentProcessManager`, not the older
`agent-process-manager.ts` name.
Legacy `claude_tokens` and `openai_tokens` tables still exist, but current
Claude/OpenAI Codex auth services store active credentials in
`user_provider_credentials`.

## Goal

Allow users to connect multiple LLM providers and choose models from whichever connected provider they want to use.

v1 providers:
- `claude-code`
- `openai-codex` (rename from `codex-cli`)

This design must support:
- an arbitrary number of providers
- multiple auth methods per provider
- different auth flows per provider
- models that may appear under more than one provider

The important rule is that model selection is always provider-scoped. Selecting a model means selecting the `(provider, model)` route it was selected under.

## Product decisions

- The top-level provider in the product and session settings remains the harness/runtime provider.
- The UI is provider-grouped, not model-normalized across providers.
- A provider may support multiple auth methods
- Provider connection state needed by the picker is returned from `/models`.
- Disconnected providers remain visible in the picker. Their models are non-selectable and the group shows an inline connect action.

## Current problems

The current implementation is too provider-specific:

- Claude and OpenAI/Codex credentials are stored in separate tables (`claude_tokens` and `openai_tokens`).
- Claude uses a reusable service object, while OpenAI/Codex still has more route-local logic.
- The Durable Object has provider-specific credential handling in `agent-process-manager.ts`.
- The web app has separate auth hooks and separate auth UI.
- The model picker is Claude-only.

This makes every new provider expensive because auth, storage, runtime sync, and UI are all hard-coded in multiple places.

## Target architecture

### 1. Provider registry

Create a provider registry that is the single source of truth for:

- provider id
- display name
- icon metadata
- default model
- supported auth methods
- model catalog for that provider
- runtime credential sync behavior for the Sprite VM

The registry should be consumed by:

- shared API schemas
- `/models`
- session init validation
- chat-time model switching
- auth route dispatch
- `agent-process-manager.ts`

The registry should be code-based, not DB-configured for now. There should not be a `providers` table.

v1 registry entries:
- `claude-code`
- `openai-codex`

The provider registry can live in `packages/shared/src/types/providers.ts`, with provider-scoped model metadata moved out of `session.ts`.

### 2. Generic provider credential storage

Replace provider-specific token reads/writes with generic credential tables.

Add:

#### `user_provider_credentials`

Columns:
- `user_id`
- `provider_id`
- `auth_method`
- `encrypted_credentials` - encrypted JSON string containing the provider-specific credential payload. format may vary by provider.
- `requires_reauth`
- `created_at`
- `updated_at`

Constraints:
- foreign key to `users(id)`
- unique `(user_id, provider_id, auth_method)`

Notes:
- Store one row per auth method, not one row per provider.
- This allows a provider to support both OAuth and API key credentials later without changing the schema.
- `provider_id` is stored as text and validated against the code registry in application code.
- `encrypted_credentials` should hold the provider-specific credential payload.
- `requires_reauth` covers cases like expired OAuth refresh state.

#### `provider_auth_attempts`

Store in-progress auth attempts for providers that need async or multi-step auth state, such as device auth. This is optional infrastructure, not something every provider flow must use.

Columns:
- `id`
- `user_id`
- `provider_id`
- `auth_method`
- `flow_type`
- `encrypted_context_json`
- `expires_at`
- `created_at`
- `updated_at`

Purpose:
- PKCE verifiers
- device-code polling state
- pasted-code flow state
- future provider-specific auth state

`provider_id` is stored as text and validated against the code registry in application code.

### 3. Keep auth services provider-specific, keep runtime generic

We should not overfit the public auth API around the current Claude and Codex flows.

Do not force all providers into a single generic auth-flow protocol yet. Different providers may have very different initiation and completion flows, and we do not know the stable abstraction yet.

Instead:
- keep provider-specific auth services such as `ClaudeOAuthService` and `OpenAICodexAuthService`
- keep provider-specific auth routes for now
- standardize the parts that are already clearly shared:
  - credential storage
  - connection status shape
  - credential refresh
  - Sprite credential sync
  - provider/model metadata

The service-layer contract should be small and runtime-focused:
- `getConnectionStatus(userId)`
- `disconnect(userId)`
- `getValidCredentials(userId)`
- `refreshCredentialsIfNeeded(userId)`

If a provider needs extra methods for auth initiation or completion, that logic can remain provider-specific in its own service.

Important constraint:
- the API server must refresh provider credentials before session start and before message send if needed
- the VM should not become the source of truth for refreshed credentials

Example runtime-focused interface:

```ts
interface ProviderCredentialService<TCredentials> {
  getConnectionStatus(userId: string): Promise<ProviderConnectionStatus>;
  disconnect(userId: string): Promise<void>;
  getValidCredentials(userId: string): Promise<TCredentials>;
  refreshCredentialsIfNeeded(userId: string): Promise<TCredentials>;
}
```

Example provider-specific auth services:

```ts
export class ClaudeOAuthService
  implements ProviderCredentialService<ClaudeCredentials> {
  async createAuthorizationUrl(): Promise<{ url: string; state: string }> {
    // Claude-specific start flow
  }

  async exchangeAuthorizationCode(params: {
    userId: string;
    code: string;
    state: string;
  }): Promise<void> {
    // Claude-specific completion flow
  }

  async getConnectionStatus(userId: string): Promise<ProviderConnectionStatus> {
    // shared runtime-facing capability
  }

  async disconnect(userId: string): Promise<void> {
    // shared runtime-facing capability
  }

  async getValidCredentials(userId: string): Promise<ClaudeCredentials> {
    // shared runtime-facing capability
  }

  async refreshCredentialsIfNeeded(userId: string): Promise<ClaudeCredentials> {
    // shared runtime-facing capability
  }
}
```

```ts
export class OpenAICodexAuthService
  implements ProviderCredentialService<CodexCredentials> {
  async startDeviceAuthorization(userId: string): Promise<{
    attemptId: string;
    verificationUrl: string;
    userCode: string;
    intervalSeconds: number;
    expiresAt: string;
  }> {
    // Codex-specific device auth start
  }

  async pollDeviceAuthorization(
    userId: string,
    attemptId: string,
  ): Promise<{ status: "pending" | "completed" | "expired" }> {
    // Codex-specific polling
  }

  async getConnectionStatus(userId: string): Promise<ProviderConnectionStatus> {
    // shared runtime-facing capability
  }

  async disconnect(userId: string): Promise<void> {
    // shared runtime-facing capability
  }

  async getValidCredentials(userId: string): Promise<CodexCredentials> {
    // shared runtime-facing capability
  }

  async refreshCredentialsIfNeeded(userId: string): Promise<CodexCredentials> {
    // shared runtime-facing capability
  }
}
```

### 4. Generic runtime credential sync

`agent-process-manager.ts` should stop switching over provider-specific storage details.

Instead:
- look up the current provider in the registry
- ask the provider auth credential provider for its Sprite credential snapshot
- inject the appropriate env vars or write the appropriate credential file
- compare a provider-supplied sync token so we only rewrite credentials when the provider says the synced state has changed

Examples:
- Claude writes `.claude/.credentials.json`
- OpenAI Codex writes `.codex/auth.json`

`AgentProcessManager` should own credential refresh and sync cadence for agent start and message send. The Durable Object remains the owner of overall session lifecycle and state.

Example shape:

```ts
interface AuthCredentialSnapshot {
  connectionStatus: {
    connected: boolean;
    requiresReauth: boolean;
  };
  syncToken: string;
  files: Array<{
    path: string;
    contents: string;
    mode?: string;
  }>;
  envVars: Record<string, string>;
}

interface AuthCredentialProvider {
  getCredentialSnapshot(userId: string): Promise<AuthCredentialSnapshot>;
}
```

```ts
export function getAuthCredentialProvider(
  providerId: ProviderId,
  env: Env,
  logger: Logger,
): AuthCredentialProvider {
  switch (providerId) {
    case "claude-code":
      return new ClaudeAuthCredentialProvider(env, logger);
    case "openai-codex":
      return new OpenAICodexAuthCredentialProvider(env, logger);
    default: {
      const exhaustiveCheck: never = providerId;
      throw new Error(`Unhandled provider: ${exhaustiveCheck}`);
    }
  }
}
```

```ts
export class ClaudeAuthCredentialProvider implements AuthCredentialProvider {
  constructor(
    private readonly env: Env,
    private readonly logger: Logger,
  ) {}

  async getCredentialSnapshot(userId: string): Promise<AuthCredentialSnapshot> {
    const service = new ClaudeOAuthService(this.env, this.logger);
    const credentials = await service.getValidCredentials(userId);
    const contents = JSON.stringify(credentials);

    return {
      connectionStatus: { connected: true, requiresReauth: false },
      syncToken: await sha256(contents),
      files: [
        {
          path: "/home/sprite/.claude/.credentials.json",
          contents,
          mode: "0600",
        },
      ],
      envVars: {},
    };
  }
}
```

```ts
export class OpenAICodexAuthCredentialProvider implements AuthCredentialProvider {
  constructor(
    private readonly env: Env,
    private readonly logger: Logger,
  ) {}

  async getCredentialSnapshot(userId: string): Promise<AuthCredentialSnapshot> {
    const service = new OpenAICodexAuthService(this.env, this.logger);
    const credentials = await service.getValidCredentials(userId);

    const authJson = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: credentials.accessToken,
        refresh_token: credentials.refreshToken,
        id_token: credentials.idToken,
        expires_at: credentials.expiresAt,
      },
    });

    return {
      connectionStatus: { connected: true, requiresReauth: false },
      syncToken: await sha256(authJson),
      files: [
        {
          path: "/home/sprite/.codex/auth.json",
          contents: authJson,
          mode: "0600",
        },
      ],
      envVars: {},
    };
  }
}
```

```ts
type SyncedCredentialState = {
  providerId: ProviderId;
  syncToken: string;
};

export class AgentProcessManager {
  private lastSyncedCredentialState: SyncedCredentialState | null = null;

  private async buildAgentEnvVars(): Promise<Record<string, string>> {
    const providerId = this.getClientState().agentSettings.provider;
    const userId = this.getServerState().userId;
    if (!userId) {
      throw new Error("Missing user id");
    }

    const credentialProvider = getAuthCredentialProvider(
      providerId,
      this.env,
      this.logger,
    );
    const snapshot = await credentialProvider.getCredentialSnapshot(userId);

    if (!snapshot.connectionStatus.connected) {
      throw new Error("Provider auth required");
    }

    await this.syncAuthCredentialsToSprite(providerId, snapshot);
    return snapshot.envVars;
  }

  private async syncAuthCredentialsToSprite(
    providerId: ProviderId,
    snapshot: AuthCredentialSnapshot,
  ): Promise<void> {
    const spriteName = this.getServerState().spriteName;
    if (!spriteName) {
      throw new Error("Sprite not available");
    }

    const snapshotMatches =
      this.lastSyncedCredentialState?.providerId === providerId &&
      this.lastSyncedCredentialState?.syncToken === snapshot.syncToken;

    if (snapshotMatches) {
      return;
    }

    const sprite = new WorkersSpriteClient(
      spriteName,
      this.env.SPRITES_API_KEY,
      this.env.SPRITES_API_URL,
    );

    for (const file of snapshot.files) {
      await sprite.writeFile(
        file.path,
        file.contents,
        file.mode ? { mode: file.mode } : undefined,
      );
    }

    this.lastSyncedCredentialState = {
      providerId,
      syncToken: snapshot.syncToken,
    };
  }
}
```

## API changes

### `GET /models`

Add a new provider-grouped catalog endpoint.

Response shape should be provider-grouped rather than flat. Each provider entry should include:
- `providerId`
- `providerName`
- `connected`
- `requiresReauth`
- `defaultModel`
- `authMethods`
- `models`

Each model entry should include:
- `id`
- `displayName`
- `isDefault`
- `selectable`

Notes:
- the same model id may appear under multiple providers in the future
- choosing a model in the UI also chooses the provider group it was selected under

v1 metadata examples:
- Claude subscription type
- Claude rate limit tier

### Auth routes

Keep provider-specific auth routes for now. We do not need a generic wildcard auth API yet.

Recommended route shape:
- `/auth/claude/*`
- `/auth/openai-codex/*`

The important part is that both route groups should delegate to the same provider registry for runtime-facing operations where possible.

Examples:
- `GET /auth/claude/status`
- `POST /auth/claude/token`
- `POST /auth/claude/disconnect`
- `POST /auth/openai-codex/device/start`
- `GET /auth/openai-codex/device/attempts/:attemptId`
- `POST /auth/openai-codex/disconnect`

This keeps auth initiation/completion payloads provider-specific while still letting the rest of the app rely on shared provider/runtime abstractions.

Example route hookup:

```ts
// services/api-server/src/lib/ai-auth/runtime-registry.ts
export function getProviderCredentialService(
  providerId: ProviderId,
  env: Env,
  logger: Logger,
): ProviderCredentialService<unknown> {
  switch (providerId) {
    case "claude-code":
      return new ClaudeOAuthService(env, logger);
    case "openai-codex":
      return new OpenAICodexAuthService(env, logger);
    default: {
      const exhaustiveCheck: never = providerId;
      throw new Error(`Unhandled provider: ${exhaustiveCheck}`);
    }
  }
}
```

```ts
// services/api-server/src/routes/auth/claude/claude.routes.ts
claudeAuthRoutes.openapi(getClaudeStatusRoute, async (c) => {
  const user = c.get("user");
  const service = getProviderCredentialService("claude-code", c.env, logger);
  const status = await service.getConnectionStatus(user.id);
  return c.json(status, 200);
});

claudeAuthRoutes.openapi(postClaudeDisconnectRoute, async (c) => {
  const user = c.get("user");
  const service = getProviderCredentialService("claude-code", c.env, logger);
  await service.disconnect(user.id);
  return c.json({ ok: true as const }, 200);
});
```

```ts
// services/api-server/src/routes/auth/openai-codex/openai-codex.routes.ts
openAICodexAuthRoutes.openapi(getOpenAICodexStatusRoute, async (c) => {
  const user = c.get("user");
  const service = getProviderCredentialService("openai-codex", c.env, logger);
  const status = await service.getConnectionStatus(user.id);
  return c.json(status, 200);
});
```

If several future providers converge on the same start/complete flow shape, we can introduce generic provider-scoped routes later. That should be driven by real convergence, not by the current two implementations.

## Shared type changes

### Session provider rename

Rename:
- `codex-cli` -> `openai-codex`

Files that currently encode provider identity in shared types should move to:
- `ProviderId`
- provider-scoped model definitions

Backward compatibility:
- no aliasing layer
- rename stored/shared values directly to `openai-codex`

### Session settings

Keep session settings provider-scoped:
- `provider`
- `model`
- `maxTokens`

The session still runs exactly one provider at a time.

### WebSocket / client state

Replace Claude-specific auth state with generic provider auth state.

Current:
- `claudeAuthRequired`

Target:
- `providerAuthRequired: { providerId, authMethod, state } | null`

`state` values:
- `auth_required`
- `reauth_required`

This allows the chat UI to show the same reconnect panel for any provider.

## Web app design

### 1. Provider-grouped model picker

Replace the current Claude-only picker with a provider-aware picker used in:
- session creation form
- chat input

Behavior:
- group rows by provider
- connected providers show selectable models
- disconnected providers show muted or disabled models
- each disconnected provider group shows a connect CTA
- selecting a model stores both provider and model

We do not need a perfect generalized design in v1. Beta-quality is acceptable as long as the flow is obvious and can expand cleanly.

### 2. Generic connection UI

Use a shared connection shell and styling primitives, but keep the actual auth flow views provider-specific and auth-method-specific.

The shared shell should be renderable:
- inside the chat input card
- inside the session creation form
- inside a modal in the future

The UI should not use a backend-driven generic flow renderer or a generic auth-state protocol.

Instead, the frontend should branch explicitly by provider and auth method:

```tsx
function ProviderConnectView(props: {
  provider: ProviderId;
  authMethod: AuthMethod;
}) {
  switch (props.provider) {
    case "claude-code":
      switch (props.authMethod) {
        case "oauth":
          return <ClaudeOauthFlowView />;
        default: {
          const exhaustiveCheck: never = props.authMethod;
          throw new Error(`Unhandled auth method: ${exhaustiveCheck}`);
        }
      }

    case "openai-codex":
      switch (props.authMethod) {
        case "oauth":
          return <OpenAICodexOauthFlowView />;
        default: {
          const exhaustiveCheck: never = props.authMethod;
          throw new Error(`Unhandled auth method: ${exhaustiveCheck}`);
        }
      }

    default: {
      const exhaustiveCheck: never = props.provider;
      throw new Error(`Unhandled provider: ${exhaustiveCheck}`);
    }
  }
}
```

Those flow views may reuse a shared shell, for example:

```tsx
function ClaudeOauthFlowView() {
  return (
    <ProviderConnectShell title="Connect Claude">
      {/* Claude-specific copy, state, and actions */}
    </ProviderConnectShell>
  );
}
```

### 3. Form and chat behavior

Session creation:
- no longer hard-code Claude connection as the only valid provider
- use the selected provider from the picker
- prevent submit if the selected provider is disconnected
- allow the connect flow to be launched inline from the picker or connect panel

Chat input:
- use the same provider-aware picker
- if the active session provider needs auth, show the provider-specific auth flow view inline
- when auth completes, refresh connection state and resume normal interaction

## Provider-specific implementation details

### Claude

Implementation notes:
- keep current Claude auth logic in `ClaudeOAuthService`
- store Claude OAuth credentials in `user_provider_credentials`
- preserve current reauth behavior using `requires_reauth`
- keep the same runtime credential file format on Sprite

### OpenAI Codex

OpenAI Codex cannot rely on the localhost callback flow for our web/mobile product surface.

Use the Codex device-auth flow described in the OpenAI docs:
- [Codex Authentication Docs](https://developers.openai.com/codex/auth)

Implementation notes:
- stop treating `/auth/callback` as the primary product flow for Codex auth
- keep Codex auth flow logic in `OpenAICodexAuthService`
- persist device-auth attempt state in `provider_auth_attempts`
- use the Codex-specific device-auth endpoints rather than generic OAuth device-code endpoints:
  `POST /api/accounts/deviceauth/usercode` to start, `POST /api/accounts/deviceauth/token`
  to poll, then `POST /oauth/token` with the returned `authorization_code` and
  `code_verifier`
- once complete, encrypt and store the resulting credentials in `user_provider_credentials`
- before session start and before message send, refresh access tokens if needed
- write the refreshed credentials into `~/.codex/auth.json` on the Sprite

Codex auth payload stored in credentials JSON should contain the pieces needed to rebuild the auth file:
- access token
- refresh token
- id token if present
- expiry info

## Rollout phases

### Phase 1: backend and runtime

Ship the generic backend and runtime architecture first while keeping the frontend behavior close to current behavior.

Tasks:
- add new tables and migrations
- backfill legacy `claude_tokens` and `openai_tokens` into `user_provider_credentials`
- add provider registry
- keep Claude and OpenAI/Codex auth logic in provider-specific services, but move shared credential/runtime concerns behind the registry
- add `/models`
- update DO runtime credential sync to use the registry
- rename `codex-cli` to `openai-codex`

During this phase, the web app may continue to default to Claude if needed, but the backend contracts should already be generic.

### Phase 2: web frontend

Tasks:
- replace provider-specific auth state handling with shared picker/panel state where possible
- replace `ClaudeSigninPanel` with a generic connection panel
- replace the model picker with a provider-grouped picker
- update session creation to support selecting any connected provider
- update chat input to surface provider auth issues generically

## Migration notes

- Keep legacy tables in place temporarily during the backfill, but stop reading/writing them from new code once the backfill is complete.
- update stored/shared provider ids directly from `codex-cli` to `openai-codex`

## Test plan

### Database and migrations

- `user_provider_credentials` enforces uniqueness by `(user_id, provider_id, auth_method)`
- legacy Claude and OpenAI/Codex records backfill correctly
- stored/shared provider ids are updated from `codex-cli` to `openai-codex`

### Provider auth services

- disconnected state
- connected state
- reauth-required state
- Claude pasted-code completion flow
- OpenAI Codex device-auth polling flow
- token refresh before expiry

### Durable Object and runtime

- session init fails with provider-auth-required errors when credentials are missing
- message send refreshes credentials before syncing them to the Sprite
- credential files are only rewritten when the provider-supplied sync token changes
- model switching validates against the selected provider's model set

### Web app

- provider-grouped picker shows connected and disconnected providers correctly
- disconnected providers cannot be selected
- connect CTA opens the correct provider-specific auth flow
- session creation uses the selected `(provider, model)` route
- chat reconnect flow works for any provider, not just Claude

## Non-goals for v1

- API key auth UI
- free/no-auth providers
- DB-driven provider configuration
- cross-provider model normalization in the picker
