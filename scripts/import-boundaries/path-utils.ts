import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const sourceRoots = [
  "apps/web",
  "packages/shared",
  "packages/sprites-client",
  "packages/vm-agent",
  "services/api-server",
  "services/connector-provisioner",
  "scripts",
];

const ignoredDirectories = new Set([
  ".next",
  ".turbo",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules",
]);

const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
const resolvableExtensions = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".d.ts",
  ".js",
  ".jsx",
  ".json",
];

export function toRepoPath(filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

export function toAbsolutePath(repoPath: string): string {
  return path.join(repoRoot, repoPath);
}

export function collectSourceFiles(): string[] {
  return collectSourceFilesFromRoots(sourceRoots);
}

export function collectSourceFilesFromRoots(roots: string[]): string[] {
  const files: string[] = [];

  for (const sourceRoot of roots) {
    collectSourceFilesFromDirectory(toAbsolutePath(sourceRoot), files);
  }

  return files.sort();
}

function collectSourceFilesFromDirectory(
  directory: string,
  files: string[],
): void {
  if (!existsSync(directory)) {
    return;
  }

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) {
      continue;
    }

    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectSourceFilesFromDirectory(entryPath, files);
      continue;
    }

    if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
      files.push(entryPath);
    }
  }
}

export function resolveAsFileOrDirectory(basePath: string): string | null {
  for (const extension of resolvableExtensions) {
    const filePath = `${basePath}${extension}`;
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      return filePath;
    }
  }

  if (existsSync(basePath) && statSync(basePath).isFile()) {
    return basePath;
  }

  if (existsSync(basePath) && statSync(basePath).isDirectory()) {
    for (const extension of resolvableExtensions) {
      const indexPath = path.join(basePath, `index${extension}`);
      if (existsSync(indexPath) && statSync(indexPath).isFile()) {
        return indexPath;
      }
    }
  }

  return null;
}
