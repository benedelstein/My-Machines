import { describe, expect, it } from "vitest";
import { normalizeHost } from "@/lib/utils";

describe("normalizeHost", () => {
  it("extracts the host from URLs", () => {
    expect(normalizeHost(" https://example.com/path?q=1 ")).toBe("example.com");
    expect(normalizeHost("wss://localhost:8787/ws")).toBe("localhost:8787");
  });

  it("normalizes bare hosts without protocols", () => {
    expect(normalizeHost("localhost:8787/")).toBe("localhost:8787");
    expect(normalizeHost("https://api.example.com///")).toBe("api.example.com");
  });

  it("returns an empty string for blank input", () => {
    expect(normalizeHost("   ")).toBe("");
  });
});
