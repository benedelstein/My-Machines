import { describe, expect, it } from "vitest";
import {
  buildBootstrapNetworkPolicy,
  buildFinalNetworkPolicy,
  getDefaultNetworkAllowlistDomains,
  getProviderNetworkPolicyRules,
} from "../src/network-policy";
import { buildConnectorGatewayUrl } from "../src/connector-gateway";

describe("Sprite network policies", () => {
  it("builds bootstrap policy from default policy plus worker host", () => {
    const policy = buildBootstrapNetworkPolicy({ workerHostname: "worker.test" });

    expect(policy).toContainEqual({ domain: "worker.test", action: "allow" });
    expect(policy.at(-1)).toEqual({ domain: "*", action: "deny" });
    expect(policy).toContainEqual({ domain: "github.com", action: "allow" });
  });

  it("lists default allowlist domains without deny rules", () => {
    const domains = getDefaultNetworkAllowlistDomains();

    expect(domains).toContain("github.com");
    expect(domains).toContain("registry.npmjs.org");
    expect(domains).not.toContain("*");
  });

  it("uses default policy for default mode", () => {
    const policy = buildFinalNetworkPolicy({
      workerHostname: "worker.test",
      providerId: "openai-codex",
      network: { mode: "default" },
    });

    expect(policy).toContainEqual({ domain: "worker.test", action: "allow" });
    expect(policy).toContainEqual({ domain: "github.com", action: "allow" });
    expect(policy.at(-1)).toEqual({ domain: "*", action: "deny" });
  });

  it("uses custom policy without default allowlist", () => {
    const policy = buildFinalNetworkPolicy({
      workerHostname: "worker.test",
      providerId: "openai-codex",
      network: {
        mode: "custom",
        includeDefaultAllowlist: false,
        extraAllowlist: ["api.stripe.com"],
      },
    });

    expect(policy).toContainEqual({ domain: "worker.test", action: "allow" });
    expect(policy).toContainEqual({ domain: "api.stripe.com", action: "allow" });
    expect(policy).toContainEqual({ domain: "api.openai.com", action: "allow" });
    expect(policy).not.toContainEqual({ domain: "github.com", action: "allow" });
    expect(policy.at(-1)).toEqual({ domain: "*", action: "deny" });
  });

  it("uses custom policy with default allowlist", () => {
    const policy = buildFinalNetworkPolicy({
      workerHostname: "worker.test",
      providerId: "openai-codex",
      network: {
        mode: "custom",
        includeDefaultAllowlist: true,
        extraAllowlist: ["api.stripe.com"],
      },
    });

    expect(policy).toContainEqual({ domain: "api.stripe.com", action: "allow" });
    expect(policy).toContainEqual({ domain: "github.com", action: "allow" });
  });

  it("locks final policy to worker and provider hosts", () => {
    const policy = buildFinalNetworkPolicy({
      workerHostname: "worker.test",
      providerId: "claude-code",
      network: { mode: "locked" },
    });

    expect(policy).toContainEqual({ domain: "worker.test", action: "allow" });
    expect(policy).toContainEqual({ domain: "api.anthropic.com", action: "allow" });
    expect(policy).not.toContainEqual({ domain: "github.com", action: "allow" });
    expect(policy.at(-1)).toEqual({ domain: "*", action: "deny" });
  });

  it("allows all outbound for open mode", () => {
    expect(buildFinalNetworkPolicy({
      workerHostname: "worker.test",
      providerId: "openai-codex",
      network: { mode: "open" },
    })).toEqual([{ domain: "*", action: "allow" }]);
  });

  it("selects OpenAI Codex provider hosts", () => {
    expect(getProviderNetworkPolicyRules("openai-codex")).toContainEqual({
      domain: "api.openai.com",
      action: "allow",
    });
  });

  it("keeps the connector gateway reachable in restricted modes", () => {
    const gateway = { domain: "api.sprites.dev", action: "allow" };
    const restrictedModes = [
      { mode: "default" } as const,
      { mode: "locked" } as const,
      { mode: "custom", extraAllowlist: ["api.example.com"], includeDefaultAllowlist: false } as const,
      { mode: "custom", extraAllowlist: [], includeDefaultAllowlist: true } as const,
    ];

    for (const network of restrictedModes) {
      const policy = buildFinalNetworkPolicy({
        workerHostname: "worker.test",
        providerId: "claude-code",
        network,
        connectorGatewayHostname: "api.sprites.dev",
      });
      expect(policy).toContainEqual(gateway);
      expect(policy.at(-1)).toEqual({ domain: "*", action: "deny" });
    }

    expect(buildBootstrapNetworkPolicy({
      workerHostname: "worker.test",
      connectorGatewayHostname: "api.sprites.dev",
    })).toContainEqual(gateway);
  });

  it("omits the gateway rule when no gateway hostname is given", () => {
    const policy = buildFinalNetworkPolicy({
      workerHostname: "worker.test",
      providerId: "claude-code",
      network: { mode: "locked" },
    });

    expect(policy).not.toContainEqual({ domain: "api.sprites.dev", action: "allow" });
  });
});

describe("buildConnectorGatewayUrl", () => {
  it("builds the custom API gateway base for a connection id", () => {
    expect(buildConnectorGatewayUrl("https://api.sprites.dev", "conn-1")).toBe(
      "https://api.sprites.dev/v1/gateway/custom_api/conn-1",
    );
  });

  it("tolerates a trailing slash on the API origin", () => {
    expect(buildConnectorGatewayUrl("https://api.sprites.dev/", "conn-1")).toBe(
      "https://api.sprites.dev/v1/gateway/custom_api/conn-1",
    );
  });
});
