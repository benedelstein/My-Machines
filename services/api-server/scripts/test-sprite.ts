#!/usr/bin/env npx tsx


import { config } from "dotenv";
config({ path: ".env.local" });
import type { Sprite } from "@fly/sprites";
import { SpritesClient } from "@fly/sprites";
import { SpriteLifecycleClient } from "@repo/sprites-client";
import { ConsoleLogger } from "@repo/shared";

const SPRITES_API_KEY = process.env.SPRITES_API_KEY!;
const SPRITES_API_URL = process.env.SPRITES_API_URL || "https://api.sprites.dev";
// const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
const REPO_ID = process.env.REPO_ID || "anthropics/claude-code";

if (!SPRITES_API_KEY) {
  console.error("SPRITES_API_KEY is required");
  process.exit(1);
}

const connectClaude = async (nativeSprite: Sprite) => {
  // Use spawn directly to ensure options are passed correctly
  const session = nativeSprite.spawn("/bin/bash", [], {
    cwd: "/home/sprite/workspace",
    tty: true,
    cols: 80,
    rows: 24,
    // env: ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY } : undefined,
  });

  session.on("message", (msg: unknown) => {
    console.log(`[message] ${JSON.stringify(msg)}`);
  });

  session.stdout.on("data", (chunk: Buffer) => {
    process.stdout.write(`[stdout] ${chunk.toString()}`);
  });

  session.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(`[stderr] ${chunk.toString()}`);
  });

  session.on("exit", (code: number) => {
    console.log(`\n[exit] python exited with code ${code}`);
  });

  session.on("error", (err: Error) => {
    console.error(`[error] ${err.message}`);
  });

  // createSession auto-starts via spawn(), wait for 'spawn' event
  await new Promise<void>((resolve, reject) => {
    session.on("spawn", () => {
      // Send resize after connection since server ignores initial cols/rows
      session.resize(80, 24);
      resolve();
    });
    session.on("error", reject);
  });
  console.log("session started (via native SDK)");
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (input: string) => {
    console.log(`[stdin] ${input}`);
    session.stdin.write(input);
  });
  return session;
}

const cloneRepo = async (sprite: Sprite) => {
  console.log(`\n--- Cloning ${REPO_ID} ---`);
  await sprite.execFile("sh", ["-c", "rm -rf ~/workspace && mkdir -p ~/workspace"]);

  const clone = await sprite.execFile("sh", [
    "-c",
    `git clone https://github.com/${REPO_ID}.git ~/workspace`,
  ]);
  console.log(`Clone: stdout="${clone.stdout}" stderr="${clone.stderr}" exitCode=${clone.exitCode}`);

  const verify = await sprite.execFile("sh", ["-c", "ls ~/workspace | head -10"]);
  console.log(`\nWorkspace after clone:\n${verify.stdout}`);
}

async function main() {
  const spriteName = process.argv[2];

  // Our client for sprite lifecycle operations
  const lifecycleClient = new SpriteLifecycleClient({
    apiKey: SPRITES_API_KEY,
    logger: new ConsoleLogger({ format: "pretty" }, "test-sprite.ts"),
  });
  // Native SDK for WebSocket (since Workers WebSocket doesn't work in Node.js)
  const nativeClient = new SpritesClient(SPRITES_API_KEY, {
    baseURL: SPRITES_API_URL,
  });

  let nativeSprite: Awaited<ReturnType<typeof nativeClient.getSprite>>;
  let createdSprite = false;
  let finalSpriteName: string;

  if (spriteName) {
    console.log(`Connecting to existing sprite: ${spriteName}`);
    nativeSprite = await nativeClient.getSprite(spriteName);
    finalSpriteName = spriteName;
    console.log(`Connected to sprite: ${spriteName}`);
  } else {
    const name = `test-${Date.now()}`;
    console.log(`Creating new sprite: ${name}`);
    const spriteResponse = await lifecycleClient.createSprite({ name });
    console.log(`Created sprite: ${spriteResponse.name} (status: ${spriteResponse.status})`);
    nativeSprite = await nativeClient.getSprite(spriteResponse.name);
    finalSpriteName = spriteResponse.name;
    createdSprite = true;
  }

  // Clone repo if needed
  const wsCheck = await nativeSprite.execFile("sh", [
    "-c",
    "test -d ~/workspace/.git && echo 'exists' || echo 'empty'",
  ]);
  console.log(`Workspace check: stdout="${wsCheck.stdout}" stderr="${wsCheck.stderr}" exitCode=${wsCheck.exitCode}`);
  if (!String(wsCheck.stdout).includes("exists")) {
    await cloneRepo(nativeSprite);
  } else {
    console.log("Workspace already has repo");
  }
  console.log("\n=== Listing sessions ===");
  const ourSessions = await lifecycleClient.listSessions(finalSpriteName);
  console.log(`Our listSessions: ${JSON.stringify(ourSessions, null, 2)}`);

  const result = await nativeSprite.exec("ls");
  console.log(`ls Result: stdout="${result.stdout}" stderr="${result.stderr}" exitCode=${result.exitCode}`);

  // Test WebSocket session with native SDK (our Workers WebSocket won't work in Node.js)
  console.log("\n=== Starting Claude session (using native SDK) ===");
  const claudeSession = await connectClaude(nativeSprite);

  // List sessions again
  const sessionsAfter = await lifecycleClient.listSessions(finalSpriteName);
  console.log(`\nSessions after start: ${JSON.stringify(sessionsAfter, null, 2)}`);

  // Interactive mode
  console.log("\n--- Session active. Press Ctrl+C to exit ---");
  console.log("Type a message and press Enter to send to Claude:\n");

  process.on("SIGINT", async () => {
    console.log("\n\nCleaning up...");
    claudeSession.kill();

    if (createdSprite) {
      console.log(`Deleting sprite ${finalSpriteName}...`);
      await lifecycleClient.deleteSprite(finalSpriteName);
      console.log("Sprite deleted");
    }

    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
