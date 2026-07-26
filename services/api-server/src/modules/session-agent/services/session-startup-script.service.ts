import type { Logger, PlainEnvVars } from "@repo/shared";
import type { WorkersSpriteClient } from "@repo/sprites-client";

const STARTUP_SCRIPT_TIMEOUT_SECONDS = 300;
const STARTUP_SCRIPT_LOG_LIMIT = 2000;

export type SessionStartupScriptRunResult =
  | { status: "skipped" }
  | {
      status: "completed";
      exitCode: number | null;
      durationMs: number;
    }
  | {
      status: "failed";
      errorMessage: string;
      exitCode: number | null;
      durationMs: number;
    };

export class SessionStartupScriptService {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.scope("session-startup-script");
  }

  async run(args: {
    sprite: WorkersSpriteClient;
    script: string | null;
    workspaceDir: string;
    env: PlainEnvVars;
    /** Receives raw output chunks as the script runs. */
    onOutput?: (stream: "stdout" | "stderr", data: string) => void;
  }): Promise<SessionStartupScriptRunResult> {
    const script = args.script?.trim();
    if (!script) {
      this.logger.info("No session startup script configured", {
        fields: {
          workspaceDir: args.workspaceDir,
          envVarCount: Object.keys(args.env).length,
        },
      });
      return { status: "skipped" };
    }

    this.logger.info("Running session startup script", {
      fields: {
        workspaceDir: args.workspaceDir,
        scriptLength: script.length,
        envVarCount: Object.keys(args.env).length,
        timeoutSeconds: STARTUP_SCRIPT_TIMEOUT_SECONDS,
      },
    });
    const d0 = Date.now();
    const result = await args.sprite.execWs(
      `timeout ${STARTUP_SCRIPT_TIMEOUT_SECONDS}s bash -lc ${shellQuote(script)}`,
      {
        cwd: args.workspaceDir,
        env: args.env,
        onStdout: (data) => args.onOutput?.("stdout", data),
        onStderr: (data) => args.onOutput?.("stderr", data),
      },
    );
    const durationMs = Date.now() - d0;

    if (result.exitCode !== 0) {
      this.logger.warn("Session startup script failed", {
        fields: {
          exitCode: result.exitCode,
          durationMs,
          stdoutTail: result.stdout.slice(-STARTUP_SCRIPT_LOG_LIMIT),
          stderrTail: result.stderr.slice(-STARTUP_SCRIPT_LOG_LIMIT),
        },
      });
      const error = new SessionStartupScriptError(result.exitCode, durationMs);
      return {
        status: "failed",
        errorMessage: error.message,
        exitCode: result.exitCode,
        durationMs,
      };
    }

    this.logger.info("Session startup script completed", {
      fields: {
        durationMs,
        stdoutBytes: result.stdout.length,
        stderrBytes: result.stderr.length,
      },
    });
    return { status: "completed", exitCode: result.exitCode, durationMs };
  }
}

class SessionStartupScriptError extends Error {
  constructor(exitCode: number, durationMs: number) {
    super(`Startup script failed with exit code ${exitCode} after ${durationMs}ms`);
    this.name = "SessionStartupScriptError";
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
