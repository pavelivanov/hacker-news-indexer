import { randomUUID } from "node:crypto";

import { createLogger, getConfig } from "@hn-knowledge/config";
import { checkDatabaseReadiness } from "@hn-knowledge/db";
import { Hono } from "hono";

import { registerHealthRoutes, type HealthBindings } from "./routes/health.js";

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/u;

export interface SafeLogger {
  readonly error: (
    fields: Readonly<Record<string, unknown>>,
    message: string,
  ) => void;
}

export interface AppOptions {
  readonly checkReadiness?: () => Promise<void>;
  readonly logger?: SafeLogger;
}

export const createApp = (options: AppOptions = {}): Hono<HealthBindings> => {
  const config = getConfig();
  const logger =
    options.logger ?? createLogger(config, { component: "http", role: "api" });
  const checkReadiness =
    options.checkReadiness ??
    (() => checkDatabaseReadiness(config.DATABASE_READY_TIMEOUT_MS));
  const app = new Hono<HealthBindings>();

  app.use("*", async (context, next) => {
    const suppliedRequestId = context.req.header("x-request-id");
    const requestId =
      suppliedRequestId !== undefined && SAFE_REQUEST_ID.test(suppliedRequestId)
        ? suppliedRequestId
        : randomUUID();

    context.set("requestId", requestId);
    await next();
    context.header("x-request-id", requestId);
  });

  registerHealthRoutes(app, checkReadiness);

  app.notFound((context) =>
    context.json(
      { error: "not_found" as const, requestId: context.get("requestId") },
      404,
    ),
  );

  app.onError((error, context) => {
    const requestId = context.get("requestId") || randomUUID();
    context.header("x-request-id", requestId);
    logger.error(
      {
        event: "http_request_failed",
        errorName: error.name,
        method: context.req.method,
        path: context.req.path,
        requestId,
      },
      "Request failed",
    );
    return context.json({ error: "internal_error" as const, requestId }, 500);
  });

  return app;
};

export const app = createApp();
