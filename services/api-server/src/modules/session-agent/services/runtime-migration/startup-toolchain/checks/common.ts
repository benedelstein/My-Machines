import type {
  StartupToolchainCheck,
  StartupToolchainCheckInput,
} from "../types";
import {
  execResultErrorFields,
  failure,
  startupToolchainError,
  success,
} from "../common";

const PRETTIER_CHECK_ID = "common.prettier";
const PRETTIER_VERSION = "3.8.1";
const PRETTIER_SCRIPT_VERSION = "1";

function buildPrettierStartupScript(): string {
  return `
set -euo pipefail

required_version="${PRETTIER_VERSION}"
export PATH="$HOME/.local/bin:$PATH"

read_prettier_version() {
  if ! command -v prettier >/dev/null 2>&1; then
    return 1
  fi
  prettier --version 2>/dev/null
}

current_version="$(read_prettier_version || true)"
if [[ "$current_version" == "$required_version" ]]; then
  echo "prettier is current: $current_version"
  exit 0
fi

npm install --global --prefix "$HOME/.local" "prettier@$required_version"
export PATH="$HOME/.local/bin:$PATH"

new_version="$(read_prettier_version || true)"
if [[ "$new_version" != "$required_version" ]]; then
  echo "prettier version $new_version does not equal required $required_version after install" >&2
  exit 1
fi

echo "prettier is ready: $new_version"
`.trim();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

class PrettierCheck implements StartupToolchainCheck {
  readonly id = PRETTIER_CHECK_ID;
  readonly contract: StartupToolchainCheck["contract"];
  private readonly startupScript: string;

  constructor() {
    this.startupScript = buildPrettierStartupScript();
    this.contract = {
      id: PRETTIER_CHECK_ID,
      packageName: "prettier",
      requiredVersion: PRETTIER_VERSION,
      scriptVersion: PRETTIER_SCRIPT_VERSION,
      script: this.startupScript,
    };
  }

  async ensureReady(input: StartupToolchainCheckInput) {
    const result = await input.sprite.execWs(
      `bash -c ${shellQuote(this.startupScript)}`,
    );
    if (result.exitCode !== 0) {
      return failure(startupToolchainError(
        PRETTIER_CHECK_ID,
        "Prettier installation or verification failed",
        {
          requiredVersion: PRETTIER_VERSION,
          ...execResultErrorFields(result),
        },
      ));
    }

    return success({
      id: PRETTIER_CHECK_ID,
      status: "ready" as const,
      requiredVersion: PRETTIER_VERSION,
    });
  }
}

export function getCommonStartupToolchainChecks(): StartupToolchainCheck[] {
  return [new PrettierCheck()];
}

export const PRETTIER_STARTUP_CHECK_ID = PRETTIER_CHECK_ID;
export const PRETTIER_STARTUP_PACKAGE_VERSION = PRETTIER_VERSION;
