import { createHash, randomUUID } from "node:crypto";

import {
  createFindThatProjectExportService,
  createReviewService,
  createKnowledgeReader,
  type KnowledgeReader,
  type FindThatProjectExportService,
  createStartIngestion,
  type ReviewService,
  type StartIngestion,
} from "@hn-knowledge/application";
import {
  createLogger,
  getConfig,
  pipelineMetrics,
  type PipelineMetrics,
} from "@hn-knowledge/config";
import {
  checkDatabaseReadiness,
  createIngestionRunRepository,
  createFindThatProjectExportRepository,
  createReviewRepository,
  createKnowledgeReaderRepository,
  getDatabase,
} from "@hn-knowledge/db";
import { Hono } from "hono";

import { createBearerAuth } from "./middleware/bearer-auth.js";
import { registerHealthRoutes, type HealthBindings } from "./routes/health.js";
import { registerIngestionRoutes } from "./routes/ingestion.js";
import { registerReviewRoutes } from "./routes/review.js";
import { registerReaderRoutes } from "./routes/reader.js";
import {
  registerMetricsRoute,
  type ReviewQueueMeasurement,
} from "./routes/metrics.js";
import {
  registerFindThatProjectConsumerRoutes,
  registerFindThatProjectReviewRoutes,
} from "./routes/findthatproject-export.js";

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
  readonly reviewService?: ReviewService;
  readonly reviewActorId?: string;
  readonly knowledgeReader?: KnowledgeReader;
  readonly findThatProjectExportService?: FindThatProjectExportService;
  readonly exportConsumerToken?: string;
  readonly metrics?: PipelineMetrics;
  readonly measureReviewQueue?: () => Promise<ReviewQueueMeasurement>;
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
  const reviewService =
    options.reviewService ??
    createReviewService(createReviewRepository(getDatabase().client), {
      sha256: (value) => createHash("sha256").update(value).digest("hex"),
    });
  const apiToken = options.apiToken ?? config.APP_API_TOKEN;
  const metrics = options.metrics ?? pipelineMetrics;
  const knowledgeReader =
    options.knowledgeReader ??
    createKnowledgeReader(
      createKnowledgeReaderRepository(getDatabase().client),
      {
        cursorSecret: apiToken ?? "reader-cursor-disabled",
      },
    );
  const exportConsumerToken =
    options.exportConsumerToken ?? config.EXPORT_CONSUMER_TOKEN;
  const findThatProjectExportService =
    options.findThatProjectExportService ??
    createFindThatProjectExportService(
      createFindThatProjectExportRepository(getDatabase().client),
      { sha256: (value) => createHash("sha256").update(value).digest("hex") },
      {
        cursorSecret: exportConsumerToken ?? "export-consumer-disabled",
      },
    );

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
  registerMetricsRoute(app, {
    apiToken,
    metrics,
    measureReviewQueue:
      options.measureReviewQueue ??
      (async () => {
        const queue = await getDatabase().client.reviewTask.aggregate({
          where: { state: "OPEN" },
          _count: { id: true },
          _min: { createdAt: true },
        });
        return {
          depth: queue._count.id,
          oldestAgeSeconds:
            queue._min.createdAt === null
              ? 0
              : Math.max(
                  0,
                  (Date.now() - queue._min.createdAt.getTime()) / 1_000,
                ),
        };
      }),
  });
  registerFindThatProjectConsumerRoutes(app, {
    service: findThatProjectExportService,
    consumerToken: exportConsumerToken,
    metrics,
  });
  app.use("/v1/*", createBearerAuth(apiToken));
  registerIngestionRoutes(app, {
    maxRange: options.maxIngestionRange ?? config.INGESTION_MAX_RANGE,
    startIngestion,
  });
  registerReviewRoutes(app, {
    service: reviewService,
    actorId: options.reviewActorId ?? config.APP_REVIEW_ACTOR_ID,
  });
  registerReaderRoutes(app, { reader: knowledgeReader, metrics });
  registerFindThatProjectReviewRoutes(app, {
    service: findThatProjectExportService,
    actorId: options.reviewActorId ?? config.APP_REVIEW_ACTOR_ID,
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
