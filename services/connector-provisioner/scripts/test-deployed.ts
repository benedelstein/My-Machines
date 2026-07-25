import { z } from "zod";

const EnvironmentSchema = z.object({
  CONNECTOR_PROVISIONER_DEPLOYED_URL: z.string().url()
    .default("https://my-machines-connector-provisioner.bedelstein12.workers.dev"),
  CONNECTOR_PROVISIONER_DEPLOYED_BEARER_TOKEN: z.string().min(1),
  CONNECTOR_LIVE_TEST_BASE_API_URL: z.string().url(),
  CONNECTOR_LIVE_TEST_TEST_URL: z.string().url(),
  CONNECTOR_LIVE_TEST_SPRITE_LABEL: z.string().min(1),
  CONNECTOR_LIVE_TEST_TOKEN: z.string().min(1).optional(),
  CONNECTOR_LIVE_TEST_HEADER_PREFIX: z.string().optional(),
});

async function main(): Promise<void> {
  const parsedEnvironment = EnvironmentSchema.safeParse(process.env);
  if (!parsedEnvironment.success) {
    throw new Error(
      "Missing deployed-test environment. Source .env.live.local first.",
    );
  }
  const environment = parsedEnvironment.data;

  const response = await fetch(
    `${environment.CONNECTOR_PROVISIONER_DEPLOYED_URL}/v1/connectors/live-test`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${environment.CONNECTOR_PROVISIONER_DEPLOYED_BEARER_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `cloude-deployed-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
        baseApiUrl: environment.CONNECTOR_LIVE_TEST_BASE_API_URL,
        token: environment.CONNECTOR_LIVE_TEST_TOKEN ?? `dummy-${crypto.randomUUID()}`,
        testUrl: environment.CONNECTOR_LIVE_TEST_TEST_URL,
        headerName: "Authorization",
        headerPrefix: environment.CONNECTOR_LIVE_TEST_HEADER_PREFIX ?? "Bearer",
        spriteLabels: [environment.CONNECTOR_LIVE_TEST_SPRITE_LABEL],
      }),
    },
  );

  const responseBody: unknown = await response.json();
  if (!response.ok) {
    throw new Error(`Deployed live test failed (${response.status}): ${JSON.stringify(responseBody)}`);
  }
  process.stdout.write(`${JSON.stringify(responseBody, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown deployed-test failure";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
