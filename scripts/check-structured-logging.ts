import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

interface Violation {
  filePath: string;
  line: number;
  column: number;
  message: string;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const sourceRoots = [
  "packages/shared/src",
  "packages/sprites-client/src",
  "packages/vm-agent/src",
  "services/api-server/src",
];

const ignoredDirectories = new Set([
  ".next",
  ".turbo",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules",
]);

const ignoredFiles = [
  /^packages\/vm-agent\/src\/test-.*\.ts$/,
];

const consoleAllowedFiles = new Set([
  "packages/shared/src/logging/index.ts",
  "packages/vm-agent/src/index-webhook.ts",
]);

const loggerImplementationFiles = new Set([
  "packages/shared/src/logging/index.ts",
  "services/api-server/src/lib/providers/observability-provider.ts",
]);

const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
const loggerMethodNames = new Set(["debug", "error", "info", "log", "warn"]);
const consoleMethodNames = new Set(["debug", "error", "info", "log", "warn"]);
const logParamNames = new Set(["error", "fields"]);

function toRepoPath(filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function toAbsolutePath(repoPath: string): string {
  return path.join(repoRoot, repoPath);
}

function collectSourceFiles(): string[] {
  const files: string[] = [];

  for (const sourceRoot of sourceRoots) {
    collectSourceFilesFromDirectory(toAbsolutePath(sourceRoot), files);
  }

  return files
    .filter((filePath) => !ignoredFiles.some((ignoredFile) => ignoredFile.test(toRepoPath(filePath))))
    .sort();
}

function collectSourceFilesFromDirectory(directory: string, files: string[]): void {
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

function checkFile(filePath: string): Violation[] {
  const sourceText = ts.sys.readFile(filePath);
  if (!sourceText) {
    return [];
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const violations: Violation[] = [];
  const repoPath = toRepoPath(filePath);

  function addViolation(node: ts.Node, message: string): void {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({
      filePath,
      line: position.line + 1,
      column: position.character + 1,
      message,
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression;

      if (isConsoleCall(callee) && !consoleAllowedFiles.has(repoPath)) {
        addViolation(callee, "console.* is only allowed in logger sinks; use Logger with structured fields.");
      }

      if (isLoggerCall(callee) && !loggerImplementationFiles.has(repoPath)) {
        checkLoggerCall(node, addViolation);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function isConsoleCall(callee: ts.PropertyAccessExpression): boolean {
  return (
    consoleMethodNames.has(callee.name.text)
    && ts.isIdentifier(callee.expression)
    && callee.expression.text === "console"
  );
}

function isLoggerCall(callee: ts.PropertyAccessExpression): boolean {
  return loggerMethodNames.has(callee.name.text) && isLoggerReceiver(callee.expression);
}

function isLoggerReceiver(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) {
    return expression.text.toLowerCase().endsWith("logger");
  }

  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text.toLowerCase().endsWith("logger") || isLoggerReceiver(expression.expression);
  }

  if (ts.isParenthesizedExpression(expression)) {
    return isLoggerReceiver(expression.expression);
  }

  return false;
}

function checkLoggerCall(node: ts.CallExpression, addViolation: (node: ts.Node, message: string) => void): void {
  const [message, params] = node.arguments;

  if (!message) {
    addViolation(node, "Logger calls must include a static message string.");
    return;
  }

  if (!ts.isStringLiteral(message)) {
    addViolation(message, "Logger messages must be static string literals. Put dynamic values in fields.");
  }

  if (!params) {
    return;
  }

  if (!ts.isObjectLiteralExpression(params)) {
    addViolation(params, "Logger params must be an inline object with fields and/or error.");
    return;
  }

  for (const property of params.properties) {
    const propertyName = getObjectPropertyName(property);
    if (!propertyName || !logParamNames.has(propertyName)) {
      addViolation(property, "Logger params may only contain fields and error.");
    }
  }
}

function getObjectPropertyName(property: ts.ObjectLiteralElementLike): string | null {
  if (ts.isSpreadAssignment(property)) {
    return null;
  }

  if (ts.isShorthandPropertyAssignment(property)) {
    return property.name.text;
  }

  const name = property.name;
  if (!name) {
    return null;
  }

  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  return null;
}

function checkStructuredLogging(): Violation[] {
  return collectSourceFiles().flatMap((filePath) => checkFile(filePath));
}

function printViolations(violations: Violation[]): void {
  console.error(`Structured logging check failed with ${violations.length} violation${violations.length === 1 ? "" : "s"}.\n`);

  for (const violation of violations) {
    console.error(`${toRepoPath(violation.filePath)}:${violation.line}:${violation.column}`);
    console.error(`  ${violation.message}\n`);
  }

  console.error("Use a static message and move identifiers, counts, durations, statuses, and provider data into { fields: { ... } }.");
}

const violations = checkStructuredLogging();

if (violations.length > 0) {
  printViolations(violations);
  process.exitCode = 1;
} else {
  console.log("Structured logging check passed.");
}
