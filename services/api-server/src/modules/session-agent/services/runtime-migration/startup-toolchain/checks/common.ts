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
const TYPESCRIPT_CHECK_ID = "common.typescript";
const TYPESCRIPT_VERSION = "5.9.3";
const TYPESCRIPT_SCRIPT_VERSION = "1";

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

function buildTypeScriptStartupScript(): string {
  return `
set -euo pipefail

required_version="${TYPESCRIPT_VERSION}"
export PATH="$HOME/.local/bin:$PATH"

read_typescript_version() {
  if ! command -v tsc >/dev/null 2>&1; then
    return 1
  fi
  tsc --version 2>/dev/null | sed -E 's/^Version[[:space:]]+//'
}

current_version="$(read_typescript_version || true)"
if [[ "$current_version" == "$required_version" ]]; then
  echo "typescript is current: $current_version"
  exit 0
fi

npm install --global --prefix "$HOME/.local" "typescript@$required_version"
export PATH="$HOME/.local/bin:$PATH"

new_version="$(read_typescript_version || true)"
if [[ "$new_version" != "$required_version" ]]; then
  echo "typescript version $new_version does not equal required $required_version after install" >&2
  exit 1
fi

echo "typescript is ready: $new_version"
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

class TypeScriptCheck implements StartupToolchainCheck {
  readonly id = TYPESCRIPT_CHECK_ID;
  readonly contract: StartupToolchainCheck["contract"];
  private readonly startupScript: string;

  constructor() {
    this.startupScript = buildTypeScriptStartupScript();
    this.contract = {
      id: TYPESCRIPT_CHECK_ID,
      packageName: "typescript",
      requiredVersion: TYPESCRIPT_VERSION,
      scriptVersion: TYPESCRIPT_SCRIPT_VERSION,
      script: this.startupScript,
    };
  }

  async ensureReady(input: StartupToolchainCheckInput) {
    const result = await input.sprite.execWs(
      `bash -c ${shellQuote(this.startupScript)}`,
    );
    if (result.exitCode !== 0) {
      return failure(startupToolchainError(
        TYPESCRIPT_CHECK_ID,
        "TypeScript installation or verification failed",
        {
          requiredVersion: TYPESCRIPT_VERSION,
          ...execResultErrorFields(result),
        },
      ));
    }

    return success({
      id: TYPESCRIPT_CHECK_ID,
      status: "ready" as const,
      requiredVersion: TYPESCRIPT_VERSION,
    });
  }
}

export function getCommonStartupToolchainChecks(): StartupToolchainCheck[] {
  return [new PrettierCheck(), new TypeScriptCheck()];
}

export const PRETTIER_STARTUP_CHECK_ID = PRETTIER_CHECK_ID;
export const PRETTIER_STARTUP_PACKAGE_VERSION = PRETTIER_VERSION;
export const TYPESCRIPT_STARTUP_CHECK_ID = TYPESCRIPT_CHECK_ID;
export const TYPESCRIPT_STARTUP_PACKAGE_VERSION = TYPESCRIPT_VERSION;
