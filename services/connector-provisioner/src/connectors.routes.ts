import { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { ConsoleLogger } from "@repo/shared";
import type {
  SpritesConnection,
  SpriteConnectorsClient,
} from "@repo/sprites-client";
import { deleteConnectorAndVerify, mintConnector } from "./connector-minting.service";
import {
  deleteConnectorRoute,
  liveTestConnectorRoute,
  mintConnectorRoute,
} from "./connectors.schema";
import { hasBaseConfiguration, hasMintConfiguration, type Env } from "./env";
import type { DashboardConnectorClient } from "./types";
import { durationFields, hasValidBearer } from "./utils";

type ConnectorRouteEnv = { Bindings: Env };

export interface ConnectorRouteDeps {
  createSpritesClient(env: Env): SpriteConnectorsClient;
  createDashboardClient(env: Env): DashboardConnectorClient;
}

const logger = new ConsoleLogger({ format: "pretty" }, "connectors.routes.ts");

export function createConnectorRoutes(dependencies: ConnectorRouteDeps): OpenAPIHono<ConnectorRouteEnv> {
  const routes = new OpenAPIHono<ConnectorRouteEnv>({
    // defaultHook runs after every route's zod request validation; on failure
    // it replaces @hono/zod-openapi's default 400 (which echoes raw zod
    // issues, including submitted values) with the service's error envelope.
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: { code: "invalid_request" } }, 400);
      }
    },
  });

  routes.use("*", async (c, next) => {
    if (!await hasValidBearer(c.req.raw, c.env.CONNECTOR_PROVISIONER_BEARER_TOKEN)) {
      return c.json({ error: { code: "unauthorized" } }, 401);
    }
    if (!hasBaseConfiguration(c.env)) {
      return c.json({ error: { code: "service_configuration_invalid" } }, 503);
    }
    await next();
  });

  const requireMintConfiguration: MiddlewareHandler<ConnectorRouteEnv> = async (c, next) => {
    if (!hasMintConfiguration(c.env)) {
      return c.json({ error: { code: "service_configuration_invalid" } }, 503);
    }
    await next();
  };
  routes.use("/mint", requireMintConfiguration);
  routes.use("/live-test", requireMintConfiguration);

  routes.openapi(mintConnectorRoute, async (c) => {
    const request = c.req.valid("json");
    const mintResult = await mintConnector(request, {
      dashboardClient: dependencies.createDashboardClient(c.env),
      spritesClient: dependencies.createSpritesClient(c.env),
    });
    if (!mintResult.ok) {
      logMintFailure("mint", mintResult.error);
      return c.json({ error: mintResult.error }, 502);
    }

    logMintSuccess("mint", mintResult.value);
    return c.json({
      connector: {
        name: mintResult.value.name,
        gatewayConnectionId: mintResult.value.gatewayConnectionId,
        ...(mintResult.value.detailId === undefined
          ? {}
          : { detailId: mintResult.value.detailId }),
      },
      policy: mintResult.value.accessPolicy,
      durations: mintResult.value.durations,
    }, 201);
  });

  routes.openapi(liveTestConnectorRoute, async (c) => {
    const request = c.req.valid("json");
    const spritesClient = dependencies.createSpritesClient(c.env);
    const mintResult = await mintConnector(request, {
      dashboardClient: dependencies.createDashboardClient(c.env),
      spritesClient,
    });
    if (!mintResult.ok) {
      logMintFailure("live-test", mintResult.error);
      return c.json({ error: mintResult.error }, 502);
    }
    logMintSuccess("live-test", mintResult.value);

    const cleanupStartedAt = performance.now();
    const deleteResult = await deleteConnectorAndVerify(
      mintResult.value.gatewayConnectionId,
      spritesClient,
    );
    const cleanupMs = performance.now() - cleanupStartedAt;
    if (!deleteResult.ok) {
      return c.json({
        error: {
          code: deleteResult.error,
          stage: "cleanup",
          message: "The disposable connector could not be removed.",
          cleanup: {
            attempted: true,
            succeeded: false,
          },
          durations: {
            ...mintResult.value.durations,
            cleanupMs,
          },
        },
      }, 502);
    }

    return c.json({
      connector: {
        name: mintResult.value.name,
        gatewayConnectionId: mintResult.value.gatewayConnectionId,
        ...(mintResult.value.detailId === undefined
          ? {}
          : { detailId: mintResult.value.detailId }),
        deleted: true as const,
      },
      policy: mintResult.value.accessPolicy,
      durations: {
        ...mintResult.value.durations,
        cleanupMs,
      },
    }, 200);
  });

  routes.openapi(deleteConnectorRoute, async (c) => {
    const { gatewayConnectionId } = c.req.valid("param");
    const spritesClient = dependencies.createSpritesClient(c.env);
    const existing = await spritesClient.getConnection(gatewayConnectionId);
    if (!existing.ok) {
      return c.json({ error: { code: existing.error.code } }, 502);
    }
    if (existing.value === null) {
      return c.json({ error: { code: "connector_not_found" } }, 404);
    }
    if (!isDeletableSessionConnector(existing.value)) {
      logger.warn("Connector delete refused", {
        fields: { gatewayConnectionId },
      });
      return c.json({ error: { code: "connector_delete_refused" } }, 403);
    }

    const deleteResult = await deleteConnectorAndVerify(gatewayConnectionId, spritesClient);
    if (!deleteResult.ok) {
      logger.error("Connector delete failed", {
        fields: { gatewayConnectionId, code: deleteResult.error },
      });
      return c.json({ error: { code: deleteResult.error } }, 502);
    }

    logger.info("Connector deleted", {
      fields: { gatewayConnectionId },
    });
    return c.json({ connector: { gatewayConnectionId, deleted: true as const } }, 200);
  });

  return routes;
}

type MintOutcome = Awaited<ReturnType<typeof mintConnector>>;

function logMintFailure(mode: string, error: Extract<MintOutcome, { ok: false }>["error"]): void {
  logger.warn("Connector mint failed", {
    fields: {
      mode,
      code: error.code,
      stage: error.stage,
      retryable: error.retryable,
      ...(error.dashboardOperation === undefined
        ? {}
        : { dashboardOperation: error.dashboardOperation }),
      durations: durationFields(error.durations),
    },
  });
}

function logMintSuccess(mode: string, value: Extract<MintOutcome, { ok: true }>["value"]): void {
  logger.info("Connector minted", {
    fields: {
      mode,
      name: value.name,
      gatewayConnectionId: value.gatewayConnectionId,
      durations: durationFields(value.durations),
    },
  });
}

function isDeletableSessionConnector(connection: SpritesConnection): boolean {
  const labels = connection.accessPolicy?.spriteLabels ?? [];
  return connection.provider === "custom_api"
    && connection.accessPolicy?.allowAll === false
    && labels.length > 0
    && labels.every((label) => label.startsWith("session:"));
}
