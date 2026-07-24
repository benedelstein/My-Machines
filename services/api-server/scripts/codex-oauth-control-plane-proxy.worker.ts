import { Hono } from "hono";
import { OpenAICodexAuthService } from "@/modules/ai-auth/services/openai-codex-auth.service";
import { NativeAccessTokenService } from "@/modules/auth/services/native-access-token.service";
import { createLogger, initializeLogger } from "@/shared/logging";
import type { Env } from "@/shared/types";

const OPENAI_AUTH_CLAIM_KEY = "https://api.openai.com/auth";
const CODEX_API_BASE = "https://chatgpt.com/backend-api/codex";
const ALLOWED_PATHS = new Set(["/models", "/responses"]);
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
const PROXY_HEADERS = [
  "cdn-loop",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-real-ip",
];
const ALLOWED_CLOUDFLARE_COOKIE_NAMES = new Set([
  "__cf_bm",
  "__cflb",
  "__cfruid",
  "__cfseq",
  "__cfwaitingroom",
  "_cfuvid",
  "cf_clearance",
  "cf_ob_info",
  "cf_use_ob",
]);
const chatGptCloudflareCookies = new Map<string, string>();

const app = new Hono<{ Bindings: Env }>();
const logger = createLogger("codex-oauth-control-plane-proxy.worker.ts");

app.use("*", async (context, next) => {
  initializeLogger({ format: "pretty", level: "info" });
  await next();
});

app.get("/health", (context) => {
  return context.json({
    status: "ok",
    service: "codex-oauth-control-plane-proxy-spike",
  });
});

app.all("*", async (context) => {
  const requestUrl = new URL(context.req.url);
  if (!ALLOWED_PATHS.has(requestUrl.pathname)) {
    return context.json({ error: "Endpoint not allowed" }, 404);
  }

  const authorization = context.req.header("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return context.json({ error: "Unauthorized" }, 401);
  }

  const identity = await new NativeAccessTokenService(context.env).verify(
    authorization.slice(7),
  );
  if (!identity) {
    return context.json({ error: "Unauthorized" }, 401);
  }

  const credentialResult = await new OpenAICodexAuthService(
    context.env,
    logger,
  ).refreshCredentialsIfNeeded(identity.userId);
  if (!credentialResult.ok) {
    logger.warn("OpenAI Codex OAuth credential unavailable", {
      fields: { code: credentialResult.error.code },
    });
    return context.json({ error: "Codex authentication unavailable" }, 401);
  }

  const accountId = getChatGptAccountId(credentialResult.value.idToken);
  if (!accountId) {
    logger.warn("OpenAI Codex ID token did not contain a ChatGPT account id");
    return context.json({ error: "Codex account identity unavailable" }, 401);
  }

  const upstreamHeaders = new Headers(context.req.raw.headers);
  for (const header of HOP_BY_HOP_HEADERS) {
    upstreamHeaders.delete(header);
  }
  for (const header of PROXY_HEADERS) {
    upstreamHeaders.delete(header);
  }
  for (const header of [...upstreamHeaders.keys()]) {
    if (header.startsWith("cf-")) {
      upstreamHeaders.delete(header);
    }
  }
  upstreamHeaders.delete("cookie");
  upstreamHeaders.delete("x-api-key");
  const cloudflareCookieHeader = getCloudflareCookieHeader();
  if (cloudflareCookieHeader) {
    upstreamHeaders.set("Cookie", cloudflareCookieHeader);
  }
  upstreamHeaders.set(
    "Authorization",
    `Bearer ${credentialResult.value.accessToken}`,
  );
  upstreamHeaders.set("ChatGPT-Account-Id", accountId);

  const method = context.req.method;
  const upstreamUrl = `${CODEX_API_BASE}${requestUrl.pathname}${requestUrl.search}`;
  const startedAt = Date.now();
  const upstreamResponse = await fetch(upstreamUrl, {
    method,
    headers: upstreamHeaders,
    body:
      method === "GET" || method === "HEAD"
        ? undefined
        : await context.req.arrayBuffer(),
    redirect: "manual",
  });
  rememberCloudflareCookies(upstreamResponse.headers);

  logger.info("Proxied Codex inference request", {
    fields: {
      method,
      path: requestUrl.pathname,
      status: upstreamResponse.status,
      durationMs: Date.now() - startedAt,
    },
  });

  const responseHeaders = new Headers(upstreamResponse.headers);
  for (const header of HOP_BY_HOP_HEADERS) {
    responseHeaders.delete(header);
  }
  responseHeaders.delete("set-cookie");
  responseHeaders.set(
    "x-cloude-spike-credential-expiry",
    credentialResult.value.expiresAt ?? "missing",
  );
  responseHeaders.set(
    "x-cloude-spike-cloudflare-cookies",
    [...chatGptCloudflareCookies.keys()].sort().join(",") || "none",
  );

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
});

function rememberCloudflareCookies(headers: Headers): void {
  const setCookieHeaders =
    (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ??
    [];
  if (setCookieHeaders.length === 0) {
    const setCookie = headers.get("set-cookie");
    if (setCookie) {
      setCookieHeaders.push(setCookie);
    }
  }
  for (const header of setCookieHeaders) {
    const cookie = header.split(";", 1)[0];
    if (!cookie) {
      continue;
    }
    const separatorIndex = cookie.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const name = cookie.slice(0, separatorIndex).trim();
    if (!isAllowedCloudflareCookieName(name)) {
      continue;
    }
    chatGptCloudflareCookies.set(name, cookie.trim());
  }
}

function getCloudflareCookieHeader(): string | null {
  const cookies = [...chatGptCloudflareCookies.values()];
  return cookies.length > 0 ? cookies.join("; ") : null;
}

function isAllowedCloudflareCookieName(name: string): boolean {
  return (
    ALLOWED_CLOUDFLARE_COOKIE_NAMES.has(name) || name.startsWith("cf_chl_")
  );
}

function getChatGptAccountId(idToken: string): string | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    const encodedPayload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(encodedPayload)) as Record<string, unknown>;
    const authClaim = payload[OPENAI_AUTH_CLAIM_KEY];
    if (typeof authClaim !== "object" || authClaim === null) {
      return null;
    }
    const accountId = (authClaim as Record<string, unknown>).chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0
      ? accountId
      : null;
  } catch {
    return null;
  }
}

export default app;
