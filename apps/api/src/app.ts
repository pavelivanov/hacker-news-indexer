import { createHash, randomUUID } from "node:crypto";

import {
  createStartIngestion,
  type StartIngestion,
} from "@hn-knowledge/application";
import { createLogger, getConfig } from "@hn-knowledge/config";
import {
  checkDatabaseReadiness,
  createIngestionRunRepository,
  getDatabase,
} from "@hn-knowledge/db";
import { Hono } from "hono";

import { createBearerAuth } from "./middleware/bearer-auth.js";
import { registerHealthRoutes, type HealthBindings } from "./routes/health.js";
import { registerIngestionRoutes } from "./routes/ingestion.js";

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
  readonly apiToken?: string;
  readonly maxIngestionRange?: number;
  readonly startIngestion?: StartIngestion;
}

export const createApp = (options: AppOptions = {}): Hono<HealthBindings> => {
  const config = getConfig();
  const logger =
    options.logger ?? createLogger(config, { component: "http", role: "api" });
  const checkReadiness =
    options.checkReadiness ??
    (() => checkDatabaseReadiness(config.DATABASE_READY_TIMEOUT_MS));
  const app = new Hono<HealthBindings>();
  const startIngestion =
    options.startIngestion ??
    createStartIngestion(createIngestionRunRepository(getDatabase().client), {
      sha256: (value) => createHash("sha256").update(value).digest("hex"),
    });

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
  app.use("/v1/*", createBearerAuth(options.apiToken ?? config.APP_API_TOKEN));
  registerIngestionRoutes(app, {
    maxRange: options.maxIngestionRange ?? config.INGESTION_MAX_RANGE,
    startIngestion,
  });

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
