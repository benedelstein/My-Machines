import { describe, expect, it } from "vitest";
import { RuntimeBoundaryMutex } from "../../src/runtime/runtime-boundary-mutex";

describe("RuntimeBoundaryMutex", () => {
  it("runs queued callers in FIFO order", async () => {
    const mutex = new RuntimeBoundaryMutex();
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const order: string[] = [];

    const first = mutex.runExclusive(async () => {
      order.push("first:start");
      firstEntered.resolve();
      await releaseFirst.promise;
      order.push("first:end");
    });
    await firstEntered.promise;

    const second = mutex.runExclusive(async () => {
      order.push("second");
    });
    const third = mutex.runExclusive(async () => {
      order.push("third");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    releaseFirst.resolve();
    await Promise.all([first, second, third]);

    expect(order).toEqual(["first:start", "first:end", "second", "third"]);
  });

  it("releases the next caller when an operation rejects", async () => {
    const mutex = new RuntimeBoundaryMutex();
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    let secondRan = false;

    const first = mutex.runExclusive(async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
      throw new Error("expected failure");
    });
    await firstEntered.promise;
    const second = mutex.runExclusive(async () => {
      secondRan = true;
    });

    releaseFirst.resolve();
    await expect(first).rejects.toThrow("expected failure");
    await second;

    expect(secondRan).toBe(true);
  });
});
