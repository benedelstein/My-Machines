import path from "node:path";
import {
  resolveAsFileOrDirectory,
  toAbsolutePath,
  toRepoPath,
} from "./path-utils";

const assetExtensions = new Set([
  ".css",
  ".scss",
  ".sass",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
]);

const workspacePackages = new Map([
  [
    "@repo/api-contract",
    { root: "packages/api-contract", entrypoint: "packages/api-contract/src/index.ts" },
  ],
  [
    "@repo/shared",
    { root: "packages/shared", entrypoint: "packages/shared/src/index.ts" },
  ],
  [
    "@repo/sprites-client",
    { root: "packages/sprites-client", entrypoint: "packages/sprites-client/src/index.ts" },
  ],
  [
    "@repo/vm-agent",
    { root: "packages/vm-agent", entrypoint: "packages/vm-agent/src/index-ndjson.ts" },
  ],
  [
    "@repo/api-server",
    { root: "services/api-server", entrypoint: "services/api-server/src/index.ts" },
  ],
  [
    "@repo/web",
    { root: "apps/web", entrypoint: "apps/web/package.json" },
  ],
  [
    "@repo/discord-bot",
    { root: "apps/discord-bot", entrypoint: "apps/discord-bot/src/index.ts" },
  ],
]);

export function resolveImportTarget(
  sourceFile: string,
  specifier: string,
): string | null {
  if (assetExtensions.has(path.extname(specifier))) {
    return null;
  }

  if (specifier.startsWith(".")) {
    return resolveAsFileOrDirectory(
      path.resolve(path.dirname(sourceFile), specifier),
    );
  }

  if (specifier.startsWith("@/")) {
    return resolveAliasImport(sourceFile, specifier);
  }

  return resolveWorkspacePackageImport(specifier);
}

function resolveAliasImport(
  sourceFile: string,
  specifier: string,
): string | null {
  const sourceRepoPath = toRepoPath(sourceFile);
  const aliasPath = specifier.slice(2);

  if (sourceRepoPath.startsWith("apps/web/")) {
    return resolveAsFileOrDirectory(toAbsolutePath(`apps/web/${aliasPath}`));
  }

  if (sourceRepoPath.startsWith("services/api-server/")) {
    return resolveAsFileOrDirectory(
      toAbsolutePath(`services/api-server/src/${aliasPath}`),
    );
  }

  return null;
}

function resolveWorkspacePackageImport(specifier: string): string | null {
  for (const [packageName, packageInfo] of workspacePackages) {
    if (specifier === packageName) {
      return toAbsolutePath(packageInfo.entrypoint);
    }

    if (specifier.startsWith(`${packageName}/`)) {
      const subpath = specifier.slice(packageName.length + 1);
      return resolveAsFileOrDirectory(
        toAbsolutePath(`${packageInfo.root}/${subpath}`),
      );
    }
  }

  if (specifier.startsWith("@repo/")) {
    throw new Error(
      `Unknown @repo workspace import "${specifier}". Add it to workspacePackages in scripts/import-boundaries/import-resolver.ts.`,
    );
  }

  return null;
}
