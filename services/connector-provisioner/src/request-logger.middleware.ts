import type { MiddlewareHandler } from "hono";
import type { LogFields, Logger } from "@repo/shared";

export function createRequestLoggerMiddleware(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const startedAt = performance.now();
    await next();
    const fields: LogFields = {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Math.round(performance.now() - startedAt),
    };
    if (c.res.status >= 500) {
      logger.error("Request completed", { fields });
    } else if (c.res.status >= 400) {
      logger.warn("Request completed", { fields });
    } else if (c.req.path !== "/health") {
      logger.info("Request completed", { fields });
    }
  };
}
