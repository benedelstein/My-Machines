import { describe, expect, it } from "vitest";
import { MintConnectorRequestSchema } from "../../src/shared/integrations/sprite-connectors/connector-provisioning.schema";

const validRequest = {
  name: "connector-test",
  baseApiUrl: "https://api.example.com",
  token: "dummy",
  testUrl: "https://api.example.com/health",
  spriteLabels: ["session:test-123"],
  allowedEndpoints: ["/health"],
};

describe("MintConnectorRequestSchema", () => {
  it("accepts a same-origin HTTPS connector", () => {
    expect(MintConnectorRequestSchema.safeParse(validRequest).success).toBe(true);
  });

  it("rejects a session connector without pinned endpoints", () => {
    const { allowedEndpoints: _allowedEndpoints, ...withoutPins } = validRequest;
    expect(MintConnectorRequestSchema.safeParse(withoutPins).success).toBe(false);
  });

  it("accepts environment labels without pinned endpoints", () => {
    const { allowedEndpoints: _allowedEndpoints, ...withoutPins } = validRequest;
    expect(MintConnectorRequestSchema.safeParse({
      ...withoutPins,
      spriteLabels: ["env:environment-1"],
    }).success).toBe(true);
  });

  it.each([
    ["an unprefixed label", "test-12345678"],
    ["an unknown class prefix", "team:test-12345678"],
    ["a short identifier", "session:short"],
    ["an empty identifier", "session:"],
  ])("rejects %s", (_description, label) => {
    expect(MintConnectorRequestSchema.safeParse({
      ...validRequest,
      spriteLabels: [label],
    }).success).toBe(false);
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

  it.each([
    "https://localhost",
    "https://foo.localhost",
    "https://metadata.internal",
    "https://printer.local",
    "https://127.0.0.1",
    "https://10.1.2.3",
    "https://172.16.0.1",
    "https://192.168.1.1",
    "https://169.254.169.254",
    "https://100.100.0.1",
    "https://[::1]",
    "https://[fd00::1]",
    "https://[fe80::1]",
  ])("rejects internal host %s", (internalUrl) => {
    expect(MintConnectorRequestSchema.safeParse({
      ...validRequest,
      baseApiUrl: internalUrl,
      testUrl: `${internalUrl}/health`,
    }).success).toBe(false);
  });
});
