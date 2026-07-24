import { describe, expect, it } from "vitest";
import { MintConnectorRequestSchema } from "../src/types";

const validRequest = {
  name: "connector-test",
  baseApiUrl: "https://api.example.com",
  token: "dummy",
  testUrl: "https://api.example.com/health",
  spriteLabels: ["session:test"],
};

describe("MintConnectorRequestSchema", () => {
  it("accepts a same-origin HTTPS connector", () => {
    expect(MintConnectorRequestSchema.safeParse(validRequest).success).toBe(true);
  });

  it("rejects credentials embedded in connector URLs", () => {
    expect(MintConnectorRequestSchema.safeParse({
      ...validRequest,
      baseApiUrl: "https://user:password@api.example.com",
    }).success).toBe(false);
  });

  it("rejects a test URL on another origin", () => {
    expect(MintConnectorRequestSchema.safeParse({
      ...validRequest,
      testUrl: "https://other.example.com/health",
    }).success).toBe(false);
  });
});
