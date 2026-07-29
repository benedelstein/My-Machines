import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { cors } from "hono/cors";
import type { LogLevel } from "@repo/shared";
import {
  buildAgentRoutes,
  buildAttachmentsRoutes,
  buildAuthRoutes,
  buildIntegrationsRoutes,
  buildGitProxyRoutes,
  buildInternalRoutes,
  buildModelsRoutes,
  buildNotificationsRoutes,
  buildRepoScopedEnvironmentRoutes,
  buildReposRoutes,
  buildSessionsRoutes,
  buildVoiceRoutes,
  buildUserEnvironmentRoutes,
  buildWebhooksRoutes,
} from "@/composition/build-routes";
import { SessionAgentDO } from "@/runtime/session-agent.do";
import { UserSessionsDO } from "@/runtime/user-sessions.do";
import { handleScheduled } from "@/composition/scheduled";
import type { Env } from "@/shared/types";
import { initializeLogger } from "@/shared/logging";
import { createLogger } from "@/shared/logging";
import { FcmTokenRepository } from "@/modules/notifications/repositories/fcm-token.repository";
import { FcmProvider } from "@/modules/notifications/providers/fcm.provider";
import { NotificationQueueConsumer } from "@/modules/notifications/services/notification-queue-consumer.service";
import type { NotificationQueueMessage } from "@/modules/notifications/types/notification.types";
// import { requestLoggerMiddleware } from "@/shared/middleware/request-logger.middleware";

export { SessionAgentDO, UserSessionsDO };

const app = new OpenAPIHono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  initializeLogger({
    format: c.env.ENVIRONMENT === "production" ? "json" : "pretty",
    level: c.env.LOG_LEVEL as LogLevel,
  });
  await next();
});

// app.use("*", requestLoggerMiddleware); // instead of default cf logger

app.use(
  "*",
  cors({
    origin: (origin) => origin, // reflect request origin
    credentials: true,
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);

app.get("/", (c) => {
  return c.json({ name: "my-machines-api", version: "0.0.1", status: "running" });
});
app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

// OpenAPI docs: spec at /doc, Swagger UI at /ui.
app.openAPIRegistry.registerComponent("securitySchemes", "Bearer", {
  type: "http",
  scheme: "bearer",
  description: "User session token",
});
app.doc("/doc", {
  openapi: "3.1.0",
  info: {
    title: "My Machines API",
    version: "0.0.1",
    description: "My Machines API.",
  },
});
app.get("/ui", swaggerUI({ url: "/doc" }));

app.route("/agents", buildAgentRoutes());
// TODO: Consider moving this under /sessions/:sessionId/git-proxy and rolling
// it into the sessions route tree. Keep existing active session remotes in mind.
app.route("/git-proxy", buildGitProxyRoutes());
app.route("/internal", buildInternalRoutes());

app.route("/auth", buildAuthRoutes());
app.route("/models", buildModelsRoutes());

// Protected routes
app.route("/repos", buildReposRoutes());
app.route("/repos", buildRepoScopedEnvironmentRoutes());
app.route("/sessions", buildSessionsRoutes());
app.route("/notifications", buildNotificationsRoutes());
app.route("/voice", buildVoiceRoutes());
app.route("/attachments", buildAttachmentsRoutes());
app.route("/integrations", buildIntegrationsRoutes());
app.route("/environments", buildUserEnvironmentRoutes());

app.route("/webhooks", buildWebhooksRoutes());

export default {
  fetch: app.fetch,
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    handleScheduled(env, ctx);
  },
  async queue(
    batch: MessageBatch<NotificationQueueMessage>,
    env: Env,
  ): Promise<void> {
    initializeLogger({
      format: env.ENVIRONMENT === "production" ? "json" : "pretty",
      level: env.LOG_LEVEL as LogLevel,
    });
    const consumer = new NotificationQueueConsumer({
      logger: createLogger("notifications.queue.ts"),
      tokenRepository: new FcmTokenRepository(env.DB),
      fcmProvider: new FcmProvider(env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64),
    });

    await Promise.all(
      batch.messages.map((message) => consumer.handleMessage(message.body)),
    );
  },
};
