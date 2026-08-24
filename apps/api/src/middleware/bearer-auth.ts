import { createHash, timingSafeEqual } from "node:crypto";

import type { MiddlewareHandler } from "hono";

import type { HealthBindings } from "../routes/health.js";

const tokenDigest = (value: string): Buffer =>
  createHash("sha256").update(value, "utf8").digest();

const bearerToken = (authorization: string | undefined): string => {
  const match = /^Bearer ([^\s]+)$/iu.exec(authorization ?? "");
  return match?.[1] ?? "";
};

export const createBearerAuth = (
  configuredToken: string | undefined,
): MiddlewareHandler<HealthBindings> => {
  const expected = tokenDigest(configuredToken ?? "token-not-configured");
  const enabled = configuredToken !== undefined && configuredToken.length > 0;

  return async (context, next) => {
    const candidate = tokenDigest(
      bearerToken(context.req.header("authorization")),
    );
    const authorized = enabled && timingSafeEqual(expected, candidate);

    if (!authorized) {
      return context.json(
        {
          error: "unauthorized" as const,
          requestId: context.get("requestId"),
        },
        401,
      );
    }

    return next();
  };
};
