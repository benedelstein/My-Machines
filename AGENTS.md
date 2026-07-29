# AGENTS.md

This file provides guidance to ai agents when working with code in this repository.

## Project Overview

My Machines is a cloud-hosted agent service. Users create sessions through the API server; each session is coordinated by a Cloudflare Durable Object, runs agent work inside an isolated Fly.io Sprite VM, and receives VM output through webhooks.

Before architecture, session lifecycle, Durable Object, Sprite VM, webhook, package-boundary, or external API changes, read `ARCHITECTURE.md`.

For repo-wide coding style, dependency, error-handling, and logging conventions, read `docs/ENGINEERING.md` before making code changes.

## Build & Development Commands

### Development

- Use `pnpm` for all package-manager commands.
- If `pnpm` is not available on `PATH`, use `corepack pnpm`.

```bash
# Install dependencies
pnpm install
# Run just the API server (Cloudflare Workers)
pnpm dev:api
# Build all packages
pnpm build

# Typecheck all packages
pnpm typecheck

# Lint all packages
pnpm lint

# Clean build artifacts
pnpm clean
```

### Validating your work

NOTE: After making changes, always make sure to build, lint, and typecheck the repo.
NOTE: You have access to local browser tools to validate your visual changes. Use them.
NOTE: If you are tasked with committing to git, prefer concise messages. 

### Package-specific commands

```bash
# API Server (services/api-server)
cd services/api-server
pnpm dev           # wrangler dev
pnpm deploy        # wrangler deploy

# VM Agent (packages/vm-agent)
cd packages/vm-agent
pnpm build         # builds NDJSON and webhook bundles to dist/
pnpm test:live:agent    # Test an agent provider locally
pnpm test:live:webhook  # Test the webhook runner locally

# Shared types and utils (packages/shared)
# NOTE: build is not needed for shared, as it is a pure typescript package that is imported directly by other services
cd packages/shared
pnpm build         # tsc --noEmit
```

## Documentation / Further Information

`ARCHITECTURE.md` contains the system overview, package map, key files, tech stack, and environment notes.
`docs/` contains specific documentation about certain parts of the codebase, if needed.
`openspec/` contains the OpenSpec artifacts for proposal and change management.
`docs/ENGINEERING.md` contains repo-wide coding style and engineering conventions.
`docs/frontend/styling.md` contains web-client styling and component conventions.

## Response style

### Output
- No preamble. No "Great question!", "Sure!", etc

### Token Efficiency
- Compress responses. Every sentence must earn its place.
- No redundant context.
- No long intros or transitions between sections.
- Short responses are correct unless depth is explicitly requested.

### Sycophancy - Zero Tolerance
- Disagree when user is wrong. State the correction directly.
- Do not change a correct answer just because the user pushes back.

### Accuracy and Speculation Control
- Never speculate about code, files, or APIs you have not read.
- If referencing a file or function: read it first, then answer.
- Never invent file paths, function names, or API signatures.

### Warnings and Disclaimers
- No safety disclaimers unless there is a genuine life-safety or legal risk.

### Session Memory
- Learn user corrections and preferences within the session.
- Apply them silently. Do not re-announce learned behavior.
- If the user corrects a mistake: fix it, remember it, move on.
