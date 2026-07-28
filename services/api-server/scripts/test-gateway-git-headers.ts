/**
 * Live probe: does the Sprites connector gateway pass git smart-HTTP through?
 *
 * Verified 2026-07-28: the gateway content-negotiates on the request Accept
 * header and returns 406 for git's exact-match media types (e.g.
 * "application/x-git-receive-pack-result"). A single Accept header listing the
 * git type plus a wildcard passes, but git sends the bare type and two
 * separate Accept headers
 * are not merged, so git cannot work around it client-side. Response
 * content-types pass through untouched. Re-run this after a Fly-side fix;
 * every probe should print STATUS:200 before moving post-clone git remotes
 * onto the connector gateway.
 *
 * Usage: SPRITES_API_KEY=... npx tsx scripts/test-gateway-git-headers.ts
 */
import { SpritesClient } from "@fly/sprites";
import {
  buildConnectorGatewayUrl,
  HttpSpriteConnectorsClient,
  SpriteLifecycleClient,
} from "@repo/sprites-client";
import {
  deleteConnectorAndVerify,
  mintConnector,
  MintConnectorRequestSchema,
} from "../src/shared/integrations/sprite-connectors";

const apiKey = process.env.SPRITES_API_KEY;
if (!apiKey) {
  throw new Error("Set SPRITES_API_KEY");
}
const spritesApiUrl = process.env.SPRITES_API_URL ?? "https://api.sprites.dev";

const logger = {
  log() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  scope() {
    return this;
  },
} as never;

async function main(): Promise<void> {
  const lifecycle = new SpriteLifecycleClient({ apiKey, logger });
  const connectors = new HttpSpriteConnectorsClient({
    apiUrl: spritesApiUrl,
    apiToken: apiKey,
  });
  const name = `git-probe-${Date.now()}`;
  const label = `session:${name}`;

  console.log("creating sprite", name);
  await lifecycle.createSprite({ name, labels: [label] });

  let connectionId: string | null = null;
  try {
    const request = MintConnectorRequestSchema.parse({
      name: `probe-${name}`,
      baseApiUrl: "https://httpbin.org",
      token: "dummy-not-a-secret",
      testUrl: "https://httpbin.org/headers",
      spriteLabels: [label],
      allowedEndpoints: ["/anything/*", "/headers", "/response-headers*"],
    });
    const minted = await mintConnector(request, { spritesClient: connectors });
    if (!minted.ok) {
      throw new Error(`mint failed: ${minted.error.code} at ${minted.error.stage}`);
    }
    connectionId = minted.value.gatewayConnectionId;
    const gateway = buildConnectorGatewayUrl(spritesApiUrl, connectionId);
    console.log("minted", connectionId);

    const sprite = new SpritesClient(apiKey!).sprite(name);
    const run = async (title: string, command: string) => {
      const result = await sprite.execFile("bash", ["-c", command]);
      console.log(`--- ${title} (exit ${result.exitCode})`);
      console.log(result.stdout.slice(0, 1200));
      if (result.stderr.trim()) {
        console.log("stderr:", result.stderr.slice(0, 300));
      }
    };

    await run(
      "A: query string forwarding",
      `curl -sS -w "\\nSTATUS:%{http_code}\\n" "${gateway}/anything/q?service=git-receive-pack" | grep -E "args|service|STATUS" `,
    );
    await run(
      "B: git Accept header",
      `curl -sS -o /tmp/b.out -w "STATUS:%{http_code}\\n" -H "Accept: application/x-git-upload-pack-advertisement" "${gateway}/anything/accept"; head -c 400 /tmp/b.out`,
    );
    await run(
      "C: POST git content-type body",
      `curl -sS -o /tmp/c.out -w "STATUS:%{http_code}\\n" -X POST -H "Content-Type: application/x-git-receive-pack-request" -H "Accept: application/x-git-receive-pack-result" --data-binary "00000000" "${gateway}/anything/post"; grep -E '"data"|"Content-Type"|"Accept"' /tmp/c.out | head -5`,
    );
    await run(
      "D: deep wildcard path",
      `curl -sS -o /dev/null -w "STATUS:%{http_code}\\n" "${gateway}/anything/deep/o/r.git/info/refs?service=git-upload-pack"`,
    );
    await run(
      "E: git user agent",
      `curl -sS -o /dev/null -w "STATUS:%{http_code}\\n" -A "git/2.43.0" -H "Git-Protocol: version=2" "${gateway}/anything/ua"`,
    );
    await run(
      "F: POST git content-type, default Accept",
      `curl -sS -o /dev/null -w "STATUS:%{http_code}\\n" -X POST -H "Content-Type: application/x-git-receive-pack-request" --data-binary "00000000" "${gateway}/anything/f"`,
    );
    await run(
      "G: GET Accept */*",
      `curl -sS -o /dev/null -w "STATUS:%{http_code}\\n" -H "Accept: */*" "${gateway}/anything/g"`,
    );
    await run(
      "H: POST json content-type, git Accept",
      `curl -sS -o /dev/null -w "STATUS:%{http_code}\\n" -X POST -H "Content-Type: application/json" -H "Accept: application/x-git-upload-pack-result" --data "{}" "${gateway}/anything/h"`,
    );
    await run(
      "J: two Accept headers (git first, */* second)",
      `curl -sS -o /dev/null -w "STATUS:%{http_code}\\n" -X POST -H "Content-Type: application/x-git-receive-pack-request" -H "Accept: application/x-git-receive-pack-result" -H "Accept: */*" --data-binary "00000000" "${gateway}/anything/j"`,
    );
    await run(
      "K: git-typed response passes back",
      `curl -sS -o /tmp/k.out -w "STATUS:%{http_code} TYPE:%{content_type}\\n" "${gateway}/response-headers?Content-Type=application/x-git-upload-pack-result"`,
    );
    await run(
      "I: GET git Accept plus */*",
      `curl -sS -o /dev/null -w "STATUS:%{http_code}\\n" -H "Accept: application/x-git-upload-pack-advertisement, */*" "${gateway}/anything/i"`,
    );
  } finally {
    if (connectionId) {
      const cleanup = await deleteConnectorAndVerify(connectionId, connectors);
      console.log("connector deleted:", cleanup.ok);
    }
    await lifecycle.deleteSprite(name);
    console.log("sprite deleted:", name);
  }
}

main().catch((error: unknown) => {
  console.error("probe failed:", error);
  process.exitCode = 1;
});
