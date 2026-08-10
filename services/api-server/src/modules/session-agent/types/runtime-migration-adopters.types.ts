import type { NetworkAccessConfig, ProviderId } from "@repo/shared";

/** Functional connector state; allocated identity and credentials are excluded. */
export type SessionConnectorContract = {
  readonly contractSchema: 1;
  readonly provider: "custom_api";
  readonly baseApiUrl: string;
  readonly testUrl: string;
  readonly requiredSpriteLabels: readonly string[];
  readonly accessPolicy: {
    readonly allowedEndpoints: readonly string[];
    readonly blockedEndpoints: readonly string[];
  };
};

/** Desired network state derived only from the session's persisted snapshot. */
export type SpriteNetworkPolicyContract = {
  readonly contractSchema: 1;
  readonly providerId: ProviderId;
  readonly requestedNetwork: NetworkAccessConfig;
  readonly workerHostname: string;
  readonly connectorGatewayHostname: string;
  readonly rules: readonly {
    readonly domain: string;
    readonly action: "allow" | "deny";
  }[];
};
