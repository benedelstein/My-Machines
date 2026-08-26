import type { ClientState, Logger } from "@repo/shared";
import type { Env } from "@/shared/types";
import type { ServerState } from
  "../types/server-state.types";

export interface ProviderConnectionStatus {
  connected: boolean;
  requiresReauth: boolean;
}

export interface SessionProviderConnectionServiceDeps {
  logger: Logger;
  env: Env;

  getServerState: () => ServerState;
  getClientState: () => ClientState;
  updatePartialState: (partial: Partial<ClientState>) => void;
  getProviderConnectionStatus(
    provider: ClientState["agentSettings"]["provider"],
    userId: string,
    env: Env,
    logger: Logger,
  ): Promise<ProviderConnectionStatus>;
}

/**
 * Owns resolving and refreshing the session's provider connection state
 * (e.g. Claude, Codex auth status) from the provider auth service.
 */
export class SessionProviderConnectionService {
  private readonly logger: Logger;
  private readonly env: Env;
  private readonly getServerState: () => ServerState;
  private readonly getClientState: () => ClientState;
  private readonly updatePartialState: SessionProviderConnectionServiceDeps["updatePartialState"];
  private readonly getProviderConnectionStatus: SessionProviderConnectionServiceDeps["getProviderConnectionStatus"];

  constructor(deps: SessionProviderConnectionServiceDeps) {
    this.logger = deps.logger.scope("session-provider-connection");
    this.env = deps.env;
    this.getServerState = deps.getServerState;
    this.getClientState = deps.getClientState;
    this.updatePartialState = deps.updatePartialState;
    this.getProviderConnectionStatus = deps.getProviderConnectionStatus;
  }

  /**
   * Resolves the current connection state for a provider. Returns a
   * "disconnected" shape when no userId is available, and null when the
   * provider auth service throws.
   */
  async resolveState(
    providerId: ClientState["agentSettings"]["provider"],
    userId: string | null,
  ): Promise<ClientState["providerConnection"]> {
    if (!userId) {
      return {
        provider: providerId,
        connected: false,
        requiresReauth: false,
      };
    }

    try {
      const status = await this.getProviderConnectionStatus(
        providerId,
        userId,
        this.env,
        this.logger,
      );
      return {
        provider: providerId,
        connected: status.connected,
        requiresReauth: status.requiresReauth,
      };
    } catch (error) {
      this.logger.error("Failed to resolve provider connection state", {
        error,
        fields: { provider: providerId, userId },
      });
      return null;
    }
  }

  /**
   * Refreshes the active session provider connection state from the provider
   * auth service, using the current client/server state as inputs.
   */
  async refresh(): Promise<void> {
    const providerConnection = await this.resolveState(
      this.getClientState().agentSettings.provider,
      this.getServerState().userId,
    );
    if (providerConnection) {
      this.updatePartialState({ providerConnection });
    }
  }

  /** Fire-and-forget refresh; logs if it fails. */
  queueRefresh(): void {
    this.refresh().catch((error) => {
      this.logger.error("Failed to refresh provider connection state", { error });
    });
  }
}
