# Code Review Guidelines

Use code review to identify concrete defects and regression risks before a change is merged. Focus on behavior,
correctness, and repository invariants rather than personal style preferences.

## Prepare

- Read `docs/ENGINEERING.md`.
- Read `ARCHITECTURE.md` when the change affects architecture, session lifecycle, Durable Objects, Sprite VMs,
  webhooks, package boundaries, or external APIs.
- Establish the intended behavior and review the complete diff against its base.
- Inspect relevant callers, tests, schemas, and configuration before making a claim.

## Review Priorities

Look for:

- Incorrect behavior, missed edge cases, and regressions.
- Inelegant code that could be simplified.
- Security, authorization, validation, privacy, and data-integrity problems.
- Error-handling, concurrency, retry, ordering, and lifecycle failures.
- Violations of architecture or package boundaries.
- Missing or misleading tests for behavior introduced by the change.
- Documentation that no longer matches the implementation.

Avoid reporting speculative concerns, unrelated pre-existing issues, or preferences already enforced by formatting
and linting tools.

## Findings

Each finding should:

- Describe one actionable issue introduced by the change.
- Explain the user or system impact and the conditions that trigger it.
- Point to the smallest useful file and line range.
- Include enough evidence for the author to verify the problem.
- Use a priority that reflects impact:
  - `P0`: release-blocking or catastrophic.
  - `P1`: high-impact and should be fixed before merge.
  - `P2`: meaningful correctness or maintainability issue.
  - `P3`: minor issue worth addressing.

Order findings by priority. Keep summaries brief and do not bury findings in a general review narrative. If there are
no findings, say so and mention any important areas that could not be verified.

If the `gh` CLI is installed and you are reviewing an active PR, post your finding as inline comments on the relevant lines of code.

## Validation

Run the checks relevant to the changed code. For repository-wide validation, use:

```bash
pnpm build
pnpm lint
pnpm typecheck
pnpm test
```

Report what was run, what failed, and any validation that remains incomplete.
