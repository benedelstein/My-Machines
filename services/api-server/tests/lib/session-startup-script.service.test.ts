import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "@repo/shared";
import type { WorkersSpriteClient } from "@repo/sprites-client";
import { SessionStartupScriptService } from "../../src/modules/session-agent/services/session-startup-script.service";

function createLogger() {
  const info = vi.fn();
  const warn = vi.fn();
  const logger: Logger = {
    log() {},
    debug() {},
    info,
    warn,
    error() {},
    scope() {
      return logger;
    },
  };

  return { info, logger, warn };
}

describe("SessionStartupScriptService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs when no startup script is configured", async () => {
    const { info, logger } = createLogger();
    const sprite = {
      execWs: vi.fn(),
    } as unknown as WorkersSpriteClient;

    const service = new SessionStartupScriptService(logger);

    const result = await service.run({
      sprite,
      script: "   ",
      workspaceDir: "/workspace",
      env: { FOO: "bar" },
    });

    expect(result).toEqual({ status: "skipped" });
    expect(sprite.execWs).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("No session startup script configured", {
      fields: {
        workspaceDir: "/workspace",
        envVarCount: 1,
      },
    });
  });

  it("logs duration when the startup script fails", async () => {
    const { logger, warn } = createLogger();
    const sprite = {
      execWs: vi.fn(async () => ({
        stdout: "install output",
        stderr: "",
        exitCode: -1,
      })),
    } as unknown as WorkersSpriteClient;
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(7_500);

    const service = new SessionStartupScriptService(logger);

    await expect(service.run({
      sprite,
      script: "pnpm install",
      workspaceDir: "/workspace",
      env: {},
    })).resolves.toEqual({
      status: "failed",
      errorMessage: "Startup script failed with exit code -1 after 6500ms",
      exitCode: -1,
      durationMs: 6_500,
    });

    expect(warn).toHaveBeenCalledWith("Session startup script failed", {
      fields: {
        exitCode: -1,
        durationMs: 6_500,
        stdoutTail: "install output",
        stderrTail: "",
      },
    });
  });

  it("forwards raw output chunks to onOutput", async () => {
    const { logger } = createLogger();
    const sprite = {
      execWs: vi.fn(async (
        _command: string,
        options: {
          onStdout?: (data: string) => void;
          onStderr?: (data: string) => void;
        },
      ) => {
        options.onStdout?.("line 1\n");
        options.onStderr?.("warn 1\n");
        options.onStdout?.("line 2\n");
        return { stdout: "line 1\nline 2", stderr: "warn 1", exitCode: 0 };
      }),
    } as unknown as WorkersSpriteClient;

    const service = new SessionStartupScriptService(logger);
    const onOutput = vi.fn();

    const result = await service.run({
      sprite,
      script: "pnpm install",
      workspaceDir: "/workspace",
      env: {},
      onOutput,
    });

    expect(result.status).toBe("completed");
    expect(onOutput.mock.calls).toEqual([
      ["stdout", "line 1\n"],
      ["stderr", "warn 1\n"],
      ["stdout", "line 2\n"],
    ]);
  });
});
