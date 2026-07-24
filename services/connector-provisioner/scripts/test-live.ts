import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const EnvironmentSchema = z.object({
  SPRITES_DASHBOARD_STORAGE_STATE: z.string().min(1),
  SPRITES_API_KEY: z.string().min(1),
  SPRITES_ORG_SLUG: z.string().min(1),
  CONNECTOR_LIVE_TEST_BASE_API_URL: z.string().url(),
  CONNECTOR_LIVE_TEST_TEST_URL: z.string().url(),
  CONNECTOR_LIVE_TEST_SPRITE_LABEL: z.string().min(1),
  CONNECTOR_LIVE_TEST_TOKEN: z.string().min(1).optional(),
  CONNECTOR_LIVE_TEST_HEADER_PREFIX: z.string().optional(),
});

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.resolve(scriptDirectory, "..");

async function main(): Promise<void> {
  const parsedEnvironment = EnvironmentSchema.safeParse(process.env);
  if (!parsedEnvironment.success) {
    throw new Error(
      "Missing required connector live-test environment. See services/connector-provisioner/.env.example.",
    );
  }

  const environment = parsedEnvironment.data;
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "connector-provisioner-"));
  const envFile = path.join(temporaryDirectory, ".dev.vars");
  const bearerToken = crypto.randomUUID();
  const dummyToken = environment.CONNECTOR_LIVE_TEST_TOKEN
    ?? `dummy-${crypto.randomUUID()}`;
  const port = 8_800 + Math.floor(Math.random() * 800);
  const workerUrl = `http://127.0.0.1:${port}`;
  const sensitiveValues = [
    bearerToken,
    dummyToken,
    environment.SPRITES_API_KEY,
    environment.SPRITES_DASHBOARD_STORAGE_STATE,
  ];

  let worker: ChildProcess | undefined;
  try {
    await writeFile(envFile, [
      envLine("CONNECTOR_PROVISIONER_BEARER_TOKEN", bearerToken),
      envLine("SPRITES_API_KEY", environment.SPRITES_API_KEY),
      envLine("SPRITES_DASHBOARD_STORAGE_STATE", environment.SPRITES_DASHBOARD_STORAGE_STATE),
      envLine("SPRITES_ORG_SLUG", environment.SPRITES_ORG_SLUG),
    ].join("\n"), { mode: 0o600 });

    worker = spawn("pnpm", [
      "exec",
      "wrangler",
      "dev",
      "--remote",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--env-file",
      envFile,
      "--show-interactive-dev-session=false",
      "--log-level",
      "error",
    ], {
      cwd: packageDirectory,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const output = captureOutput(worker, sensitiveValues);
    await waitForHealth(workerUrl, worker, output);

    const response = await fetch(`${workerUrl}/v1/connectors/live-test`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `cloude-live-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
        baseApiUrl: environment.CONNECTOR_LIVE_TEST_BASE_API_URL,
        token: dummyToken,
        testUrl: environment.CONNECTOR_LIVE_TEST_TEST_URL,
        headerName: "Authorization",
        headerPrefix: environment.CONNECTOR_LIVE_TEST_HEADER_PREFIX ?? "Bearer",
        spriteLabels: [environment.CONNECTOR_LIVE_TEST_SPRITE_LABEL],
      }),
    });
    const responseBody: unknown = await response.json();
    if (!response.ok) {
      throw new Error(`Live test failed (${response.status}): ${JSON.stringify(responseBody)}`);
    }

    process.stdout.write(`${JSON.stringify(responseBody, null, 2)}\n`);
  } finally {
    worker?.kill("SIGTERM");
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function captureOutput(
  worker: ChildProcess,
  sensitiveValues: string[],
): { read: () => string } {
  let output = "";
  const append = (chunk: Buffer): void => {
    output = `${output}${redact(chunk.toString(), sensitiveValues)}`.slice(-8_000);
  };
  worker.stdout?.on("data", append);
  worker.stderr?.on("data", append);
  return { read: () => output };
}

async function waitForHealth(
  workerUrl: string,
  worker: ChildProcess,
  output: { read: () => string },
): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (worker.exitCode !== null) {
      throw new Error(`Wrangler exited before startup:\n${output.read()}`);
    }

    try {
      const response = await fetch(`${workerUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Wrangler has not opened its local proxy yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Wrangler:\n${output.read()}`);
}

function envLine(name: string, value: string): string {
  if (value.includes("'")) {
    throw new Error(`Cannot encode ${name} in the temporary environment file.`);
  }
  return `${name}='${value}'`;
}

function redact(value: string, sensitiveValues: string[]): string {
  return sensitiveValues.reduce((result, secret) => {
    return secret.length === 0 ? result : result.replaceAll(secret, "[REDACTED]");
  }, value);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown live-test failure";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
