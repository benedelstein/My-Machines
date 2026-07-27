import type { Env } from "@/shared/types/env";

export interface SessionConnectorConfig {
  /** Mint a per-session connector during provisioning. */
  mintEnabled: boolean;
  /** Hand the VM the connector gateway base instead of DO_WEBHOOK_TOKEN. */
  webhookCutover: boolean;
  /** Route post-clone git through the connector gateway. */
  gitCutover: boolean;
}

/**
 * Resolves the session-connector rollout flags from optional env vars.
 * Either cutover implies minting, so a cutover flag alone is sufficient.
 *
 * @param env - Worker environment bindings.
 * @returns The effective session-connector configuration.
 */
export function getSessionConnectorConfig(env: Env): SessionConnectorConfig {
  const webhookCutover = isFlagEnabled(env.SESSION_CONNECTOR_WEBHOOK_CUTOVER);
  const gitCutover = isFlagEnabled(env.SESSION_CONNECTOR_GIT_CUTOVER);
  return {
    mintEnabled:
      isFlagEnabled(env.SESSION_CONNECTORS_ENABLED) || webhookCutover || gitCutover,
    webhookCutover,
    gitCutover,
  };
}

function isFlagEnabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}
