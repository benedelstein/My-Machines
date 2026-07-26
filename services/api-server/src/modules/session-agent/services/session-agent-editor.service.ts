import { buildNetworkPolicy, WorkersSpriteClient } from "@repo/sprites-client";
import { createLogger } from "@/shared/logging";
import type { Logger } from "@repo/shared";
import type { Env } from "@/shared/types";
import type { SecretRepository } from "../repositories/secret.repository";

const WORKSPACE_DIR = "/home/sprite/workspace";
const HOME_DIR = "/home/sprite";

type EditorContext = {
  spriteName: string | null;
  editorUrl: string | null;
  editorToken: string | null;
  env: Env;
  logger: Logger;
  secretRepository: SecretRepository;
  setEditorUrl: (url: string | null) => void;
  broadcastEditorReady: (url: string, token: string) => void;
};

export type EditorOpenResult = {
  response: Response;
  editorToken: string | null;
};

export async function handleEditorOpen(context: EditorContext): Promise<EditorOpenResult> {
  const { env, secretRepository } = context;
  const logger = context.logger.scope("session-agent-editor.service.ts");

  if (!context.spriteName) {
    return {
      response: Response.json({ error: "No sprite provisioned" }, { status: 400 }),
      editorToken: context.editorToken,
    };
  }

  // If editor is already open, return the existing URL
  if (context.editorUrl && context.editorToken) {
    return {
      response: Response.json({ url: context.editorUrl, token: context.editorToken }),
      editorToken: context.editorToken,
    };
  }

  const sprite = new WorkersSpriteClient(
    context.spriteName,
    env.SPRITES_API_KEY,
    env.SPRITES_API_URL,
    createLogger("sprite-websocket.session.ts"),
  );

  try {
    // Ensure network policy allows GitHub release downloads (may not be set on older Sprites)
    const workerHostname = new URL(env.WORKER_URL).hostname;
    await sprite.setNetworkPolicy(
      buildNetworkPolicy([{ domain: workerHostname, action: "allow" }]),
    );

    // Install openvscode-server if not already present
    // TODO: make this one script/bash line
    const checkResult = await sprite.execWs(
      `test -f ${HOME_DIR}/.openvscode/bin/openvscode-server && echo 'installed' || echo 'missing'`,
      {},
    );
    if (checkResult.stdout.includes("missing")) {
      logger.info("Installing openvscode-server on sprite");
      const installResult = await sprite.execWs(
        [
          `curl -fsSL https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v1.109.5/openvscode-server-v1.109.5-linux-x64.tar.gz -o /tmp/ovs.tar.gz`,
          `mkdir -p ${HOME_DIR}/.openvscode`,
          `tar -xzf /tmp/ovs.tar.gz -C ${HOME_DIR}/.openvscode --strip-components=1`,
          `rm /tmp/ovs.tar.gz`,
        ].join(" && "),
        {},
      );
      if (installResult.exitCode !== 0) {
        throw new Error(
          `openvscode-server install failed (exit ${installResult.exitCode}): ${installResult.stderr}`,
        );
      }
      logger.info("openvscode-server installed successfully");
    }

    // Generate a connection token for auth
    const token = crypto.randomUUID();
    secretRepository.set("editor_token", token);

    // Write the token to a file and start openvscode-server with --connection-token-file
    const tokenFile = `${HOME_DIR}/.openvscode/.connection-token`;
    // Kill any existing openvscode-server processes
    await sprite.execWs(
      `pkill -f openvscode-server 2>/dev/null || true; fuser -k 8080/tcp 2>/dev/null || true; sleep 1`,
      {},
    );
    await sprite.execWs(`echo -n '${token}' > ${tokenFile}`, {});

    // Start as a background process via nohup so it persists
    await sprite.execWs(
      `nohup ${HOME_DIR}/.openvscode/bin/openvscode-server --host 0.0.0.0 --port 8080 --connection-token-file ${tokenFile} --default-folder ${WORKSPACE_DIR} > /tmp/openvscode.log 2>&1 &`,
      {},
    );

    // Wait for the server to start listening
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Make the Sprite URL public so the browser can reach it directly
    await sprite.setUrlAuth("public");

    // Get the Sprite's public URL
    const spriteInfo = await sprite.getSpriteInfo();
    if (!spriteInfo.url) {
      throw new Error("Sprite does not have a public URL");
    }

    const editorUrl = spriteInfo.url;
    context.setEditorUrl(editorUrl);

    logger.info("Editor ready", {
      fields: { editorUrl },
    });
    // Broadcast to all WS clients so other tabs/windows can open the editor too
    context.broadcastEditorReady(editorUrl, token);

    return {
      response: Response.json({ url: editorUrl, token }),
      editorToken: token,
    };
  } catch (error) {
    logger.error("Failed to open editor", { error });
    const message = error instanceof Error ? error.message : "Failed to open editor";
    return {
      response: Response.json({ error: message }, { status: 500 }),
      editorToken: context.editorToken,
    };
  }
}

export async function handleEditorClose(context: EditorContext): Promise<EditorOpenResult> {
  const { env, secretRepository } = context;
  const logger = context.logger.scope("session-agent-editor.service.ts");

  if (!context.spriteName) {
    return {
      response: Response.json({ error: "No sprite provisioned" }, { status: 400 }),
      editorToken: context.editorToken,
    };
  }

  const sprite = new WorkersSpriteClient(
    context.spriteName,
    env.SPRITES_API_KEY,
    env.SPRITES_API_URL,
    createLogger("sprite-websocket.session.ts"),
  );

  try {
    // Kill openvscode-server
    await sprite.execWs(`fuser -k 8080/tcp 2>/dev/null || true`, {});

    // Revoke public URL access
    await sprite.setUrlAuth("sprite");

    // Clear editor state
    secretRepository.set("editor_token", "");
    context.setEditorUrl(null);

    logger.info("Editor closed");
    return {
      response: Response.json({ closed: true }),
      editorToken: null,
    };
  } catch (error) {
    logger.error("Failed to close editor", { error });
    const message = error instanceof Error ? error.message : "Failed to close editor";
    return {
      response: Response.json({ error: message }, { status: 500 }),
      editorToken: context.editorToken,
    };
  }
}
