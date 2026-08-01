import type { RuntimeBoundaryLease } from
  "@/modules/session-agent/types/runtime-boundary.types";

export type { RuntimeBoundaryLease } from
  "@/modules/session-agent/types/runtime-boundary.types";

/**
 * Serializes application-level readiness mutations and turn admission.
 *
 * Unlike Durable Object `blockConcurrencyWhile`, this gate is selective:
 * webhook handlers never acquire it and can finish an active turn while a
 * readiness caller is queued.
 */
export class RuntimeBoundaryMutex {
  private tail: Promise<void> = Promise.resolve();

  /** Runs `operation` after earlier callers and always releases the next waiter. */
  async runExclusive<Value>(
    operation: (lease: RuntimeBoundaryLease) => Promise<Value>,
  ): Promise<Value> {
    const previous = this.tail;
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = previous.then(
      () => current,
      () => current,
    );

    await previous;
    try {
      return await operation({} as RuntimeBoundaryLease);
    } finally {
      release?.();
    }
  }
}
