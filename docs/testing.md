# Testing Guidelines

Tests should prove the behavior a change promises without freezing incidental implementation details. A good test
fails when that behavior breaks and continues to pass after a refactor that preserves it.

## What to Test

- Cover behavior-changing code changes with appropriate automated tests. If automation is impractical, explain
  why and document the manual validation performed.
- Start with the change's intended behavior. Cover its main success path, meaningful failure paths, and affected
  contract boundaries.
- Ground each expectation in the change, an existing contract, documented product behavior, or a reproduced bug. Do
  not invent requirements or copy current output into a fixture and assume every detail is correct.
- Add a regression test for a bug fix that fails for the reported bug and passes with the fix.
- Test only non-trivial behavior. Do not add tests for getters, pass-through code, or other trivial implementation solely
  to increase coverage.

## Choose the Right Scope

Choose the lowest-cost test that provides meaningful confidence. Favor small, fast tests, but use integration tests
when the behavior depends on components working together. Do not target a fixed ratio of test types.

- Test observable outputs, state changes, and side effects at the narrowest stable public boundary. Do not assert
  private methods, internal calls, call counts, or execution order unless they are required behavior.
- Use unit tests for isolated rules and integration tests for changed boundaries such as APIs, databases, queues,
  filesystems, webhooks, and provider clients.
- Do not mock collaborators solely to make a test smaller. Stub unavoidable external effects, use real local
  dependencies when practical, and verify fakes against the real contract. Never test against production services.
- Reserve end-to-end tests for critical user journeys and system wiring that lower-level tests cannot prove. Do not
  repeat lower-level edge cases through the full stack.
- Test UI behavior at the component level when possible. Validate appearance and usability with the appropriate
  browser, screenshot, or exploratory check.

## Keep Tests Useful

- Give each test one clear behavioral claim and a name that states the condition and observable outcome.
- Make the setup, one action, and expected outcome obvious. Use only the inputs and preconditions needed for the case;
  share setup or introduce helpers only when they make the behavior clearer.
- Keep assertions focused on relevant values. Prefer a useful actual-versus-expected diff over a series of assertions
  that first fails on an uninformative detail.
- Keep tests deterministic and independent of test order, shared mutable state, uncontrolled time, randomness, or
  live services.
- Keep test logic simple. Prefer explicit expected values or parameterized cases over branches, loops, or reproducing
  the production calculation inside the test.
- Test configuration through its observable effect, not by asserting that a declaration or attribute exists.
- Treat extensive setup or stubbing as a possible production design smell. Separate pure decisions from side effects
  when that also improves the production design.
- Treat coverage numbers as a signal, not the goal. Ask whether the suite would catch a plausible broken
  implementation of what the change claims to do.

## PR Checklist

- Every behavior-changing code change is covered at an appropriate level, or the coverage gap is explained.
- Important failure modes and changed contract boundaries are covered.
- Assertions exclude unrelated behavior that the change does not promise.
- Tests are readable when they pass and informative when they fail.

## References

- [Going from 0 to 1: How to write better unit tests when there are none](https://graphite.com/blog/how-to-write-better-unit-tests)
  by David Bradford.
- [The Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html) by Ham Vocke.
- [Writing Great Unit Tests: Best and Worst Practices](https://gist.github.com/vadymhimself/763e96dd8495bb77325efd082e63c9f5)
  by Steve Sanderson, archived by Vadym Himself.
- [Write tests. Not too many. Mostly integration.](https://kentcdodds.com/blog/write-tests) by Kent C. Dodds.
- [Unit testing best practices](https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-best-practices)
  by John Reese.
