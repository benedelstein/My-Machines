import type { Logger } from "@repo/shared";
import type {
  StartupToolchainCheck,
  StartupToolchainCheckInput,
} from "../types";
import {
  execResultErrorFields,
  failure,
  startupToolchainError,
  success,
  truncateCommandOutput,
} from "../common";

const CLAUDE_CHECK_ID = "claude-code.cli";
const MIN_CLAUDE_CODE_VERSION = "2.1.154";
const CLAUDE_SCRIPT_VERSION = "2";

function buildClaudeStartupScript(): string {
  return `
set -euo pipefail

min_version="${MIN_CLAUDE_CODE_VERSION}"
export PATH="$HOME/.local/bin:$HOME/bin:/usr/local/bin:$PATH"

read_claude_version() {
  if ! command -v claude >/dev/null 2>&1; then
    return 1
  fi
  claude --version 2>&1 | grep -Eo '[0-9]+\\.[0-9]+\\.[0-9]+' | head -n 1
}

version_at_least() {
  local version="$1"
  local minimum="$2"
  local v_major v_minor v_patch m_major m_minor m_patch
  IFS=. read -r v_major v_minor v_patch <<< "$version"
  IFS=. read -r m_major m_minor m_patch <<< "$minimum"

  if (( v_major != m_major )); then
    (( v_major > m_major ))
    return
  fi
  if (( v_minor != m_minor )); then
    (( v_minor > m_minor ))
    return
  fi
  (( v_patch >= m_patch ))
}

current_version="$(read_claude_version || true)"
if [[ -z "$current_version" ]]; then
  echo "claude is missing" >&2
  exit 1
fi

if version_at_least "$current_version" "$min_version"; then
  echo "claude is current: $current_version"
  exit 0
fi

echo "claude is stale: $current_version < $min_version"
claude update
export PATH="$HOME/.local/bin:$HOME/bin:/usr/local/bin:$PATH"

new_version="$(read_claude_version || true)"
if [[ -z "$new_version" ]]; then
  echo "claude update did not produce a readable claude --version" >&2
  exit 1
fi

if ! version_at_least "$new_version" "$min_version"; then
  echo "claude version $new_version is below required $min_version after update" >&2
  exit 1
fi

echo "claude is ready: $new_version"
`.trim();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

class ClaudeCliCheck implements StartupToolchainCheck {
  readonly id = CLAUDE_CHECK_ID;
  readonly contract: Record<string, unknown>;
  private readonly logger: Logger;
  private readonly startupScript: string;

  constructor(logger: Logger) {
    this.startupScript = buildClaudeStartupScript();
    this.contract = {
      provider: "claude-code",
      id: CLAUDE_CHECK_ID,
      minimumVersion: MIN_CLAUDE_CODE_VERSION,
      scriptVersion: CLAUDE_SCRIPT_VERSION,
      script: this.startupScript,
    };
    this.logger = logger.scope("claude-code-startup-toolchain");
  }

  async ensureReady(
    input: StartupToolchainCheckInput,
  ) {
    // Use a non-login shell: Sprite login-shell logout cleanup can turn a
    // successful early exit into exit code 1.
    const result = await input.sprite.execWs(
      `bash -c ${shellQuote(this.startupScript)}`,
    );
    if (result.exitCode !== 0) {
      this.logger.warn("Startup toolchain check failed", {
        fields: {
          provider: "claude-code",
          checkId: CLAUDE_CHECK_ID,
          requiredVersion: MIN_CLAUDE_CODE_VERSION,
          stdout: truncateCommandOutput(result.stdout) ?? null,
          stderr: truncateCommandOutput(result.stderr) ?? null,
          exitCode: result.exitCode,
        },
      });
      return failure(startupToolchainError(
        CLAUDE_CHECK_ID,
        "Claude Code startup script failed.",
        {
          provider: "claude-code",
          requiredVersion: MIN_CLAUDE_CODE_VERSION,
          ...execResultErrorFields(result),
        },
      ));
    }

    this.logger.info("Startup toolchain check completed", {
      fields: {
        provider: "claude-code",
        checkId: CLAUDE_CHECK_ID,
        requiredVersion: MIN_CLAUDE_CODE_VERSION,
        status: "ready",
      },
    });

    return success({
      id: CLAUDE_CHECK_ID,
      status: "ready" as const,
      requiredVersion: MIN_CLAUDE_CODE_VERSION,
    });
  }
}

export function getClaudeStartupToolchainChecks(args: { logger: Logger }): StartupToolchainCheck[] {
  return [new ClaudeCliCheck(args.logger)];
}

export const CLAUDE_CODE_STARTUP_CHECK_ID = CLAUDE_CHECK_ID;
export const MIN_CLAUDE_CODE_CLI_VERSION = MIN_CLAUDE_CODE_VERSION;
