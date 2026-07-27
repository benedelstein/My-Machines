import { HttpSpriteConnectorsClient } from "@repo/sprites-client";
import { z } from "zod";
import {
  deleteConnectorAndVerify,
  mintConnector,
  MintConnectorRequestSchema,
} from "../src/shared/integrations/sprite-connectors";

const EnvironmentSchema = z.object({
  SPRITES_API_KEY: z.string().min(1),
  SPRITES_API_URL: z.string().url().optional(),
  CONNECTOR_LIVE_TEST_BASE_API_URL: z.string().url(),
  CONNECTOR_LIVE_TEST_TEST_URL: z.string().url(),
  CONNECTOR_LIVE_TEST_SPRITE_LABEL: z.string().min(1),
  CONNECTOR_LIVE_TEST_TOKEN: z.string().min(1).optional(),
  CONNECTOR_LIVE_TEST_HEADER_PREFIX: z.string().optional(),
  CONNECTOR_LIVE_TEST_ALLOWED_ENDPOINTS: z.string().min(1).optional(),
});

async function main(): Promise<void> {
  const parsedEnvironment = EnvironmentSchema.safeParse(process.env);
  if (!parsedEnvironment.success) {
    throw new Error(
      "Set SPRITES_API_KEY and the CONNECTOR_LIVE_TEST_* environment variables.",
    );
  }

  const environment = parsedEnvironment.data;
  const allowedEndpoints = environment.CONNECTOR_LIVE_TEST_ALLOWED_ENDPOINTS === undefined
    ? (environment.CONNECTOR_LIVE_TEST_SPRITE_LABEL.startsWith("session:")
      ? [new URL(environment.CONNECTOR_LIVE_TEST_TEST_URL).pathname]
      : undefined)
    : environment.CONNECTOR_LIVE_TEST_ALLOWED_ENDPOINTS
      .split(",")
      .map((endpoint) => endpoint.trim())
      .filter((endpoint) => endpoint.length > 0);
  const request = MintConnectorRequestSchema.parse({
    name: `cloude-live-${Date.now()}`,
    baseApiUrl: environment.CONNECTOR_LIVE_TEST_BASE_API_URL,
    token: environment.CONNECTOR_LIVE_TEST_TOKEN ?? `dummy-${crypto.randomUUID()}`,
    testUrl: environment.CONNECTOR_LIVE_TEST_TEST_URL,
    headerName: "Authorization",
    headerPrefix: environment.CONNECTOR_LIVE_TEST_HEADER_PREFIX ?? "Bearer",
    spriteLabels: [environment.CONNECTOR_LIVE_TEST_SPRITE_LABEL],
    ...(allowedEndpoints === undefined ? {} : { allowedEndpoints }),
  });
  const spritesClient = new HttpSpriteConnectorsClient({
    apiUrl: environment.SPRITES_API_URL ?? "https://api.sprites.dev",
    apiToken: environment.SPRITES_API_KEY,
  });

  const mintResult = await mintConnector(request, { spritesClient });
  if (!mintResult.ok) {
    const failedCleanup = mintResult.error.cleanup.attempted
      && !mintResult.error.cleanup.succeeded
      ? `; orphan connector ${mintResult.error.cleanup.gatewayConnectionId}`
      : "";
    throw new Error(
      `Connector mint failed: ${mintResult.error.code} at ${mintResult.error.stage}${failedCleanup}`,
    );
  }

  const cleanupResult = await deleteConnectorAndVerify(
    mintResult.value.gatewayConnectionId,
    spritesClient,
  );
  if (!cleanupResult.ok) {
    throw new Error(`Connector cleanup failed: ${cleanupResult.error.cause}`);
  }

  process.stdout.write(`${JSON.stringify({
    connectorName: mintResult.value.name,
    gatewayConnectionId: mintResult.value.gatewayConnectionId,
    accessPolicy: mintResult.value.accessPolicy,
    durations: mintResult.value.durations,
    deleted: true,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown live-test failure";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
