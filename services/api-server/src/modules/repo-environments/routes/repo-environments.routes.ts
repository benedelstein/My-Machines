import { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import type { AuthContext } from "@/shared/types/auth";
import type { Env } from "@/shared/types";
import { getDefaultNetworkAllowlistDomains } from "@repo/sprites-client";
import type { RepoEnvironmentsService } from "../services/repo-environments.service";
import {
  createRepoEnvironmentRoute,
  deleteRepoEnvironmentRoute,
  getDefaultNetworkAllowlistRoute,
  getRepoEnvironmentRoute,
  getUserRepoEnvironmentRoute,
  listRepoEnvironmentsRoute,
  listUserRepoEnvironmentsRoute,
  updateRepoEnvironmentRoute,
} from "./repo-environments.schema";

type RepoEnvironmentsRouteEnv = {
  Bindings: Env;
  Variables: { auth: AuthContext };
};

export interface RepoEnvironmentsRouteDeps {
  authMiddleware: MiddlewareHandler<RepoEnvironmentsRouteEnv>;
  createRepoEnvironmentsService(env: Env): RepoEnvironmentsService;
}

export function createRepoScopedEnvironmentRoutes(
  deps: RepoEnvironmentsRouteDeps,
): OpenAPIHono<RepoEnvironmentsRouteEnv> {
  const routes = new OpenAPIHono<RepoEnvironmentsRouteEnv>();

  routes.use("*", deps.authMiddleware);

  routes.openapi(listRepoEnvironmentsRoute, async (c) => {
    const auth = c.get("auth");
    const { repoId } = c.req.valid("param");
    const result = await deps.createRepoEnvironmentsService(c.env).list({
      userId: auth.userId,
      repoId,
    });
    if (!result.ok) {
      return errorResponse(c, result.error);
    }
    return c.json(result.value, 200);
  });

  routes.openapi(createRepoEnvironmentRoute, async (c) => {
    const auth = c.get("auth");
    const { repoId } = c.req.valid("param");
    const result = await deps.createRepoEnvironmentsService(c.env).create({
      userId: auth.userId,
      repoId,
      request: c.req.valid("json"),
    });
    if (!result.ok) {
      return errorResponse(c, result.error);
    }
    return c.json(result.value, 201);
  });

  routes.openapi(getRepoEnvironmentRoute, async (c) => {
    const auth = c.get("auth");
    const { repoId, environmentId } = c.req.valid("param");
    const result = await deps.createRepoEnvironmentsService(c.env).get({
      id: environmentId,
      userId: auth.userId,
      repoId,
    });
    if (!result.ok) {
      return errorResponse(c, result.error);
    }
    return c.json(result.value, 200);
  });

  routes.openapi(updateRepoEnvironmentRoute, async (c) => {
    const auth = c.get("auth");
    const { repoId, environmentId } = c.req.valid("param");
    const result = await deps.createRepoEnvironmentsService(c.env).update({
      id: environmentId,
      userId: auth.userId,
      repoId,
      request: c.req.valid("json"),
    });
    if (!result.ok) {
      return errorResponse(c, result.error);
    }
    return c.json(result.value, 200);
  });

  routes.openapi(deleteRepoEnvironmentRoute, async (c) => {
    const auth = c.get("auth");
    const { repoId, environmentId } = c.req.valid("param");
    const result = await deps.createRepoEnvironmentsService(c.env).delete({
      id: environmentId,
      userId: auth.userId,
      repoId,
    });
    if (!result.ok) {
      return errorResponse(c, result.error);
    }
    return c.json(result.value, 200);
  });

  return routes;
}

export function createUserEnvironmentRoutes(
  deps: RepoEnvironmentsRouteDeps,
): OpenAPIHono<RepoEnvironmentsRouteEnv> {
  const routes = new OpenAPIHono<RepoEnvironmentsRouteEnv>();

  routes.use("*", deps.authMiddleware);

  routes.openapi(listUserRepoEnvironmentsRoute, async (c) => {
    const auth = c.get("auth");
    const result = await deps.createRepoEnvironmentsService(c.env).listAll({
      userId: auth.userId,
    });
    if (!result.ok) {
      return errorResponse(c, result.error);
    }
    return c.json(result.value, 200);
  });

  routes.openapi(getDefaultNetworkAllowlistRoute, (c) =>
    c.json({ domains: getDefaultNetworkAllowlistDomains() }, 200),
  );

  routes.openapi(getUserRepoEnvironmentRoute, async (c) => {
    const auth = c.get("auth");
    const { environmentId } = c.req.valid("param");
    const result = await deps.createRepoEnvironmentsService(c.env).getOwned({
      id: environmentId,
      userId: auth.userId,
    });
    if (!result.ok) {
      return errorResponse(c, result.error);
    }
    return c.json(result.value, 200);
  });

  return routes;
}

function errorResponse(
  c: Parameters<Parameters<OpenAPIHono<RepoEnvironmentsRouteEnv>["openapi"]>[1]>[0],
  error: {
    status: 400 | 401 | 403 | 404 | 409 | 503;
    message: string;
    code?: string;
  },
) {
  return c.json({
    error: error.message,
    ...(error.code ? { code: error.code } : {}),
  }, error.status);
}
