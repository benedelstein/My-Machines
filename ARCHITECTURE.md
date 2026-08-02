# Architecture

My Machines is a cloud-hosted agent service. It runs agents inside isolated VMs (Fly.io Sprites) and coordinates sessions through Cloudflare Durable Objects on an API server.

Users connect to the API server and create a session to make changes in a repository. Each session gets its own Durable Object, which provisions a Sprite VM, clones the repository, runs an agent process on the VM, and communicates with the API server and the client.

The Durable Object is the source of truth and coordinator for the session. It stores all messages in its SQLite database.

The VM owns the execution runtime for its workflows, and the Durable Object dispatches messages from users to the VM. The VM runs independently and submits output back to the Durable Object through webhook HTTP requests. This is done because Durable Objects are not designed to be long-lived servers, and the VM owns its execution context without relying on a stable WebSocket connection to the Durable Object. Webhooks are simple and reliable because incoming HTTP requests wake the Durable Object.

## Packages

- **@repo/api-contract** (`packages/api-contract/`) - The client API contract: every exported Zod schema (HTTP request/response, WebSocket messages, Agents SDK ClientState) is transpiled to Swift (`apps/ios/Modules/CoreAPI`) by `packages/api-contract/codegen` and consumed as `z.infer` types by server/web. Server-internal types do not belong here. See `docs/api-type-codegen.md`.
- **@repo/shared** (`packages/shared/`) - Server-side shared code: vm-agent I/O schemas, provider registry, logging, utils, tool normalization. Re-exports the entire api-contract, so consumers import everything from `@repo/shared`. If a type is part of the client contract put it in api-contract; otherwise put it here.
- **@repo/sprites-client** (`packages/sprites-client/`) - The only place that speaks the Fly.io Sprites API. Owns the Sprite lifecycle client, the exec WebSocket session, the network egress policy builder, and the Sprites REST connectors client. Sprites-domain types only; callers wrap it in their own services rather than re-deriving its wire shapes.
- **@repo/vm-agent** (`packages/vm-agent/`) - Runs inside the Sprite VM. Provides a shared AI SDK agent harness with Claude Code and OpenAI Codex providers. The current deployment path uses the webhook entrypoint; the NDJSON entrypoint remains for the legacy stdin/stdout path. Uses Bun runtime.
- **@repo/api-server** (`services/api-server/`) - Cloudflare Workers API using Hono. `src/runtime/` contains Worker runtime entrypoints such as the `SessionAgentDO` Durable Object, while `src/modules/` contains route, service, repository, and type code by domain.
- **@repo/web** (`apps/web/`) - Next.js web client.
- **@repo/discord-bot** (`apps/discord-bot/`) - Cloudflare Worker that adapts the Discord `/cloude` slash command into integration session requests against the API server. See `docs/discord-bot.md`.

## Key Files

- `services/api-server/src/runtime/session-agent.do.ts` - Core session management, VM lifecycle, WebSocket handling, and webhook RPC handlers.
- `services/api-server/src/modules/session-agent/services/runtime-migration-coordinator.service.ts` - Serial per-session runtime reconciliation, backed by Durable Object-local attempt records and gated by the runtime boundary.
- `packages/vm-agent/src/index-webhook.ts` - Current vm-agent webhook entrypoint.
- `packages/api-contract/src/websocket-api.ts` - WebSocket message schemas.

## Architectural Invariants

- The Durable Object is the session authority. It owns session lifecycle, message state, client WebSocket handling, and VM coordination.
- Runtime migrations run only from mutex-held readiness, defer while a turn is active, and treat their applied revision as the sole reconciliation checkpoint.
- The Sprite VM owns the execution runtime. It runs the agent process and submits output back to the Durable Object through authenticated webhooks.
- Browser clients cannot mutate Durable Object server state directly. Client messages go through typed API or WebSocket messages and are validated before handling.
- Cross-package contracts live in `packages/api-contract` (client-facing) and `packages/shared` (server/VM internal). Server, VM, and web packages should not duplicate shared DTOs or protocol types.
- Web code must not import server or VM runtime code. Server and VM code must not import web UI code.
- External inputs are parsed at the boundary before entering internal services. This includes HTTP bodies, WebSocket payloads, webhooks, provider responses, database rows, environment variables, and secrets.

## Boundaries

- **Web client to API server** - `apps/web` talks to the API through HTTP routes and WebSocket messages. Shared protocol types come from `@repo/shared`.
- **API routes to Durable Objects** - Hono routes authenticate, parse, and route requests. Session-agent routes depend on the shared `SessionAgentRpc` protocol and Durable Object binding, not the `SessionAgentDO` class. `SessionAgentDO` coordinates session state and execution from `services/api-server/src/runtime/session-agent.do.ts`.
- **Durable Object to Sprite VM** - The Durable Object starts VM work and receives VM output through webhook routes. Do not reintroduce long-lived Durable Object ownership of VM stdout as the main execution path.
- **Sprites API access** - All Sprites API calls go through `@repo/sprites-client`. Services do not hand-roll Sprites HTTP requests or duplicate its wire types.
- **Connector provisioning** - `@repo/sprites-client` owns the Sprites REST wire format. The API-server shared connector integration owns validation plus create/verify/delete orchestration and uses the API server's existing `SPRITES_API_KEY`; there is no separate provisioning service. Each session mints one label-scoped connector during provisioning so the Sprite never holds the webhook credential. While Fly's gateway rejects Git smart-HTTP Accept headers, the connector authenticates a control-plane mint for five-minute ephemeral Git tokens and Git sends those tokens directly to the Worker proxy. Sessions provisioned before connectors existed keep their legacy Sprite-held paths until they age out. See `docs/sprite-connectors.md`.
- **Workspace import graph** - Repo-wide package direction is enforced by `scripts/check-workspace-boundaries.ts`. `packages/*` cannot import `apps/*` or `services/*`; `apps/*` cannot import `services/*`; `services/*` cannot import `apps/*`.
- **API module graph** - API-server module direction is enforced by `services/api-server/scripts/check-module-boundaries.ts` as part of the api-server package lint. Modules can import their own module, `src/shared`, and workspace packages. `src/shared` cannot import modules. Runtime/root API-server code can compose modules and shared code.

See `docs/api-server/structure.md` for the api-server package file map and module structure.

## Cross-Cutting Concerns

- **Validation** - Zod schemas in `packages/shared` define cross-package payloads. Internal services should receive parsed values, not raw JSON or loosely cast inputs.
- **Logging** - Use `createLogger` from `@repo/shared`, scoped to the source file name, and call `initializeLogger` once per request so the format follows `ENVIRONMENT` and the level follows `LOG_LEVEL`. Keep structured values in `fields` instead of interpolating identifiers into log messages.
- **Authentication and repo access** - GitHub App auth, user tokens, provider credentials, and session repo authorization are server-side concerns. Web code should call API surfaces instead of importing auth logic.
- **Turn execution** - `docs/turn-workflow.md` contains the more detailed turn lifecycle. Keep this file limited to stable ownership and boundary facts.

## Tech Stack

- **pnpm workspaces** with Turbo for monorepo orchestration.
- **Cloudflare** Workers, Agents SDK, Durable Objects, and SQLite-backed Durable Object storage.
- **AI SDK** for abstracting over LLM data types and interaction.
- **Hono** for server middleware.
- **Zod** for runtime type validation.
- **Bun** runtime for vm-agent.
- **Sprites** for isolated VM execution.
- **GitHub API** for repo management and authentication.

## External API Notes

- Always look up the Sprites API docs instead of relying on internal knowledge if behavior is uncertain.
- Prefer numeric GitHub repository IDs over owner/name strings because numeric IDs are stable.
- Use the GitHub Apps API docs when changing GitHub App authentication, installation, or repository access behavior.

## Environment And Secrets

Required secrets for `api-server` are set through `wrangler secret put`:

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `SPRITES_API_KEY`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`
- `GITHUB_APP_CLIENT_SECRET`
- `TOKEN_ENCRYPTION_KEY`
- `NATIVE_ACCESS_TOKEN_SIGNING_KEY`
- `WEBSOCKET_TOKEN_SIGNING_KEY`
- `VOICE_TOKEN_SIGNING_KEY`
- `FIREBASE_SERVICE_ACCOUNT_JSON_BASE64`

Additional environment bindings and non-secret vars live in `services/api-server/src/shared/types/env.ts` and `services/api-server/wrangler.jsonc`.
