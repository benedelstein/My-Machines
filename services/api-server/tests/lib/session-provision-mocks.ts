import { vi } from "vitest";

/**
 * Sprite mocks shared by the provisioning suites. This module must not import
 * application code: `vi.mock` factories load it, so a src import here would
 * create a cycle through the very module being mocked.
 */
export const mockState = {
  events: [] as string[],
  setNetworkPolicy: vi.fn(),
  execWs: vi.fn(),
  writeFile: vi.fn(),
  ensureSpriteStartupToolchain: vi.fn(),
  getReadOnlyTokenForRepo: vi.fn(),
};

/** Replaces the sprite client with one recording calls into `mockState`. */
export function mockSpriteClientModule(actual: Record<string, unknown>) {
  class WorkersSpriteClient {
    public name: string;
    constructor(name: string) {
      this.name = name;
    }
    setNetworkPolicy = mockState.setNetworkPolicy;
    getNetworkPolicy = mockState.setNetworkPolicy;
    execWs = mockState.execWs;
    writeFile = mockState.writeFile;
  }
  return {
    ...actual,
    WorkersSpriteClient,
    buildBootstrapNetworkPolicy: () => [{ domain: "bootstrap", action: "allow" }],
    buildFinalNetworkPolicy: () => [{ domain: "final", action: "allow" }],
  };
}

/** Default sprite exec behavior: successful clone, toolchain, and policy. */
export function resetProvisionMocks(): void {
  mockState.events.length = 0;
  mockState.setNetworkPolicy.mockImplementation(async (rules: unknown) => {
    mockState.events.push("setNetworkPolicy");
    return rules;
  });
  mockState.ensureSpriteStartupToolchain.mockImplementation(async () => {
    mockState.events.push("startupToolchain");
    return {
      ok: true,
      value: { contractHash: "hash-1", checkedAt: 1, results: [] },
    };
  });
  mockState.execWs.mockImplementation(async (command: string) => {
    if (command.includes("timeout")) {
      mockState.events.push("startupScript");
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (command.startsWith("test -d")) {
      mockState.events.push("cloneCheck");
      return { stdout: "empty", stderr: "", exitCode: 0 };
    }
    if (command.startsWith("mkdir -p")) {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (command.includes("git -c")) {
      mockState.events.push("cloneRepo");
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (command.includes("git rev-parse")) {
      return { stdout: "main", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  });
  mockState.getReadOnlyTokenForRepo.mockResolvedValue({
    ok: true,
    value: "readonly-token",
  });
  mockState.writeFile.mockResolvedValue(undefined);
}
