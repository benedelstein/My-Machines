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

const CODEX_CHECK_ID = "openai-codex.cli";
const DEFAULT_CODEX_CLI_VERSION = "0.144.0";
const CODEX_INSTALL_SCRIPT_URL = "https://chatgpt.com/codex/install.sh";
const CODEX_SCRIPT_VERSION = "4";

function getEffectiveCodexMinVersion(codexMinVersion: string | undefined): string {
  return codexMinVersion?.trim() || DEFAULT_CODEX_CLI_VERSION;
}

function buildCodexStartupScript(minCodexVersion: string): string {
  return `
set -euo pipefail

min_version="${minCodexVersion}"
install_url="${CODEX_INSTALL_SCRIPT_URL}"
export PATH="$HOME/.local/bin:$HOME/bin:/usr/local/bin:$PATH"

read_codex_version() {
  if ! command -v codex >/dev/null 2>&1; then
    return 1
  fi
  codex --version 2>&1 | grep -Eo '[0-9]+\\.[0-9]+\\.[0-9]+' | head -n 1
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

current_version="$(read_codex_version || true)"
if [[ -n "$current_version" ]] && version_at_least "$current_version" "$min_version"; then
  echo "codex is current: $current_version"
  exit 0
fi

if [[ -n "$current_version" ]]; then
  echo "codex is stale: $current_version < $min_version"
else
  echo "codex is missing"
fi

curl -fsSL "$install_url" | sh
export PATH="$HOME/.local/bin:$HOME/bin:/usr/local/bin:$PATH"

new_version="$(read_codex_version || true)"
if [[ -z "$new_version" ]]; then
  echo "codex install did not produce a readable codex --version" >&2
  exit 1
fi

if ! version_at_least "$new_version" "$min_version"; then
  echo "codex version $new_version is below required $min_version after install" >&2
  exit 1
fi

echo "codex is ready: $new_version"
`.trim();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

class CodexCliCheck implements StartupToolchainCheck {
  readonly id = CODEX_CHECK_ID;
  readonly contract: Record<string, unknown>;
  private readonly logger: Logger;
  private readonly minCodexVersion: string;
  private readonly startupScript: string;

  constructor(args: { logger: Logger; codexMinVersion?: string }) {
    this.minCodexVersion = getEffectiveCodexMinVersion(args.codexMinVersion);
    this.startupScript = buildCodexStartupScript(this.minCodexVersion);
    this.contract = {
      provider: "openai-codex",
      id: CODEX_CHECK_ID,
      minimumVersion: this.minCodexVersion,
      installScriptUrl: CODEX_INSTALL_SCRIPT_URL,
      scriptVersion: CODEX_SCRIPT_VERSION,
      script: this.startupScript,
    };
    this.logger = args.logger.scope("openai-codex-startup-toolchain");
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
          provider: "openai-codex",
          checkId: CODEX_CHECK_ID,
          requiredVersion: this.minCodexVersion,
          stdout: truncateCommandOutput(result.stdout) ?? null,
          stderr: truncateCommandOutput(result.stderr) ?? null,
          exitCode: result.exitCode,
        },
      });
      return failure(startupToolchainError(
        CODEX_CHECK_ID,
        "Codex CLI startup script failed.",
        {
          provider: "openai-codex",
          requiredVersion: this.minCodexVersion,
          ...execResultErrorFields(result),
        },
      ));
    }

    this.logger.info("Startup toolchain check completed", {
      fields: {
        provider: "openai-codex",
        checkId: CODEX_CHECK_ID,
        requiredVersion: this.minCodexVersion,
        status: "ready",
      },
    });

    return success({
      id: CODEX_CHECK_ID,
      status: "ready" as const,
      requiredVersion: this.minCodexVersion,
    });
  }
}

export function getOpenAICodexStartupToolchainChecks(
  args: { logger: Logger; codexMinVersion?: string },
): StartupToolchainCheck[] {
  return [new CodexCliCheck(args)];
}

export const OPENAI_CODEX_INSTALL_SCRIPT_URL = CODEX_INSTALL_SCRIPT_URL;
export const OPENAI_CODEX_STARTUP_CHECK_ID = CODEX_CHECK_ID;
