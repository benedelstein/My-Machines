import type { MiddlewareHandler } from "hono";
import { createLogger, type LogFields } from "@repo/shared";

const logger = createLogger("request-logger.middleware.ts");

function logRequestLine(fields: LogFields, status: number, path: string): void {
  if (status >= 500) {
    logger.error("Request completed", { fields });
    return;
  }

  if (status >= 400) {
    logger.warn("Request completed", { fields });
    return;
  }

  // Health checks poll continuously and would drown out real traffic.
  if (path !== "/health") {
    logger.info("Request completed", { fields });
  }
}

export const requestLoggerMiddleware: MiddlewareHandler = async (c, next) => {
  const startedAt = performance.now();
  const method = c.req.method;
  const path = c.req.path;
  const buildFields = (status: number): LogFields => ({
    method,
    path,
    status,
    durationMs: Math.round(performance.now() - startedAt),
  });

  try {
    await next();
  } catch (error) {
    logRequestLine(buildFields(500), 500, path);
    throw error;
  }

  logRequestLine(buildFields(c.res.status), c.res.status, path);
};
