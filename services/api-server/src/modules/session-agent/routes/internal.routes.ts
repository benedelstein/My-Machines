import { Hono } from "hono";
import { AgentChunksWebhookBody, AgentEventsWebhookBody } from "@repo/shared";
import type { UIMessageChunk } from "ai";
import type { Env } from "@/shared/types";
import { createLogger } from "@/shared/logging";
import {
  getSessionAgentStub,
  type SessionAgentStub,
} from "./session-agent-stub";

/**
 * Internal webhook routes called by the vm-agent process running on the
 * sprite. Each route authenticates with a per-session bearer token, then
 * forwards into the owning DO.
 *
 * Traffic shape:
 *   POST /internal/session/:sessionId/chunks
 *     Body: { userMessageId: string, chunks: [{ sequence, chunk }, ...] }
 *   POST /internal/session/:sessionId/events
 *     Body: { event: AgentEvent }
 *   POST /internal/session/:sessionId/capabilities/git
 *     Response: { token: string, expiresAt: number }
 */
export function createInternalRoutes(): Hono<{ Bindings: Env }> {
  const internalRoutes = new Hono<{ Bindings: Env }>();
  const logger = createLogger("internal.routes.ts");

  function parseBearerToken(auth: string | undefined): string | null {
    if (!auth) {
      return null;
    }
    const match = auth.match(/^Bearer\s+(.+)$/i);
    return match ? match[1]!.trim() : null;
  }

  async function getWebhookTarget(
    env: Env,
    sessionId: string,
    auth: string | undefined,
  ): Promise<
    | { ok: true; token: string; stub: SessionAgentStub }
    | { ok: false; status: 401; message: string }
  > {
    const token = parseBearerToken(auth);
    if (!token) {
      return { ok: false, status: 401, message: "Missing bearer token" };
    }
    const stub = await getSessionAgentStub(env, sessionId);
    return { ok: true, token, stub };
  }

  internalRoutes.post("/session/:sessionId/chunks", async (c) => {
    const sessionId = c.req.param("sessionId");
    const target = await getWebhookTarget(
      c.env,
      sessionId,
      c.req.header("authorization"),
    );
    if (!target.ok) {
      logger.warn("[/chunks] auth failed", {
        fields: {
          sessionId,
          status: target.status,
          reason: target.message,
        },
      });
      return c.json({ error: target.message }, target.status);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch (error) {
      logger.warn("Invalid JSON in /chunks webhook", {
        error,
        fields: { sessionId },
      });
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const parsed = AgentChunksWebhookBody.safeParse(body);
    if (!parsed.success) {
      logger.warn("[/chunks] invalid body", {
        fields: {
          sessionId,
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
      });
      return c.json(
        {
          error: "Invalid body",
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
        400,
      );
    }

    const chunks = parsed.data.chunks.map((item) => ({
      sequence: item.sequence,
      chunk: item.chunk as UIMessageChunk,
    }));
    const accepted = await target.stub.handleWebhookChunks(
      target.token,
      parsed.data.userMessageId,
      chunks,
    );
    if (!accepted) {
      logger.warn("[/chunks] auth failed", {
        fields: {
          sessionId,
          status: 403,
          reason: "Invalid webhook token",
        },
      });
      return c.json({ error: "Invalid webhook token" }, 403);
    }
    return new Response(null, { status: 204 });
  });

  internalRoutes.post("/session/:sessionId/events", async (c) => {
    const sessionId = c.req.param("sessionId");
    const target = await getWebhookTarget(
      c.env,
      sessionId,
      c.req.header("authorization"),
    );
    if (!target.ok) {
      logger.warn("[/events] auth failed", {
        fields: {
          sessionId,
          status: target.status,
          reason: target.message,
        },
      });
      return c.json({ error: target.message }, target.status);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch (error) {
      logger.warn("Invalid JSON in /events webhook", {
        error,
        fields: { sessionId },
      });
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const parsed = AgentEventsWebhookBody.safeParse(body);
    if (!parsed.success) {
      logger.warn("[/events] invalid body", {
        fields: {
          sessionId,
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
      });
      return c.json(
        {
          error: "Invalid body",
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
        400,
      );
    }

    const accepted = await target.stub.handleWebhookEvent(
      target.token,
      parsed.data.event,
    );
    if (!accepted) {
      logger.warn("[/events] auth failed", {
        fields: {
          sessionId,
          status: 403,
          reason: "Invalid webhook token",
        },
      });
      return c.json({ error: "Invalid webhook token" }, 403);
    }
    return new Response(null, { status: 204 });
  });

  internalRoutes.post("/session/:sessionId/capabilities/git", async (c) => {
    const sessionId = c.req.param("sessionId");
    const target = await getWebhookTarget(
      c.env,
      sessionId,
      c.req.header("authorization"),
    );
    if (!target.ok) {
      return c.json({ error: target.message }, target.status);
    }
    const capability = await target.stub.mintGitCapability(target.token);
    if (!capability) {
      logger.warn("[/capabilities/git] auth failed", {
        fields: { sessionId },
      });
      return c.json({ error: "Invalid connector credential" }, 403);
    }
    return c.json(capability, 200);
  });

  return internalRoutes;
}
