import { describe, expect, it, vi } from "vitest";
import { memoizeOnce } from "../../src/shared/utils/memoize-once";

describe("memoizeOnce", () => {
  it("builds once and returns the same value", () => {
    const value = { id: "value-1" };
    const build = vi.fn(() => value);
    const getValue = memoizeOnce(build);

    expect(getValue()).toBe(value);
    expect(getValue()).toBe(value);
    expect(build).toHaveBeenCalledOnce();
  });
});
