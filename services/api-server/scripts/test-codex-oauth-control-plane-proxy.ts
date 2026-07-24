/**
 * End-to-end OpenAI Codex OAuth control-plane proxy spike.
 *
 * Starts either the diagnostic Worker proxy or an OAuth-capable native Responses
 * proxy against existing local D1 state, exposes it through the configured
 * Cloudflare tunnel, creates or reuses a Sprite, configures a custom Responses
 * provider with a short-lived Cloude gateway token, and runs Codex inference while
 * the real ChatGPT OAuth tokens remain in the control plane.
 *
 * Required:
 *   CODEX_PROXY_SPIKE_ENV_FILE=/path/to/services/api-server/.env.local
 *
 * Optional:
 *   CODEX_PROXY_SPIKE_PERSIST_DIR=/path/to/services/api-server/.wrangler/state
 *   CODEX_PROXY_SPIKE_NATIVE_PROXY_BIN=/path/to/codex-responses-api-proxy
 *     Build from official Codex source after applying
 *     scripts/codex-responses-api-proxy-oauth.patch.
 *   CODEX_PROXY_SPIKE_DIAGNOSTIC_ONLY=1
 *     Run only the local Worker credential/egress probe without a tunnel or Sprite.
 *
 * Usage:
 *   pnpm --filter @repo/api-server test:live:codex-oauth-control-plane-proxy
 *   pnpm --filter @repo/api-server test:live:codex-oauth-control-plane-proxy -- --sprite=<name>
 *   pnpm --filter @repo/api-server test:live:codex-oauth-control-plane-proxy -- \
 *     --prepare-only --keep-services --keep-sprite
 */
import dotenv from "dotenv";
import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SignJWT } from "jose";
import { SpritesCoordinator } from "../src/shared/integrations/sprites/sprites";
import { WorkersSpriteClient } from "../src/shared/integrations/sprites/WorkersSpriteClient";
import { readStoredCredentialJson } from "../src/shared/utils/crypto";

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
const CONFIG_PATH = join(
  SCRIPT_DIR,
  "wrangler.codex-oauth-control-plane-proxy.jsonc",
);
const LOCAL_PORT = 8787;
const NATIVE_PROXY_PORT = 8788;
const LOCAL_HEALTH_URL = `http://127.0.0.1:${LOCAL_PORT}/health`;
const GATEWAY_TOKEN_PATH = "/home/sprite/.cloude/codex-gateway-token";
const CODEX_CONFIG_PATH = "/home/sprite/.codex/config.toml";
const CODEX_ENV_PATH = "/home/sprite/codex-proxy-env.sh";
const CODEX_MODEL = "gpt-5.4";
const DIRECT_CODEX_MODEL = CODEX_MODEL;
const args = parseArgs(process.argv.slice(2));

const envFile = resolveRequiredPath(
  process.env.CODEX_PROXY_SPIKE_ENV_FILE,
  "CODEX_PROXY_SPIKE_ENV_FILE",
);
const loadedEnv = dotenv.parse(readFileSync(envFile));
const persistDir = resolve(
  process.env.CODEX_PROXY_SPIKE_PERSIST_DIR ??
    join(dirname(envFile), ".wrangler/state"),
);
const spritesApiKey = requiredValue(
  loadedEnv.SPRITES_API_KEY,
  "SPRITES_API_KEY",
);
const spritesApiUrl = loadedEnv.SPRITES_API_URL ?? "https://api.sprites.dev";
const gatewayBase = requiredValue(loadedEnv.WORKER_URL, "WORKER_URL").replace(
  /\/+$/,
  "",
);
const signingKey = requiredValue(
  loadedEnv.NATIVE_ACCESS_TOKEN_SIGNING_KEY,
  "NATIVE_ACCESS_TOKEN_SIGNING_KEY",
);
const tokenEncryptionKey = requiredValue(
  loadedEnv.TOKEN_ENCRYPTION_KEY,
  "TOKEN_ENCRYPTION_KEY",
);

const managedProcesses: ManagedProcess[] = [];
const managedTemporaryDirectories: string[] = [];
let createdSpriteName: string | null = null;

try {
  await main();
} catch (error) {
  printProcessDiagnostics();
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exitCode = 1;
} finally {
  await cleanup();
}

async function main(): Promise<void> {
  const databasePath = findLocalD1Database(persistDir);
  const userId = findSingleCodexUser(databasePath);
  const gatewayTokenLifetimeSeconds = args.keepServices ? 60 * 60 : 15 * 60;
  const gatewayToken = await signGatewayToken({
    userId,
    signingKey,
    issuer: gatewayBase,
    lifetimeSeconds: gatewayTokenLifetimeSeconds,
  });

  console.log("Credential source: local D1 OpenAI Codex OAuth record");
  console.log(
    "Sprite credential: short-lived Cloude gateway JWT; provider tokens remain server-side",
  );

  const nativeEgressEnabled = Boolean(
    process.env.CODEX_PROXY_SPIKE_NATIVE_PROXY_BIN,
  );
  if (nativeEgressEnabled) {
    await startNativeCodexProxyForGateway(databasePath, gatewayToken);
    await waitForHttp(`http://127.0.0.1:${NATIVE_PROXY_PORT}/health`, 30_000);
  } else {
    startWorker();
    await waitForHttp(LOCAL_HEALTH_URL, 30_000);
  }

  const diagnosticOnly = process.env.CODEX_PROXY_SPIKE_DIAGNOSTIC_ONLY === "1";
  const activeGatewayBase =
    diagnosticOnly && !nativeEgressEnabled
      ? `http://127.0.0.1:${LOCAL_PORT}`
      : await startTunnel();
  console.log(`Gateway: ${new URL(activeGatewayBase).hostname}`);
  await waitForHttp(`${activeGatewayBase}/health`, 45_000);

  await runInvalidGatewayTokenProbe(activeGatewayBase);
  const proxyCredentialAccepted = nativeEgressEnabled
    ? true
    : await runCodexCredentialProbe(activeGatewayBase, gatewayToken);
  if (nativeEgressEnabled) {
    console.log(
      "Egress transport: authenticated native control-plane proxy -> ChatGPT",
    );
  }

  if (!proxyCredentialAccepted) {
    await runLocalNativeFetchControl(databasePath);
    if (diagnosticOnly) {
      printProcessDiagnostics();
      console.log("Diagnostic-only run stopped after the Worker egress probe.");
      return;
    }
    await runNativeCodexProxyControl(databasePath);
    await runLocalDirectCodexControl(databasePath);
    throw new Error(
      "Fresh Codex OAuth works through the official local CLI but ChatGPT rejects the same credential through the proxy.",
    );
  }

  const coordinator = new SpritesCoordinator({ apiKey: spritesApiKey });
  const sprite = await getSprite(coordinator, spritesApiKey, spritesApiUrl);
  console.log(`Sprite: ${sprite.name}`);

  await installCodexGatewayConfig(sprite, activeGatewayBase, gatewayToken);

  if (args.prepareOnly) {
    printInteractiveInstructions(sprite);
    if (args.keepServices) {
      console.log(
        "Proxy and tunnel are running. Press Ctrl-C in this harness to stop them.",
      );
      await waitForShutdownSignal();
    }
    return;
  }

  await runCodexProbe(sprite);
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

async function startTunnel(): Promise<string> {
  const originPort = process.env.CODEX_PROXY_SPIKE_NATIVE_PROXY_BIN
    ? NATIVE_PROXY_PORT
    : LOCAL_PORT;
  const child = spawn(
    "cloudflared",
    [
      "tunnel",
      "run",
      "--protocol",
      "http2",
      "--url",
      `http://127.0.0.1:${originPort}`,
      "cloude-code-tunnel",
    ],
    {
      cwd: PACKAGE_DIR,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const managed = trackProcess("cloudflared", child);
  managedProcesses.push(managed);
  return gatewayBase;
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

  const name = `codex-proxy-spike-${Date.now()}`;
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

async function installCodexGatewayConfig(
  sprite: WorkersSpriteClient,
  baseUrl: string,
  gatewayToken: string,
): Promise<void> {
  const versionResult = await sprite.execHttp("codex --version");
  assertSuccess("read Codex version", versionResult);
  const versionMatch = versionResult.stdout.match(/codex-cli\s+(\S+)/);
  if (!versionMatch?.[1]) {
    throw new Error(`Could not parse Codex version: ${versionResult.stdout}`);
  }
  const codexVersion = versionMatch[1];

  await sprite.writeFile(GATEWAY_TOKEN_PATH, gatewayToken, { mode: "600" });
  await sprite.writeFile(
    CODEX_CONFIG_PATH,
    [
      `model = ${tomlString(CODEX_MODEL)}`,
      'model_provider = "cloude_proxy"',
      "",
      "[model_providers.cloude_proxy]",
      'name = "OpenAI"',
      `base_url = ${tomlString(baseUrl)}`,
      'wire_api = "responses"',
      'env_key = "CLOUDE_CODEX_AUTH_TOKEN"',
      `http_headers = { version = ${tomlString(codexVersion)} }`,
      "",
    ].join("\n"),
    { mode: "600" },
  );
  await sprite.writeFile(
    CODEX_ENV_PATH,
    [
      `export CLOUDE_CODEX_AUTH_TOKEN="$(cat ${shellQuote(GATEWAY_TOKEN_PATH)})"`,
      "export CODEX_HOME=/home/sprite/.codex",
      "",
    ].join("\n"),
    { mode: "600" },
  );

  const result = await sprite.execHttp(
    [
      "set -eu",
      "rm -f /home/sprite/.codex/auth.json",
      'test -x "$(command -v codex)"',
      `test "$(stat -c '%a' ${shellQuote(GATEWAY_TOKEN_PATH)})" = "600"`,
      `test "$(stat -c '%a' ${shellQuote(CODEX_CONFIG_PATH)})" = "600"`,
      "echo codex_gateway_config=ready",
      `echo codex_cli_version=${shellQuote(codexVersion)}`,
    ].join("\n"),
  );
  assertSuccess("install Codex gateway config", result);
  console.log(result.stdout);
}

function printInteractiveInstructions(sprite: WorkersSpriteClient): void {
  console.log("");
  console.log("Attach from your laptop:");
  console.log(
    `  SPRITE_TOKEN="$SPRITES_API_KEY" sprite console --sprite ${sprite.name}`,
  );
  console.log("");
  console.log("Then run inside the Sprite:");
  console.log(`  source ${CODEX_ENV_PATH}`);
  console.log("  codex --no-alt-screen");
  console.log("");
  console.log(
    "The temporary control-plane gateway credential expires in one hour.",
  );
}

async function runCodexProbe(sprite: WorkersSpriteClient): Promise<void> {
  console.log("Running Codex inference through the control-plane proxy...");
  const result = await sprite.execHttp(
    [
      "set -eu",
      "export HOME=/home/sprite",
      `. ${CODEX_ENV_PATH}`,
      "cd /home/sprite",
      "timeout 180 codex -a never exec --skip-git-repo-check --ephemeral --sandbox read-only --color never 'Reply with only codex-proxy-ok' </dev/null",
    ].join("\n"),
  );
  assertSuccess("Codex inference", result);

  const combinedOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (!combinedOutput.includes("codex-proxy-ok")) {
    throw new Error(
      `Codex inference completed without codex-proxy-ok: ${result.stdout}`,
    );
  }

  console.log(result.stdout);
  console.log(
    "PASS: Codex completed inference while its real OAuth access, refresh, and ID tokens stayed in D1/control plane.",
  );
}

async function runInvalidGatewayTokenProbe(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: "Bearer invalid-spike-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });
  if (response.status !== 401) {
    throw new Error(
      `Invalid gateway token probe returned ${response.status}, expected 401`,
    );
  }
  console.log("Negative control: invalid control-plane token rejected");
}

async function runCodexCredentialProbe(
  baseUrl: string,
  gatewayToken: string,
): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await fetch(`${baseUrl}/models?client_version=0.144.3`, {
      headers: {
        Authorization: `Bearer ${gatewayToken}`,
        originator: "codex_cli_rs",
        version: "0.144.3",
      },
    });
    if (response.ok) {
      console.log(
        "Credential control: authenticated Codex models request accepted",
      );
      return true;
    }
    if (attempt === 2) {
      const credentialExpiry =
        response.headers.get("x-cloude-spike-credential-expiry") ?? "unknown";
      const cloudflareCookies =
        response.headers.get("x-cloude-spike-cloudflare-cookies") ?? "unknown";
      const responseBody = await response.text();
      const responseKind = responseBody
        .slice(0, 240)
        .replace(/\s+/g, " ")
        .trim();
      console.log(
        `Proxy credential control rejected: ${response.status} ${response.statusText}; ` +
          `access-token expiry: ${credentialExpiry}; Cloudflare cookies: ${cloudflareCookies}; ` +
          `content-type: ${response.headers.get("content-type") ?? "unknown"}; ` +
          `server: ${response.headers.get("server") ?? "unknown"}; ` +
          `cf-mitigated: ${response.headers.get("cf-mitigated") ?? "none"}; ` +
          `body-prefix: ${responseKind || "<empty>"}`,
      );
      return false;
    }
  }
  return false;
}

async function runLocalNativeFetchControl(
  databasePath: string,
): Promise<boolean> {
  const credentials = await readCodexCredentials(databasePath);
  const accountId = getOpenAIAccountId(credentials.idToken);
  if (!accountId) {
    throw new Error("Fresh Codex ID token does not contain chatgpt_account_id");
  }

  const response = await fetch(
    "https://chatgpt.com/backend-api/codex/models?client_version=0.144.3",
    {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "ChatGPT-Account-ID": accountId,
        originator: "codex_cli_rs",
        version: "0.144.3",
      },
      redirect: "manual",
    },
  );
  if (response.ok) {
    console.log("Local native Node fetch control: PASS");
    await response.body?.cancel();
    return true;
  }

  const responseBody = await response.text();
  const responseKind = responseBody.slice(0, 240).replace(/\s+/g, " ").trim();
  console.log(
    `Local native Node fetch control rejected: ${response.status} ${response.statusText}; ` +
      `content-type: ${response.headers.get("content-type") ?? "unknown"}; ` +
      `server: ${response.headers.get("server") ?? "unknown"}; ` +
      `body-prefix: ${responseKind || "<empty>"}`,
  );
  return false;
}

async function runLocalDirectCodexControl(databasePath: string): Promise<void> {
  const credentials = await readCodexCredentials(databasePath);
  const accountId = getOpenAIAccountId(credentials.idToken);
  if (!accountId) {
    throw new Error("Fresh Codex ID token does not contain chatgpt_account_id");
  }
  const authJson = JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: credentials.idToken,
      access_token: credentials.accessToken,
      refresh_token: credentials.refreshToken,
      account_id: accountId,
    },
    last_refresh: new Date().toISOString(),
  });
  const codexHome = mkdtempSync(join(tmpdir(), "cloude-codex-control-"));
  try {
    writeFileSync(join(codexHome, "auth.json"), authJson, { mode: 0o600 });
    console.log(
      "Running official Codex CLI locally with the fresh D1 credential...",
    );
    const result = spawnSync(
      "codex",
      [
        "-a",
        "never",
        "exec",
        "-m",
        DIRECT_CODEX_MODEL,
        "--skip-git-repo-check",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--color",
        "never",
        "Reply with only direct-codex-control-ok",
      ],
      {
        cwd: PACKAGE_DIR,
        env: { ...process.env, CODEX_HOME: codexHome },
        encoding: "utf8",
        input: "",
        timeout: 180_000,
      },
    );
    if (result.status !== 0) {
      throw new Error(
        `Local direct Codex control failed with exit ${String(result.status)}\n` +
          `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }
    const combinedOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();
    if (!combinedOutput.includes("direct-codex-control-ok")) {
      throw new Error(
        `Local direct Codex control completed without expected output: ${result.stdout}`,
      );
    }
    console.log("Local direct credential control: PASS");
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
}

async function runNativeCodexProxyControl(databasePath: string): Promise<void> {
  const credentials = await readCodexCredentials(databasePath);
  const accountId = getOpenAIAccountId(credentials.idToken);
  if (!accountId) {
    throw new Error("Fresh Codex ID token does not contain chatgpt_account_id");
  }

  const codexHome = mkdtempSync(join(tmpdir(), "cloude-codex-native-proxy-"));
  const serverInfoPath = join(codexHome, "server-info.json");
  const nativeProxyBin =
    process.env.CODEX_PROXY_SPIKE_NATIVE_PROXY_BIN ?? "codex";
  const nativeProxyArgs = [
    "--port",
    String(NATIVE_PROXY_PORT),
    "--server-info",
    serverInfoPath,
    "--upstream-url",
    "https://chatgpt.com/backend-api/codex/responses",
  ];
  if (!process.env.CODEX_PROXY_SPIKE_NATIVE_PROXY_BIN) {
    nativeProxyArgs.unshift("responses-api-proxy");
  }
  const child = spawn(nativeProxyBin, nativeProxyArgs, {
    cwd: PACKAGE_DIR,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CLOUDE_CHATGPT_ACCOUNT_ID: accountId,
      CLOUDE_DOWNSTREAM_TOKEN: "dummy-native-proxy-token",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  managedProcesses.push(trackProcess("codex-native-responses-proxy", child));
  child.stdin.end(`${credentials.accessToken}\n`);

  try {
    await waitForFile(serverInfoPath, 10_000);
    writeFileSync(
      join(codexHome, "config.toml"),
      [
        `model = ${tomlString(DIRECT_CODEX_MODEL)}`,
        'model_provider = "native_proxy"',
        "",
        "[model_providers.native_proxy]",
        'name = "OpenAI"',
        `base_url = ${tomlString(`http://127.0.0.1:${NATIVE_PROXY_PORT}/v1`)}`,
        'wire_api = "responses"',
        'env_key = "CLOUDE_CODEX_AUTH_TOKEN"',
        'env_http_headers = { "ChatGPT-Account-ID" = "CLOUDE_CODEX_ACCOUNT_ID" }',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    console.log(
      "Running Codex through its official native Responses proxy transport...",
    );
    const result = spawnSync(
      "codex",
      [
        "-a",
        "never",
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--color",
        "never",
        "Reply with only native-codex-proxy-ok",
      ],
      {
        cwd: PACKAGE_DIR,
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          CLOUDE_CODEX_ACCOUNT_ID: accountId,
          CLOUDE_CODEX_AUTH_TOKEN: "dummy-native-proxy-token",
        },
        encoding: "utf8",
        input: "",
        timeout: 180_000,
      },
    );
    if (result.status !== 0) {
      throw new Error(
        `Native Codex proxy control failed with exit ${String(result.status)}\n` +
          `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }
    const combinedOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();
    if (!combinedOutput.includes("native-codex-proxy-ok")) {
      throw new Error(
        `Native Codex proxy control completed without expected output: ${result.stdout}`,
      );
    }
    console.log("Native Codex Responses proxy control: PASS");
  } finally {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
    rmSync(codexHome, { recursive: true, force: true });
  }
}

async function startNativeCodexProxyForGateway(
  databasePath: string,
  gatewayToken: string,
): Promise<void> {
  const credentials = await readCodexCredentials(databasePath);
  const accountId = getOpenAIAccountId(credentials.idToken);
  if (!accountId) {
    throw new Error("Fresh Codex ID token does not contain chatgpt_account_id");
  }
  const codexHome = mkdtempSync(join(tmpdir(), "cloude-codex-native-egress-"));
  managedTemporaryDirectories.push(codexHome);
  const serverInfoPath = join(codexHome, "server-info.json");
  const nativeProxyBin = requiredValue(
    process.env.CODEX_PROXY_SPIKE_NATIVE_PROXY_BIN,
    "CODEX_PROXY_SPIKE_NATIVE_PROXY_BIN",
  );
  const child = spawn(
    nativeProxyBin,
    [
      "--port",
      String(NATIVE_PROXY_PORT),
      "--server-info",
      serverInfoPath,
      "--upstream-url",
      "https://chatgpt.com/backend-api/codex/responses",
    ],
    {
      cwd: PACKAGE_DIR,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CLOUDE_CHATGPT_ACCOUNT_ID: accountId,
        CLOUDE_DOWNSTREAM_TOKEN: gatewayToken,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  managedProcesses.push(trackProcess("codex-native-responses-proxy", child));
  child.stdin.end(`${credentials.accessToken}\n`);
  await waitForFile(serverInfoPath, 10_000);
}

async function readCodexCredentials(databasePath: string): Promise<{
  accessToken: string;
  refreshToken: string;
  idToken: string;
}> {
  const encryptedCredentials = querySqlite(
    databasePath,
    [
      "SELECT encrypted_credentials",
      "FROM user_provider_credentials",
      "WHERE provider_id = 'openai-codex'",
      "AND auth_method = 'oauth'",
      "AND requires_reauth = 0",
      "ORDER BY updated_at DESC",
      "LIMIT 1;",
    ].join(" "),
  );
  return JSON.parse(
    await readStoredCredentialJson(encryptedCredentials, tokenEncryptionKey),
  ) as {
    accessToken: string;
    refreshToken: string;
    idToken: string;
  };
}

function getOpenAIAccountId(idToken: string): string | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const authClaim = payload["https://api.openai.com/auth"];
    if (typeof authClaim !== "object" || authClaim === null) {
      return null;
    }
    const accountId = (authClaim as Record<string, unknown>).chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0
      ? accountId
      : null;
  } catch {
    return null;
  }
}

async function signGatewayToken(params: {
  userId: string;
  signingKey: string;
  issuer: string;
  lifetimeSeconds: number;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({ sid: `codex-proxy-spike-${randomUUID()}` })
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
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".sqlite") ||
      entry.name === "metadata.sqlite"
    ) {
      continue;
    }
    const candidate = join(databaseDir, entry.name);
    try {
      const tables = querySqlite(
        candidate,
        "SELECT name FROM sqlite_master WHERE type='table'",
      );
      if (tables.split("\n").includes("user_provider_credentials")) {
        return candidate;
      }
    } catch {
      // Ignore non-D1 SQLite files in the persistence directory.
    }
  }

  throw new Error(
    `No local D1 database with user_provider_credentials found under ${databaseDir}`,
  );
}

function findSingleCodexUser(databasePath: string): string {
  const rows = querySqlite(
    databasePath,
    [
      "SELECT user_id",
      "FROM user_provider_credentials",
      "WHERE provider_id = 'openai-codex'",
      "AND auth_method = 'oauth'",
      "AND requires_reauth = 0",
      "ORDER BY updated_at DESC;",
    ].join(" "),
  )
    .split("\n")
    .filter(Boolean);

  if (rows.length !== 1) {
    throw new Error(
      `Expected exactly one connected local Codex user, found ${rows.length}`,
    );
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
  throw new Error(
    `Timed out waiting for ${new URL(url).hostname}: ${lastError}`,
  );
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for ${path}`);
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
      console.error(
        `Failed to delete Sprite ${createdSpriteName}: ${String(error)}`,
      );
    }
  } else if (createdSpriteName) {
    console.log(`Kept Sprite: ${createdSpriteName}`);
  }

  for (const process of managedProcesses.reverse()) {
    if (!process.child.killed) {
      process.child.kill("SIGTERM");
    }
  }
  await Promise.all(
    managedProcesses.map(async ({ child }) => {
      if (child.exitCode !== null) {
        return;
      }
      await new Promise<void>((resolvePromise) => {
        const timeout = setTimeout(resolvePromise, 2_000);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolvePromise();
        });
      });
    }),
  );
  for (const directory of managedTemporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
}

function parseArgs(values: string[]): ScriptArgs {
  let spriteName: string | undefined;
  let keepSprite = false;
  let prepareOnly = false;
  let keepServices = false;

  for (const value of values) {
    if (value === "--") {
      continue;
    }
    if (value.startsWith("--sprite=")) {
      spriteName = requiredValue(value.slice("--sprite=".length), "--sprite");
      continue;
    }
    if (value === "--keep-sprite") {
      keepSprite = true;
      continue;
    }
    if (value === "--prepare-only") {
      prepareOnly = true;
      continue;
    }
    if (value === "--keep-services") {
      keepServices = true;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }

  if (keepServices && !prepareOnly) {
    throw new Error("--keep-services requires --prepare-only");
  }
  return { spriteName, keepSprite, prepareOnly, keepServices };
}

function resolveRequiredPath(value: string | undefined, name: string): string {
  const path = resolve(requiredValue(value, name));
  if (!existsSync(path)) {
    throw new Error(`${name} does not exist: ${path}`);
  }
  return path;
}

function requiredValue(value: string | undefined, name: string): string {
  if (!value?.trim()) {
    throw new Error(`Missing ${name}`);
  }
  return value.trim();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
