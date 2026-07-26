import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Logger } from "@repo/shared";
import type { WorkersSpriteClient } from "@repo/sprites-client";
import { DEFAULT_NETWORK_POLICY } from "@repo/sprites-client";
import {
  CLAUDE_CODE_STARTUP_CHECK_ID,
  MIN_CLAUDE_CODE_CLI_VERSION,
  OPENAI_CODEX_INSTALL_SCRIPT_URL,
  ensureSpriteStartupToolchain,
  getProviderStartupToolchainChecks,
} from "../../src/shared/integrations/sprite-startup-toolchain";
import {
  getClaudeStartupToolchainChecks,
} from "../../src/shared/integrations/sprite-startup-toolchain/providers/claude";
import {
  getOpenAICodexStartupToolchainChecks,
} from "../../src/shared/integrations/sprite-startup-toolchain/providers/openai-codex";

const MIN_CODEX_CLI_VERSION = "0.144.0";

function createLogger(): Logger {
  return {
    log() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    scope() {
      return this;
    },
  };
}

function createSprite(results: Array<{ stdout: string; stderr?: string; exitCode: number }>) {
  return {
    execWs: vi.fn(async () => {
      const result = results.shift();
      if (!result) {
        throw new Error("Unexpected execWs call");
      }
      return { stderr: "", ...result };
    }),
  } as unknown as WorkersSpriteClient;
}

describe("startup toolchain dispatch", () => {
  it("returns provider checks through exhaustive dispatch", () => {
    expect(getProviderStartupToolchainChecks("openai-codex", {
      logger: createLogger(),
    }).map((check) => check.id)).toEqual(["openai-codex.cli"]);
    expect(getProviderStartupToolchainChecks("claude-code", {
      logger: createLogger(),
    }).map((check) => check.id)).toEqual([CLAUDE_CODE_STARTUP_CHECK_ID]);
  });

  it("skips execution when the startup checkpoint contract is current", async () => {
    const logger = createLogger();
    const firstSprite = createSprite([{ stdout: "codex is ready: 0.144.0\n", exitCode: 0 }]);
    const firstResult = await ensureSpriteStartupToolchain({
      providerId: "openai-codex",
      sprite: firstSprite,
      checkpoint: null,
      logger,
    });
    expect(firstResult.ok).toBe(true);
    if (!firstResult.ok) {
      return;
    }

    const secondSprite = createSprite([]);
    const secondResult = await ensureSpriteStartupToolchain({
      providerId: "openai-codex",
      sprite: secondSprite,
      checkpoint: firstResult.value,
      logger,
    });

    expect(secondResult.ok).toBe(true);
    expect(secondSprite.execWs).not.toHaveBeenCalled();
  });

  it("reruns checks when the Codex minimum version override changes", async () => {
    const logger = createLogger();
    const firstSprite = createSprite([{ stdout: "codex is ready: 0.144.0\n", exitCode: 0 }]);
    const firstResult = await ensureSpriteStartupToolchain({
      providerId: "openai-codex",
      sprite: firstSprite,
      checkpoint: null,
      logger,
    });
    expect(firstResult.ok).toBe(true);
    if (!firstResult.ok) {
      return;
    }

    const secondSprite = createSprite([{ stdout: "codex is ready: 0.140.0\n", exitCode: 0 }]);
    const secondResult = await ensureSpriteStartupToolchain({
      providerId: "openai-codex",
      sprite: secondSprite,
      checkpoint: firstResult.value,
      logger,
      codexMinVersion: "0.140.0",
    });

    expect(secondResult.ok).toBe(true);
    expect(secondSprite.execWs).toHaveBeenCalledOnce();
  });

  it("keeps provisioning and spawn call sites provider-agnostic", () => {
    const callSitePaths = [
      "../../src/modules/session-agent/services/session-provision.service.ts",
      "../../src/modules/session-agent/services/agent-process/sprite-agent-process-manager.service.ts",
    ];

    for (const callSitePath of callSitePaths) {
      const source = readFileSync(
        fileURLToPath(new URL(callSitePath, import.meta.url)),
        "utf8",
      );
      expect(source).not.toMatch(/openai-codex|claude-code|codex --version|install\.sh/);
    }
  });
});

describe("Claude Code startup check", () => {
  it("runs one Claude startup bash script", async () => {
    const sprite = createSprite([{
      stdout: "claude is current: 2.1.154\n",
      exitCode: 0,
    }]);
    const [check] = getClaudeStartupToolchainChecks({
      logger: createLogger(),
    });

    const result = await check!.ensureReady({ sprite });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toMatchObject({
      id: CLAUDE_CODE_STARTUP_CHECK_ID,
      status: "ready",
      requiredVersion: MIN_CLAUDE_CODE_CLI_VERSION,
    });
    expect(sprite.execWs).toHaveBeenCalledOnce();
    expect(sprite.execWs).toHaveBeenCalledWith(
      expect.stringContaining("bash -c"),
    );
    expect(sprite.execWs).toHaveBeenCalledWith(
      expect.stringContaining(`min_version="${MIN_CLAUDE_CODE_CLI_VERSION}"`),
    );
  });

  it("updates stale Claude Code and verifies the version", async () => {
    const sprite = createSprite([{
      stdout: "claude is ready: 2.1.154\n",
      exitCode: 0,
    }]);
    const [check] = getClaudeStartupToolchainChecks({
      logger: createLogger(),
    });

    const result = await check!.ensureReady({ sprite });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const command = vi.mocked(sprite.execWs).mock.calls[0]?.[0] as string;
    expect(command).toContain("read_claude_version()");
    expect(command).toContain("version_at_least()");
    expect(command).toContain("claude update");
    expect(command).toContain("claude is ready");
  });

  it("fails when the startup script fails", async () => {
    const sprite = createSprite([{
      stdout: "",
      stderr: "claude version 2.1.153 is below required 2.1.154 after update\n",
      exitCode: 1,
    }]);
    const [check] = getClaudeStartupToolchainChecks({
      logger: createLogger(),
    });

    const result = await check!.ensureReady({ sprite });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatchObject({
      code: "CHECK_FAILED",
      provider: "claude-code",
      checkId: CLAUDE_CODE_STARTUP_CHECK_ID,
      requiredVersion: MIN_CLAUDE_CODE_CLI_VERSION,
      exitCode: 1,
    });
  });
});

describe("OpenAI Codex startup check", () => {
  it("runs one Codex startup bash script", async () => {
    const sprite = createSprite([{
      stdout: "codex is current: 0.144.0\n",
      exitCode: 0,
    }]);
    const [check] = getOpenAICodexStartupToolchainChecks({
      logger: createLogger(),
    });

    const result = await check!.ensureReady({ sprite });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toMatchObject({
      id: "openai-codex.cli",
      status: "ready",
      requiredVersion: MIN_CODEX_CLI_VERSION,
    });
    expect(sprite.execWs).toHaveBeenCalledOnce();
    expect(sprite.execWs).toHaveBeenCalledWith(
      expect.stringContaining("bash -c"),
    );
    expect(sprite.execWs).toHaveBeenCalledWith(
      expect.stringContaining(`min_version="${MIN_CODEX_CLI_VERSION}"`),
    );
  });

  it("keeps checking, install, and verification in the same script", async () => {
    const sprite = createSprite([{
      stdout: "codex is ready: 0.144.0\n",
      exitCode: 0,
    }]);
    const [check] = getOpenAICodexStartupToolchainChecks({
      logger: createLogger(),
    });

    const result = await check!.ensureReady({ sprite });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(sprite.execWs).toHaveBeenCalledOnce();
    const command = vi.mocked(sprite.execWs).mock.calls[0]?.[0] as string;
    expect(command).toContain("read_codex_version()");
    expect(command).toContain("version_at_least()");
    expect(command).toContain(`curl -fsSL "$install_url" | sh`);
    expect(command).toContain("codex is ready");
  });

  it("uses CODEX_MIN_VERSION when provided", async () => {
    const sprite = createSprite([{
      stdout: "codex is ready: 0.140.0\n",
      exitCode: 0,
    }]);
    const [check] = getOpenAICodexStartupToolchainChecks({
      logger: createLogger(),
      codexMinVersion: "0.140.0",
    });

    const result = await check!.ensureReady({ sprite });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.requiredVersion).toBe("0.140.0");
    expect(check!.contract.minimumVersion).toBe("0.140.0");
    expect(sprite.execWs).toHaveBeenCalledWith(
      expect.stringContaining('min_version="0.140.0"'),
    );
  });

  it("fails when the startup script fails", async () => {
    const sprite = createSprite([{
      stdout: "codex is stale: 0.100.0 < 0.144.0\n",
      stderr: "codex version 0.100.0 is below required 0.144.0 after install\n",
      exitCode: 1,
    }]);
    const [check] = getOpenAICodexStartupToolchainChecks({
      logger: createLogger(),
    });

    const result = await check!.ensureReady({ sprite });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatchObject({
      code: "CHECK_FAILED",
      provider: "openai-codex",
      checkId: "openai-codex.cli",
      requiredVersion: MIN_CODEX_CLI_VERSION,
      exitCode: 1,
    });
  });
});

describe("startup toolchain network policy", () => {
  it("allows the Codex install script host", () => {
    const host = new URL(OPENAI_CODEX_INSTALL_SCRIPT_URL).hostname;
    expect(DEFAULT_NETWORK_POLICY).toContainEqual({
      domain: host,
      action: "allow",
    });
  });
});
