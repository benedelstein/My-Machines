/**
 * End-to-end Claude OAuth control-plane proxy spike.
 *
 * This starts a local Worker against an existing local D1 state, exposes it through
 * the configured Cloudflare tunnel, creates or reuses a Sprite, writes a short-lived
 * Cloude gateway token for ANTHROPIC_AUTH_TOKEN, and runs one
 * non-interactive Claude inference request through the tunnel.
 *
 * Required:
 *   CLAUDE_PROXY_SPIKE_ENV_FILE=/path/to/services/api-server/.env.local
 *
 * Optional:
 *   CLAUDE_PROXY_SPIKE_PERSIST_DIR=/path/to/services/api-server/.wrangler/state
 *
 * Usage:
 *   pnpm --filter @repo/api-server test:live:claude-oauth-control-plane-proxy
 *   pnpm --filter @repo/api-server test:live:claude-oauth-control-plane-proxy -- --sprite=<name>
 *   pnpm --filter @repo/api-server test:live:claude-oauth-control-plane-proxy -- \
 *     --prepare-only --keep-services --keep-sprite
 */
import dotenv from "dotenv";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SignJWT } from "jose";
import { SpritesCoordinator } from "../src/shared/integrations/sprites/sprites";
import { WorkersSpriteClient } from "../src/shared/integrations/sprites/WorkersSpriteClient";

interface ScriptArgs {
  spriteName?: string;
  keepSprite: boolean;
  prepareOnly: boolean;
  keepServices: boolean;
}

interface ManagedProcess {
  name: string;
  child: ChildProcessWithoutNullStreams;
  output: string[];
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(SCRIPT_DIR, "..");
const CONFIG_PATH = join(SCRIPT_DIR, "wrangler.claude-oauth-control-plane-proxy.jsonc");
const LOCAL_PORT = 8787;
const LOCAL_HEALTH_URL = `http://127.0.0.1:${LOCAL_PORT}/health`;
const GATEWAY_TOKEN_PATH = "/home/sprite/.cloude/gateway-token";
const args = parseArgs(process.argv.slice(2));

const envFile = resolveRequiredPath(
  process.env.CLAUDE_PROXY_SPIKE_ENV_FILE,
  "CLAUDE_PROXY_SPIKE_ENV_FILE",
);
const loadedEnv = dotenv.parse(readFileSync(envFile));
const persistDir = resolve(
  process.env.CLAUDE_PROXY_SPIKE_PERSIST_DIR
    ?? join(dirname(envFile), ".wrangler/state"),
);
const spritesApiKey = requiredValue(loadedEnv.SPRITES_API_KEY, "SPRITES_API_KEY");
const spritesApiUrl = loadedEnv.SPRITES_API_URL ?? "https://api.sprites.dev";
const gatewayBase = requiredValue(loadedEnv.WORKER_URL, "WORKER_URL").replace(/\/+$/, "");
const signingKey = requiredValue(
  loadedEnv.NATIVE_ACCESS_TOKEN_SIGNING_KEY,
  "NATIVE_ACCESS_TOKEN_SIGNING_KEY",
);

const managedProcesses: ManagedProcess[] = [];
let createdSpriteName: string | null = null;

try {
  await main();
} catch (error) {
  printProcessDiagnostics();
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
} finally {
  await cleanup();
}

async function main(): Promise<void> {
  const databasePath = findLocalD1Database(persistDir);
  const userId = findSingleClaudeUser(databasePath);
  const gatewayTokenLifetimeSeconds = args.keepServices ? 60 * 60 : 15 * 60;
  const gatewayToken = await signGatewayToken({
    userId,
    signingKey,
    issuer: gatewayBase,
    lifetimeSeconds: gatewayTokenLifetimeSeconds,
  });

  console.log(`Gateway: ${new URL(gatewayBase).hostname}`);
  console.log("Credential source: local D1 Claude OAuth record");
  console.log("Sprite credential: short-lived Cloude gateway JWT; provider tokens remain server-side");

  startWorker();
  await waitForHttp(LOCAL_HEALTH_URL, 30_000);

  startTunnel();
  await waitForHttp(`${gatewayBase}/health`, 45_000);

  await runInvalidGatewayTokenProbe(gatewayBase);

  const coordinator = new SpritesCoordinator({ apiKey: spritesApiKey });
  const sprite = await getSprite(coordinator, spritesApiKey, spritesApiUrl);
  console.log(`Sprite: ${sprite.name}`);

  await installGatewayCredential(sprite, gatewayToken);

  if (args.prepareOnly) {
    await prepareInteractiveShell(sprite, gatewayBase);
    if (args.keepServices) {
      console.log("Worker and tunnel are running. Press Ctrl-C in this harness to stop them.");
      await waitForShutdownSignal();
    }
    return;
  }

  await runClaudeProbe(sprite, gatewayBase);
}

function startWorker(): void {
  const child = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--config",
      CONFIG_PATH,
      "--env-file",
      envFile,
      "--persist-to",
      persistDir,
      "--port",
      String(LOCAL_PORT),
      "--log-level",
      "warn",
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: PACKAGE_DIR,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  managedProcesses.push(trackProcess("wrangler", child));
}

function startTunnel(): void {
  const child = spawn(
    "cloudflared",
    [
      "tunnel",
      "run",
      "--url",
      `http://127.0.0.1:${LOCAL_PORT}`,
      "cloude-code-tunnel",
    ],
    {
      cwd: PACKAGE_DIR,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  managedProcesses.push(trackProcess("cloudflared", child));
}

function trackProcess(
  name: string,
  child: ChildProcessWithoutNullStreams,
): ManagedProcess {
  const output: string[] = [];
  const append = (chunk: Buffer): void => {
    output.push(chunk.toString("utf8"));
    if (output.length > 80) {
      output.shift();
    }
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return { name, child, output };
}

async function getSprite(
  coordinator: SpritesCoordinator,
  apiKey: string,
  apiUrl: string,
): Promise<WorkersSpriteClient> {
  if (args.spriteName) {
    await coordinator.getSprite(args.spriteName);
    return new WorkersSpriteClient(args.spriteName, apiKey, apiUrl);
  }

  const name = `claude-proxy-spike-${Date.now()}`;
  const created = await coordinator.createSprite({
    name,
    config: {
      ramMB: 1024,
      cpus: 1,
      storageGB: 3,
    },
  });
  createdSpriteName = created.name;
  return new WorkersSpriteClient(created.name, apiKey, apiUrl);
}

async function installGatewayCredential(
  sprite: WorkersSpriteClient,
  gatewayToken: string,
): Promise<void> {
  await sprite.writeFile(GATEWAY_TOKEN_PATH, gatewayToken, {
    mode: "600",
  });

  const result = await sprite.execHttp(
    [
      "set -eu",
      "test -x \"$(command -v claude)\"",
      `test "$(stat -c '%a' ${shellQuote(GATEWAY_TOKEN_PATH)})" = "600"`,
      "echo gateway_token_file=ready",
      "claude --version",
    ].join("\n"),
  );
  assertSuccess("install gateway credential", result);
  console.log(result.stdout);
}

async function prepareInteractiveShell(
  sprite: WorkersSpriteClient,
  baseUrl: string,
): Promise<void> {
  const environmentPath = "/home/sprite/claude-proxy-env.sh";
  await sprite.writeFile(
    environmentPath,
    [
      `export ANTHROPIC_BASE_URL=${shellQuote(baseUrl)}`,
      `export ANTHROPIC_AUTH_TOKEN="$(cat ${shellQuote(GATEWAY_TOKEN_PATH)})"`,
      "export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
      "export DISABLE_AUTOUPDATER=1",
      "",
    ].join("\n"),
    { mode: "600" },
  );

  console.log("");
  console.log("Attach from your laptop:");
  console.log(`  SPRITE_TOKEN="$SPRITES_API_KEY" sprite console --sprite ${sprite.name}`);
  console.log("");
  console.log("Then run inside the Sprite:");
  console.log(`  source ${environmentPath}`);
  console.log("  claude");
  console.log("");
  console.log("The temporary control-plane gateway credential expires in one hour.");
}

async function runClaudeProbe(
  sprite: WorkersSpriteClient,
  baseUrl: string,
): Promise<void> {
  console.log("Running Claude inference through the control-plane proxy...");
  const result = await sprite.execHttp(
    [
      "set -eu",
      "export HOME=/home/sprite",
      `export ANTHROPIC_BASE_URL=${shellQuote(baseUrl)}`,
      `export ANTHROPIC_AUTH_TOKEN="$(cat ${shellQuote(GATEWAY_TOKEN_PATH)})"`,
      "export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
      "export DISABLE_AUTOUPDATER=1",
      "timeout 150 claude -p 'Reply with only proxy-ok' --output-format json",
    ].join("\n"),
  );
  assertSuccess("Claude inference", result);

  if (!result.stdout.toLowerCase().includes("proxy-ok")) {
    throw new Error(`Claude inference completed without proxy-ok: ${result.stdout}`);
  }

  console.log(result.stdout);
  console.log("PASS: Claude completed inference while its real OAuth access and refresh tokens stayed in D1/control plane.");
}

async function runInvalidGatewayTokenProbe(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: "Bearer invalid-spike-token",
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });
  if (response.status !== 401) {
    throw new Error(`Invalid gateway token probe returned ${response.status}, expected 401`);
  }
  console.log("Negative control: invalid control-plane token rejected");
}

async function signGatewayToken(params: {
  userId: string;
  signingKey: string;
  issuer: string;
  lifetimeSeconds: number;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({ sid: `claude-proxy-spike-${randomUUID()}` })
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
    .setIssuer(params.issuer)
    .setAudience("cloudecode-api")
    .setSubject(params.userId)
    .setIssuedAt(now)
    .setExpirationTime(now + params.lifetimeSeconds)
    .setJti(randomUUID())
    .sign(new TextEncoder().encode(params.signingKey));
}

function findLocalD1Database(stateDir: string): string {
  const databaseDir = join(stateDir, "v3/d1/miniflare-D1DatabaseObject");
  if (!existsSync(databaseDir)) {
    throw new Error(`Local D1 directory not found: ${databaseDir}`);
  }

  for (const entry of readdirSync(databaseDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".sqlite") || entry.name === "metadata.sqlite") {
      continue;
    }
    const candidate = join(databaseDir, entry.name);
    try {
      const tables = querySqlite(candidate, "SELECT name FROM sqlite_master WHERE type='table'");
      if (tables.split("\n").includes("user_provider_credentials")) {
        return candidate;
      }
    } catch {
      // Ignore non-D1 SQLite files in the persistence directory.
    }
  }

  throw new Error(`No local D1 database with user_provider_credentials found under ${databaseDir}`);
}

function findSingleClaudeUser(databasePath: string): string {
  const rows = querySqlite(
    databasePath,
    [
      "SELECT user_id",
      "FROM user_provider_credentials",
      "WHERE provider_id = 'claude-code'",
      "AND auth_method = 'oauth'",
      "AND requires_reauth = 0",
      "ORDER BY updated_at DESC;",
    ].join(" "),
  ).split("\n").filter(Boolean);

  if (rows.length !== 1) {
    throw new Error(`Expected exactly one connected local Claude user, found ${rows.length}`);
  }
  return rows[0]!;
}

function querySqlite(databasePath: string, query: string): string {
  const uri = `file:${databasePath}?mode=ro&immutable=1`;
  return execFileSync("sqlite3", [uri, query], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not started";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`Timed out waiting for ${new URL(url).hostname}: ${lastError}`);
}

async function waitForShutdownSignal(): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    process.once("SIGINT", resolvePromise);
    process.once("SIGTERM", resolvePromise);
  });
}

function assertSuccess(
  label: string,
  result: { exitCode: number; stdout: string; stderr: string },
): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed with exit ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

function printProcessDiagnostics(): void {
  for (const process of managedProcesses) {
    if (process.output.length === 0) {
      continue;
    }
    console.error(`--- ${process.name} output ---`);
    console.error(process.output.join("").trim());
  }
}

async function cleanup(): Promise<void> {
  if (createdSpriteName && !args.keepSprite) {
    try {
      const coordinator = new SpritesCoordinator({ apiKey: spritesApiKey });
      await coordinator.deleteSprite(createdSpriteName);
      console.log(`Deleted Sprite: ${createdSpriteName}`);
    } catch (error) {
      console.error(`Failed to delete Sprite ${createdSpriteName}: ${String(error)}`);
    }
  } else if (createdSpriteName) {
    console.log(`Kept Sprite: ${createdSpriteName}`);
  }

  for (const process of managedProcesses.reverse()) {
    if (!process.child.killed) {
      process.child.kill("SIGTERM");
    }
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
}

function parseArgs(rawArgs: string[]): ScriptArgs {
  const spriteArg = rawArgs.find((arg) => arg.startsWith("--sprite="));
  return {
    spriteName: spriteArg?.slice("--sprite=".length) || undefined,
    keepSprite: rawArgs.includes("--keep-sprite"),
    prepareOnly: rawArgs.includes("--prepare-only"),
    keepServices: rawArgs.includes("--keep-services"),
  };
}

function resolveRequiredPath(value: string | undefined, name: string): string {
  const path = requiredValue(value, name);
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new Error(`${name} does not exist: ${resolved}`);
  }
  return resolved;
}

function requiredValue(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
