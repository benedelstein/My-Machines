import type { WorkersSpriteClient } from "@repo/sprites-client";
import { createLogger } from "@/shared/logging";
import type { AuthCredentialSnapshot } from "../../types/agent-process-manager.types";

/**
 * Writes the vm-agent bundle to the sprite, skipping the upload when the
 * file already on disk matches the embedded bundle. The sprite is the source
 * of truth — we hash on the sprite via `sha256sum` instead of tracking a
 * "last written" hash in DO state, so a sprite reset or missing file
 * naturally falls through to a re-upload.
 */
export async function writeVmAgentScript(
  sprite: WorkersSpriteClient,
  scriptPath: string,
  script: string,
  expectedHash: string | null,
): Promise<void> {
  const logger = createLogger("write-files.service.ts");
  try {
    const result = await sprite.execWs(
      `sha256sum ${scriptPath} 2>/dev/null | cut -d' ' -f1`,
    );
    if (result.exitCode === 0 && result.stdout.trim() === expectedHash) {
      logger.debug("vm-agent script unchanged, skipping upload");
      return;
    }
  } catch (error) {
    logger.debug("vm-agent hash check failed, will re-upload", {
      error,
    });
  }
  logger.debug("vm-agent script hash check failed, will re-upload");
  await sprite.writeFile(scriptPath, script);
}

export async function writeCredentialFiles(
  sprite: WorkersSpriteClient,
  snapshot: AuthCredentialSnapshot,
): Promise<void> {
  for (const file of snapshot.files) {
    await sprite.writeFile(
      file.path,
      file.contents,
      file.mode ? { mode: file.mode } : undefined,
    );
  }
}
