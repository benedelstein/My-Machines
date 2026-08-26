# Engineering

This document is the source of truth for repo-wide coding style and engineering conventions.

## Validation

- Use `pnpm` for all package-manager commands. If `pnpm` is not available on `PATH`, use `corepack pnpm`.
- After making changes, run the relevant package tests plus the repo-level checks:
  - `pnpm build`
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`
- For visual changes, use a local browser tool to validate the affected UI and capture a screenshot when useful.
- Use concise git commit messages.
- Do not use emojis in git messages or code comments.

## Pull Requests

- Keep each pull request focused. Use a clear title and description that explain the intent, important tradeoffs,
  and validation performed. Do not include unrelated working-tree changes.
- Before requesting review, run the relevant validation and push the complete change so reviewers inspect the
  current head.
- Monitor required checks and every GitHub review conversation. Evaluate each comment against the code; fix and
  validate valid findings, or explain why no change is appropriate.
- Reply in each review thread with the concrete outcome and, when applicable, the fixing commit before resolving
  the conversation.
- Resolve every conversation once it has been handled, including informational callouts intended for reviewers.
- Merge only after required checks and reviews pass and no unresolved conversations remain. Address any new CI or
  review feedback before merging.

## Dependencies

- If adding a dependency to multiple packages, prefer the shared catalog in `pnpm-workspace.yaml`.
- Put types used by multiple packages in `packages/shared` instead of duplicating interfaces.

## Architecture Docs

Treat `ARCHITECTURE.md` as a short, stable codemap. It should answer where major responsibilities live, what boundaries matter, and which invariants are easy to break by accident.

- Keep detailed designs, migration plans, and volatile implementation notes in focused docs under `docs/`.
- Name important modules, files, and types, but avoid turning `ARCHITECTURE.md` into a synchronized file listing.
- Add or update architectural invariants when a change alters package direction, session ownership, VM ownership, webhook flow, or external-system boundaries.
- Prefer explicit boundary statements over implied absences. For example, say that web code must not import server runtime code.

## Linting

`pnpm lint` runs package lint checks through Turbo, then runs `pnpm lint:workspace-boundaries` and `pnpm lint:logging`.

Package lint scripts own package-local checks. For example, `@repo/api-server` runs ESLint over `src/`, `tests/`, and `scripts/`, then runs `pnpm lint:module-boundaries`.

The repo-wide ESLint config enforces:

- Double-quoted strings.
- Braced control-flow bodies.
- Strict equality.
- Spaced single-line blocks.
- Explicit type-only imports.
- No type-only imports that leave runtime side-effect imports behind.
- No `any`.
- No unused variables except intentionally `_`-prefixed values.
- Maximum line length of 120 characters for code, ignoring comments, strings, template literals, regex literals, and URLs.
- Maximum file length of 1000 lines.
- Naming conventions for symbols:
  - Variables and imports use `camelCase`, `PascalCase`, or `UPPER_CASE`.
  - Functions use `camelCase`, with `PascalCase` allowed for React components and `UPPER_CASE` allowed for Next.js route handlers like `GET`.
  - Parameters use `camelCase`, with `PascalCase` allowed when passing component references.
  - Types, interfaces, classes, and enums use `PascalCase`.
  - Object properties, object methods, and type properties are exempt so API payloads, database fields, and external protocol names can keep their source shape.

When a lint rule exposes existing drift, prefer the mechanical fix over weakening the rule. If a rule is wrong for a specific case, add a narrow local disable with a reason rather than lowering the repo-wide standard.

## Import Boundaries

Import boundary checks share parser, resolver, path, and reporting types from `scripts/import-boundaries/`. The root checker and package-local checkers should keep rule logic close to the scope they enforce.

The root workspace checker is `scripts/check-workspace-boundaries.ts`. It parses TS/TSX files across the repo, resolves imports to repo paths, and enforces only workspace-level rules:

- `packages/*` cannot import `apps/*` or `services/*`.
- `apps/*` cannot import `services/*`.
- `services/*` cannot import `apps/*`.
- Unknown `@repo/*` imports fail with a clear message. Add new workspace packages to `workspacePackages` in `scripts/import-boundaries/import-resolver.ts`.

Run it directly with `pnpm lint:workspace-boundaries`.

The api-server module checker is `services/api-server/scripts/check-module-boundaries.ts`. It scans `services/api-server/src/**/*.ts` and enforces api-server structure:

- `src/runtime` and other root API-server code can import modules and `src/shared` for composition.
- `src/shared` cannot import modules.
- Modules can import their own module, `src/shared`, and workspace packages.
- Modules cannot import other modules directly. Move cross-module contracts to shared code or compose them from root/runtime code.
- Same-module imports must point downward: routes -> middleware -> services/providers -> repositories -> utils -> types.
- Module files outside known layers fail instead of silently becoming an unrestricted layer.

Run it directly with `pnpm --filter @repo/api-server lint:module-boundaries`.

For the package-level api-server file map and structure guide, see `docs/api-server/structure.md`.

Use this workflow when changing boundary rules:

1. Put repo-wide workspace rules in `scripts/check-workspace-boundaries.ts` or helpers under `scripts/import-boundaries/`.
2. Put api-server module rules in `services/api-server/scripts/check-module-boundaries.ts`.
3. Run the direct checker for the changed scope.
4. Run `pnpm lint` so Turbo runs package-local linting before the root workspace and logging checks.

Boundary checkers enforce architectural direction. They do not replace TypeScript's type checker and they do not prove that runtime data is safe. Type safety at scale also requires parsing untrusted data at system boundaries.

## Boundary Parsing

Parse external data at the boundary: convert unknown input into a typed internal shape immediately, then pass the parsed value inward.

Boundary inputs include HTTP requests, WebSocket messages, Durable Object RPC inputs, VM-agent webhook payloads, provider API responses, database rows, environment variables, and secrets.

Use Zod or an equivalent parser at the entry point:

```typescript
const parseResult = AgentChunksWebhookBody.safeParse(body);
if (!parseResult.success) {
  return failure({ code: "INVALID_WEBHOOK_BODY" });
}

return handleChunks(parseResult.data);
```

Do not validate loosely and keep passing `unknown`, raw JSON, or casted values through the system. Internal services should accept the parsed type, not the untrusted input.

## Error Handling

- Use `Result<T, E>` for expected business logic and operational failures. See `packages/shared/src/types/errors.ts`.
- Define `E` as a small tagged plain-object union with a stable `code` string.
- Do not use `Error` subclasses for normal control flow.
- Never rely on runtime type introspection for handling errors. eg. `if (typeof error === "object" && error !== null && "code" in error && error.code === "TURN_DID_NOT_START") { ... }`. You should be using Result and/or DomainError for typed error handling.
- Use `throw` ONLY for bugs, invariant violations, and unexpected integration/runtime failures.
- Convert integration exceptions into scoped business-error `Result` values at service boundaries before they flow through the rest of the app.

## Logging

The app-wide logger is available as `Logger` in `packages/shared/src/logging/index.ts`.

- Scope loggers to the module they are in.
- Use static message strings.
- Put identifiers, counts, durations, statuses, provider names, and other dynamic values in structured `fields`.
- Pass thrown or caught errors through the top-level `error` param.
- Do not call `console.*` from production source except in logger sinks.
- `pnpm lint:logging` enforces static logger messages, structured logger params, and the production `console.*` ban.

```typescript
logger.info("Received chunk", { fields: { sequence, expected } });
logger.warn("Invalid webhook body", { fields: { sessionId, issues } });
logger.error("Failed to refresh GitHub token", { fields: { userId }, error });
```

## TypeScript Style

- Prefer unabbreviated variable names over shortened names. For example, prefer `installation` over `inst`.
- Variable names should still remain concise; avoid names longer than roughly 30 characters unless clarity requires it.
- Prefer `async`/`await` over callbacks and `.then()`/`.catch()`.
- Prefer `switch` statements over if/else chains when handling discrete cases.
- Make switches over discriminated unions exhaustive.

```typescript
switch (expression) {
  case "value1":
    break;
  case "value2":
    break;
  default: {
    const exhaustiveCheck: never = expression;
    throw new Error(`Unhandled value: ${exhaustiveCheck}`);
  }
}
```

## Comments

- Add doc comments to public-facing methods.
- Public method comments should describe the method, its parameters, and return value.
- Add concise inline comments only where they clarify non-obvious code.
- Do not add docstrings or comments to code that was not changed.

## Design Taste

- Prefer the simplest working solution.
- Avoid speculative features and future-proofing.
- Avoid abstractions or helpers for single-use operations.
- If multiple uses exist, DRY up the code.
- Do not create fallback error-handling logic to cover up an error that should not exist.
