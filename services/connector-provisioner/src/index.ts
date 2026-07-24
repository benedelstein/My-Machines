import type { BrowserWorker } from "@cloudflare/playwright";
import { deleteConnectorAndVerify, mintConnector } from "./mint-connector";
import { PlaywrightDashboardClient } from "./playwright-dashboard.client";
import { HttpSpritesConnectionsClient } from "./sprites-connections.client";
import { LiveTestRequestSchema } from "./types";

export interface Env {
  BROWSER: BrowserWorker;
  CONNECTOR_PROVISIONER_BEARER_TOKEN: string;
  SPRITES_API_KEY: string;
  SPRITES_API_URL: string;
  SPRITES_DASHBOARD_STORAGE_STATE: string;
  SPRITES_DASHBOARD_URL: string;
  SPRITES_ORG_SLUG: string;
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return jsonResponse({ status: "ok" });
  }
  const isMint = request.method === "POST" && url.pathname === "/v1/connectors/mint";
  const isLiveTest = request.method === "POST" && url.pathname === "/v1/connectors/live-test";
  const deleteConnectionId = getDeleteConnectionId(request.method, url.pathname);
  if (!isMint && !isLiveTest && deleteConnectionId === undefined) {
    return jsonResponse({ error: { code: "not_found" } }, 404);
  }

  if (!hasBaseConfiguration(env)) {
    return jsonResponse({ error: { code: "service_configuration_invalid" } }, 503);
  }
  if (!await hasValidBearer(request, env.CONNECTOR_PROVISIONER_BEARER_TOKEN)) {
    return jsonResponse({ error: { code: "unauthorized" } }, 401);
  }

  const sprites = new HttpSpritesConnectionsClient({
    apiUrl: env.SPRITES_API_URL,
    apiToken: env.SPRITES_API_KEY,
  });
  if (deleteConnectionId !== undefined) {
    const deleteResult = await deleteConnectorAndVerify(deleteConnectionId, sprites);
    if (!deleteResult.ok) {
      return jsonResponse({ error: { code: deleteResult.error } }, 502);
    }
    return jsonResponse({ connector: { gatewayConnectionId: deleteConnectionId, deleted: true } });
  }
  if (!hasMintConfiguration(env)) {
    return jsonResponse({ error: { code: "service_configuration_invalid" } }, 503);
  }

  const requestBody = await readJson(request);
  const parsedRequest = LiveTestRequestSchema.safeParse(requestBody);
  if (!parsedRequest.success) {
    return jsonResponse({ error: { code: "invalid_request" } }, 400);
  }

  const dashboard = new PlaywrightDashboardClient({
    browser: env.BROWSER,
    dashboardUrl: env.SPRITES_DASHBOARD_URL,
    orgSlug: env.SPRITES_ORG_SLUG,
    storageState: env.SPRITES_DASHBOARD_STORAGE_STATE,
  });

  const mintResult = await mintConnector(
    parsedRequest.data,
    { dashboard, sprites },
  );
  if (!mintResult.ok) {
    return jsonResponse({ error: mintResult.error }, 502);
  }
  if (isMint) {
    return jsonResponse({
      connector: {
        gatewayConnectionId: mintResult.value.gatewayConnectionId,
        ...(mintResult.value.detailId === undefined
          ? {}
          : { detailId: mintResult.value.detailId }),
      },
      policy: mintResult.value.accessPolicy,
      durations: mintResult.value.durations,
    }, 201);
  }

  const cleanupStartedAt = performance.now();
  const deleteResult = await deleteConnectorAndVerify(
    mintResult.value.gatewayConnectionId,
    sprites,
  );
  const cleanupMs = performance.now() - cleanupStartedAt;
  if (!deleteResult.ok) {
    return jsonResponse({
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

  return jsonResponse({
    connector: {
      gatewayConnectionId: mintResult.value.gatewayConnectionId,
      ...(mintResult.value.detailId === undefined
        ? {}
        : { detailId: mintResult.value.detailId }),
      deleted: true,
    },
    policy: mintResult.value.accessPolicy,
    durations: {
      ...mintResult.value.durations,
      cleanupMs,
    },
  });
}

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>;

function hasBaseConfiguration(env: Env): boolean {
  return [
    env.CONNECTOR_PROVISIONER_BEARER_TOKEN,
    env.SPRITES_API_KEY,
    env.SPRITES_API_URL,
  ].every((value) => typeof value === "string" && value.length > 0);
}

function hasMintConfiguration(env: Env): boolean {
  return [
    env.SPRITES_DASHBOARD_STORAGE_STATE,
    env.SPRITES_DASHBOARD_URL,
    env.SPRITES_ORG_SLUG,
  ].every((value) => typeof value === "string" && value.length > 0)
    && typeof env.BROWSER?.fetch === "function";
}

async function hasValidBearer(request: Request, expectedToken: string): Promise<boolean> {
  const authorization = request.headers.get("Authorization");
  if (authorization === null || !authorization.startsWith("Bearer ")) {
    return false;
  }

  const providedToken = authorization.slice("Bearer ".length);
  const [providedDigest, expectedDigest] = await Promise.all([
    digest(providedToken),
    digest(expectedToken),
  ]);

  let difference = 0;
  for (let index = 0; index < providedDigest.length; index += 1) {
    difference |= (providedDigest[index] ?? 0) ^ (expectedDigest[index] ?? 0);
  }
  return difference === 0;
}

async function digest(value: string): Promise<Uint8Array> {
  const encoded = new TextEncoder().encode(value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
}

function getDeleteConnectionId(method: string, pathname: string): string | undefined {
  if (method !== "DELETE") {
    return undefined;
  }

  const match = /^\/v1\/connectors\/([^/]+)$/u.exec(pathname);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}
