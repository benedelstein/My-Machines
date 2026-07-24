import { Hono } from "hono";
import { ClaudeOAuthService } from "@/modules/ai-auth/services/claude-oauth.service";
import { NativeAccessTokenService } from "@/modules/auth/services/native-access-token.service";
import { createLogger, initializeLogger } from "@/shared/logging";
import type { Env } from "@/shared/types";

const ANTHROPIC_API_BASE = "https://api.anthropic.com";
const ALLOWED_PATHS = new Set([
  "/v1/messages",
  "/v1/messages/count_tokens",
]);
const HOP_BY_HOP_HEADERS = [
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

const app = new Hono<{ Bindings: Env }>();
const logger = createLogger("claude-oauth-control-plane-proxy.worker.ts");

app.use("*", async (context, next) => {
  initializeLogger({ format: "pretty", level: "info" });
  await next();
});

app.get("/health", (context) => {
  return context.json({ status: "ok", service: "claude-oauth-control-plane-proxy-spike" });
});

app.all("*", async (context) => {
  const path = new URL(context.req.url).pathname;
  if (!ALLOWED_PATHS.has(path)) {
    return context.json({ error: "Endpoint not allowed" }, 404);
  }

  const authorization = context.req.header("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return context.json({ error: "Unauthorized" }, 401);
  }

  const identity = await new NativeAccessTokenService(context.env).verify(authorization.slice(7));
  if (!identity) {
    return context.json({ error: "Unauthorized" }, 401);
  }

  const credentialResult = await new ClaudeOAuthService(context.env, logger)
    .refreshCredentialsIfNeeded(identity.userId);
  if (!credentialResult.ok) {
    logger.warn("Claude OAuth credential unavailable", {
      fields: { code: credentialResult.error.code },
    });
    return context.json({ error: "Claude authentication unavailable" }, 401);
  }

  const requestUrl = new URL(context.req.url);
  const upstreamUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, ANTHROPIC_API_BASE);
  const upstreamHeaders = new Headers(context.req.raw.headers);
  for (const header of HOP_BY_HOP_HEADERS) {
    upstreamHeaders.delete(header);
  }
  upstreamHeaders.delete("x-api-key");
  upstreamHeaders.set(
    "Authorization",
    `Bearer ${credentialResult.value.claudeAiOauth.accessToken}`,
  );
  const anthropicBetas = (upstreamHeaders.get("anthropic-beta") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!anthropicBetas.includes("oauth-2025-04-20")) {
    anthropicBetas.push("oauth-2025-04-20");
  }
  upstreamHeaders.set("anthropic-beta", anthropicBetas.join(","));

  const method = context.req.method;
  const startedAt = Date.now();
  const upstreamResponse = await fetch(upstreamUrl, {
    method,
    headers: upstreamHeaders,
    body: method === "GET" || method === "HEAD"
      ? undefined
      : await context.req.arrayBuffer(),
    redirect: "manual",
  });

  logger.info("Proxied Claude inference request", {
    fields: {
      method,
      path,
      status: upstreamResponse.status,
      durationMs: Date.now() - startedAt,
    },
  });

  const responseHeaders = new Headers(upstreamResponse.headers);
  for (const header of HOP_BY_HOP_HEADERS) {
    responseHeaders.delete(header);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
});

export default app;
