# My Machines

My Machines is a background agent service to manage agent-driven software development teams.  It was inspired by [Ramp's background-agent](https://builders.ramp.com/post/why-we-built-our-background-agent).

It was designed with these ideas in mind:

- **Bring your own harness** — connect your Claude Code or Codex subscription and use their native harness (more providers to come). No API keys and no custom harness.
- **Complete agent environments** - each agent gets its own stateful computer to work within, just like a human developer would use.
- **Github workflows** - Github is the primary source control integration. Connect your account and repositories to get started. Github authorization is scoped by user, not just by organization, and is enforced on each session. See [Authentication and Authorization](#authentication-and-authorization) for more details.

## How to Use It

Visit [https://www.mymachines.dev](https://www.mymachines.dev) to get started. Authenticate with your Github account and install the Github app to connect your repositories, connect your Claude Code or Codex subscription, and start creating tasks.

## Architecture

The system is designed around Cloudflare Durable Objects for session coordination and persistence. Each session gets its own Durable Object, which provisions a VM and coordinates between the agent running on the VM and the client.

For a detailed architecture map, read [ARCHITECTURE.md](./ARCHITECTURE.md).

### Repository Layout

This is a typescript monorepo using pnpm and Turbo. The code is organized like so:

```text
|-- apps/                    # User-facing applications
|   |-- web/                 # Next.js web client
|   `-- discord-bot/         # Cloudflare Worker Discord Interactions adapter
|-- services/                # Backend services
|   `-- api-server/          # Cloudflare Worker API and Durable Object runtime
|-- packages/                # Shared packages
|   |-- shared/              # Shared protocol types, schemas, logging, and utilities
|   `-- vm-agent/            # Agent runner bundled into Sprite VMs
|-- scripts/                 
|-- docs/                    # Architecture and workflow documentation
|-- .github/workflows/       # CI and deploy workflows
|-- package.json
|-- pnpm-workspace.yaml
```


| Path                  | Package            | Purpose                                                                                     |
| --------------------- | ------------------ | ------------------------------------------------------------------------------------------- |
| `apps/web`            | `@repo/web`        | Next.js web client for auth, repo selection, session creation, and chat                     |
| `apps/discord-bot`    | `@repo/discord-bot`| Cloudflare Worker Discord Interactions adapter for the `/session` slash command              |
| `services/api-server` | `@repo/api-server` | Cloudflare Worker API, Durable Object runtime, GitHub auth, Sprites orchestration, webhooks |
| `packages/vm-agent`   | `@repo/vm-agent`   | Bun-based agent runner bundled into the Sprite VM execution path                            |
| `packages/shared`     | `@repo/shared`     | Shared types, schemas, logging contracts, and protocol definitions                          |
| `scripts`             | `@repo/scripts`    | Development scripts                                                                         |


### Tech Stack

- **pnpm workspaces** with [Turbo](https://turbo.build/) for monorepo orchestration.
- **Cloudflare Workers** for the API server.
- **[Cloudflare Agents SDK](https://agents.cloudflare.com/)** for managing message state and streaming data between client and server with websockets.
- **[Fly.io Sprites](https://sprites.dev/)** for stateful sandbox VMs.
- **Next.js** for the web client.
- **[AI SDK](https://ai-sdk.dev/)** for abstracting over LLM data types and harnesses.
- **[Zod](https://zod.dev/)** for runtime type validation.

### Authentication and Authorization

Users authenticate with their Github account, and then install the Github app to authorize My Machines to access their repositories.
Users authorize the Github app to access their personal organization, or an organization that they own.

If you are a member of an organization and your admin has granted access, you will be able to create sessions on all repositories for which:

1. you have access, and;
2. The owner of the org has granted access.

See [docs/auth.md](./docs/auth.md) for the authentication flow.
See [docs/github-app-auth.md](./docs/github-app-auth.md) for the Github app setup and authorization flow.

### Development Style

The repo is set up for agent-driven development. It relies on strict linting rules and custom linters to enforce code style and architecture (e.g. import boundaries).

Larger changes are managed via [openspec](https://openspec.dev/) to generate a complete proposal with design, specs, and tasks ready for implementation. Openspec plans are checked into the repo at `openspec/`

For more details, read [docs/ENGINEERING.md](./docs/ENGINEERING.md).

## Running This Repository

### Prerequisites

See secrets in .env.local for all necessary environment variables.
You will need:

- A fly.io account for sprites api key
- A github app

Install dependencies:

```bash
pnpm install
```

Copy env files:

```bash
cp services/api-server/.env.example services/api-server/.env.local
cp apps/web/.env.example apps/web/.env.local
```

The API server needs Sprites, GitHub App, provider, token-encryption, and Worker URL configuration.
The web app needs the API URL, GitHub App slug, and session cookie secret.

### Running Locally

Apply local D1 migrations first:

```bash
pnpm --filter @repo/api-server db:migrate
```

Run the local stack:

```bash
pnpm dev:local
```

This starts:

- `@repo/web` on the Next.js dev server
- `@repo/api-server` through `wrangler dev`
- `@repo/scripts`, which runs the configured `cloudflared` tunnel to `http://localhost:8787`. Set up a tunnel to your local dev server for webhook delivery (Github uses this).

You can also run web and API independently:

```bash
pnpm dev:web
pnpm dev:api
```

## Development Commands

Run repo-wide validation:

```bash
pnpm build
pnpm lint
pnpm typecheck
pnpm test
```

Useful package commands:

```bash
# API server
pnpm --filter @repo/api-server dev
pnpm --filter @repo/api-server db:migrate
pnpm --filter @repo/api-server db:migrate:prod
pnpm --filter @repo/api-server deploy

# Web app
pnpm --filter @repo/web dev
pnpm --filter @repo/web build

# VM agent
pnpm --filter @repo/vm-agent build
pnpm --filter @repo/vm-agent test:live:agent
pnpm --filter @repo/vm-agent test:live:webhook
```

## Self Hosting

Self-hosting is possible, but this repo is not currently packaged as a one-click
distribution. A production self-host runs three owned pieces:

- A Cloudflare Worker deployment for `services/api-server`, including the
`SessionAgentDO` Durable Object, a D1 database, an R2 bucket, and a public API
domain.
- A Fly.io Sprites account and API key. The Worker provisions per-session Sprite
VMs, and `WORKER_URL` must be reachable from those VMs for webhooks and the Git
proxy.
- A Next.js deployment for `apps/web` on a host that supports Next.js route
handlers.

You do not need to fork the project to run it locally. For a durable production
self-host, keep your own fork, deployment branch, or cloned copy because
deployment-specific values currently live in tracked files:
`services/api-server/wrangler.jsonc` contains the Cloudflare account ID, Worker
name, D1 database ID, R2 bucket, custom route, GitHub App IDs and slug, web
origin, and preview-origin allowlist; the deploy workflow is
[.github/workflows/deploy-api-server.yml](./.github/workflows/deploy-api-server.yml).
If you want to track upstream, a fork with a small self-host config patch is the
practical route.

Minimum setup outline:

1. Create a GitHub App. Set the user authorization callback URL to
  `https://<api-domain>/auth/callback`, set the webhook URL to
   `https://<api-domain>/webhooks/github`, grant `Contents: Read & write` and
   `Metadata: Read-only`, and subscribe to `Installation` and `Repository`
   events.
2. Create Cloudflare resources for the API server: a D1 database, an R2 bucket,
  a Durable Object migration, and a custom API route/domain. You can keep the
   existing resource names in your own Cloudflare account, or change
   `services/api-server/wrangler.jsonc` and the D1 migration scripts together.
3. Create a web project for `apps/web`. On Vercel, import your repo, set the
  project root directory to `apps/web`, use the Next.js framework preset, leave
   install and build commands on the detected defaults unless you have custom
   monorepo settings, and set these environment variables:

```bash
NEXT_PUBLIC_API_URL=https://<api-domain>
NEXT_PUBLIC_GITHUB_APP_SLUG=<github-app-slug>
SESSION_COOKIE_SECRET=<base64-encoded-32-byte-key>
```

   Other Next.js hosts are fine if they support route handlers and can run the
   app from `apps/web`; the package commands are `pnpm --filter @repo/web build`
   and `pnpm --filter @repo/web start`.

1. Edit `services/api-server/wrangler.jsonc` for your Cloudflare account, API
  domain, GitHub App IDs/slug, web origin, preview-origin allowlist, D1
   database ID, R2 bucket, and Worker route.
2. Set Worker secrets from `services/api-server`:

```bash
cd services/api-server
pnpm wrangler secret put ANTHROPIC_API_KEY # used for ad-hoc generation of session titles, pr descriptions, etc.
pnpm wrangler secret put OPENAI_API_KEY # used for voice transcription
pnpm wrangler secret put SPRITES_API_KEY
pnpm wrangler secret put GITHUB_APP_PRIVATE_KEY
pnpm wrangler secret put GITHUB_WEBHOOK_SECRET
pnpm wrangler secret put GITHUB_APP_CLIENT_SECRET
pnpm wrangler secret put TOKEN_ENCRYPTION_KEY
pnpm wrangler secret put NATIVE_ACCESS_TOKEN_SIGNING_KEY
pnpm wrangler secret put WEBSOCKET_TOKEN_SIGNING_KEY
pnpm wrangler secret put VOICE_TOKEN_SIGNING_KEY
```

`TOKEN_ENCRYPTION_KEY` must be a base64-encoded 32-byte key; the same format
is useful for `NATIVE_ACCESS_TOKEN_SIGNING_KEY` and the web app's
`SESSION_COOKIE_SECRET`.

```bash
openssl rand -base64 32 | pbcopy
```

1. Apply remote D1 migrations and deploy the Worker:

```bash
pnpm --filter @repo/api-server db:migrate:prod
pnpm --filter @repo/api-server deploy
```

1. Deploy the web project and make sure the GitHub App callback, Worker
  `WORKER_URL`, Worker `WEB_ORIGIN`, and web `NEXT_PUBLIC_API_URL` all point at
   the domains you deployed.

The included API deploy workflow installs dependencies, builds, typechecks,
lints, tests, applies remote D1 migrations, and deploys the Worker with
Wrangler on relevant pushes to `main`. Web CI is defined in
[.github/workflows/ci-web.yml](./.github/workflows/ci-web.yml), but this repo
does not currently include a web deployment workflow.

## Roadmap

Near-term areas of work include:

- Better high-level UX for orchestrating sessions across repositories.
- Exposing more of the VM surface to the agent and user — browser use, local shells, etc.
- More clients (iOS, mac, cli, slack, etc.)
- Richer agent interaction primitives, such as file mentions, slash commands, and user-question tools.
- Faster startup through pre-warmed or reusable VM environments.

If you'd like to contribute to this repo, see [contributing](#contributing).

## License

My Machines is licensed under the GNU Affero General Public License v3.0. See [LICENSE](./LICENSE).

## Contributing

Before changing architecture, session lifecycle, Durable Object behavior, Sprite VM provisioning,
webhooks, package boundaries, or external API integrations, read [ARCHITECTURE.md](./ARCHITECTURE.md).

Before making repo-wide code changes, read [docs/ENGINEERING.md](./docs/ENGINEERING.md). It covers
validation, package boundaries, logging, error handling, TypeScript style, and design expectations.

General expectations:

- Keep cross-package protocol types in `packages/shared`.
- Parse external inputs at the boundary before passing values into internal services.
- Respect workspace import direction: packages do not import apps/services, apps do not import services,
and services do not import apps.
- Use structured logging through the shared logger, not production `console.*`.
- Run the relevant package tests plus `pnpm build`, `pnpm lint`, `pnpm typecheck`, and `pnpm test`
before opening a pull request.
