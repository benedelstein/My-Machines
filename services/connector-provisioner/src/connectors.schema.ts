import { createRoute, z } from "@hono/zod-openapi";
import {
  ConnectorProvisionerErrorResponseSchema,
  DeleteConnectorResponseSchema,
  LiveTestConnectorResponseSchema,
  LiveTestRequestSchema,
  MintConnectorRequestSchema,
  MintConnectorResponseSchema,
} from "./types";

const errorContent = {
  content: { "application/json": { schema: ConnectorProvisionerErrorResponseSchema } },
};

export const mintConnectorRoute = createRoute({
  method: "post",
  path: "/mint",
  request: {
    body: {
      content: { "application/json": { schema: MintConnectorRequestSchema } },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: MintConnectorResponseSchema } },
      description: "Connector minted and scoped to the requested sprite labels",
    },
    400: { ...errorContent, description: "Invalid request body" },
    401: { ...errorContent, description: "Missing or invalid bearer token" },
    502: { ...errorContent, description: "Provisioning failed" },
    503: { ...errorContent, description: "Service configuration invalid" },
  },
});

export const liveTestConnectorRoute = createRoute({
  method: "post",
  path: "/live-test",
  request: {
    body: {
      content: { "application/json": { schema: LiveTestRequestSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: LiveTestConnectorResponseSchema } },
      description: "Disposable connector minted, verified, and deleted",
    },
    400: { ...errorContent, description: "Invalid request body" },
    401: { ...errorContent, description: "Missing or invalid bearer token" },
    502: { ...errorContent, description: "Provisioning or cleanup failed" },
    503: { ...errorContent, description: "Service configuration invalid" },
  },
});

export const deleteConnectorRoute = createRoute({
  method: "delete",
  path: "/{gatewayConnectionId}",
  request: {
    params: z.object({ gatewayConnectionId: z.string().min(1) }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: DeleteConnectorResponseSchema } },
      description: "Connector deleted",
    },
    401: { ...errorContent, description: "Missing or invalid bearer token" },
    403: { ...errorContent, description: "Connector is not a deletable session connector" },
    404: { ...errorContent, description: "Connector not found" },
    502: { ...errorContent, description: "Delete failed" },
    503: { ...errorContent, description: "Service configuration invalid" },
  },
});
