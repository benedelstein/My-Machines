import { OpenAPIHono } from "@hono/zod-openapi";
import { initializeLogger, type LogLevel } from "@repo/shared";
import { HttpSpriteConnectorsClient } from "@repo/sprites-client";
import { createConnectorRoutes } from "./connectors.routes";
import type { Env } from "./env";
import { PlaywrightDashboardClient } from "./playwright-dashboard.client";
import { requestLoggerMiddleware } from "./request-logger.middleware";

export type { Env } from "./env";

const app = new OpenAPIHono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  initializeLogger({
    format: c.env.ENVIRONMENT === "production" ? "json" : "pretty",
    level: c.env.LOG_LEVEL as LogLevel,
  });
  await next();
});

app.use("*", requestLoggerMiddleware);
app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("Cache-Control", "no-store");
});

app.get("/health", (c) => c.json({ status: "ok" }));
app.notFound((c) => c.json({ error: { code: "not_found" } }, 404));

app.route("/connectors", createConnectorRoutes({
  createSpritesClient: (env) => new HttpSpriteConnectorsClient({
    apiUrl: env.SPRITES_API_URL,
    apiToken: env.SPRITES_API_KEY,
  }),
  createDashboardClient: (env) => new PlaywrightDashboardClient({
    browser: env.BROWSER,
    dashboardUrl: env.SPRITES_DASHBOARD_URL,
    orgSlug: env.SPRITES_ORG_SLUG,
    storageState: env.SPRITES_DASHBOARD_STORAGE_STATE,
  }),
}));

export { app };

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
