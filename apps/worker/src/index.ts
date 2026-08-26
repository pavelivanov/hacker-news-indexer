import { createHash, randomUUID } from "node:crypto";

import {
  createMtcuteTelegramSource,
  HackerNewsApiItems,
} from "@hn-knowledge/adapters";
import {
  createReviewService,
  HnParentChainResolver,
} from "@hn-knowledge/application";
import {
  createLogger,
  getConfig,
  pipelineMetrics,
  redactConfig,
} from "@hn-knowledge/config";
import {
  createDatabase,
  createClassificationRepository,
  createFindThatProjectExportRepository,
  createHnResolutionRepository,
  createHnReconciliationRepository,
  createIngestionRunRepository,
  createJobQueue,
  createOccurrenceRepository,
  createReviewRepository,
} from "@hn-knowledge/db";
import type { IngestionRange, PipelineJob } from "@hn-knowledge/domain";
import type { SelectionSource } from "@hn-knowledge/ports";

import { jobError, WorkerJobError } from "./jobs/errors.js";
import { createClassifyJobHandler } from "./jobs/classify.js";
import { createIngestJobHandler } from "./jobs/ingest.js";
import { createResolveJobHandler } from "./jobs/resolve.js";
import { createReconcileHnJobHandler } from "./jobs/reconcile.js";

const config = getConfig();
const logger = createLogger(config, { component: "worker", role: "worker" });
const hasher = {
  sha256: (value: string): string =>
    createHash("sha256").update(value).digest("hex"),
};
const clock = { now: (): Date => new Date() };
const database = createDatabase({ connectionString: config.DATABASE_URL });
const runs = createIngestionRunRepository(database.client);
const occurrences = createOccurrenceRepository(database.client);
const resolutions = createHnResolutionRepository(database.client);
const reconciliations = createHnReconciliationRepository(database.client);
const classifications = createClassificationRepository(database.client);
const reviews = createReviewService(
  createReviewRepository(database.client),
  hasher,
);
const queue = createJobQueue(database.client);
const exportOutbox = createFindThatProjectExportRepository(database.client);
const hnItems = new HackerNewsApiItems({
  clock,
  hasher,
  timeoutMs: config.HN_REQUEST_TIMEOUT_MS,
});
const resolvers = new Map<string, HnParentChainResolver>();

const telegram = (() => {
  if (!config.TELEGRAM_ENABLED) {
    return null;
  }
  if (
    config.TELEGRAM_API_ID === undefined ||
    config.TELEGRAM_API_HASH === undefined
  ) {
    throw new Error("Enabled Telegram configuration is incomplete");
  }
  return createMtcuteTelegramSource({
    apiId: config.TELEGRAM_API_ID,
    apiHash: config.TELEGRAM_API_HASH,
    sessionPath: config.TELEGRAM_SESSION_PATH,
    hasher,
    requestTimeoutMs: config.TELEGRAM_REQUEST_TIMEOUT_MS,
    maxFloodWaitMs: config.TELEGRAM_MAX_FLOOD_WAIT_MS,
  });
})();

const sourceFor = (range: IngestionRange): Promise<SelectionSource> => {
  if (range.source !== "TELEGRAM") {
    throw new WorkerJobError("FIXTURE_SOURCE_REQUIRES_REPLAY_COMMAND", false);
  }
  if (telegram === null) {
    throw new WorkerJobError("TELEGRAM_SOURCE_DISABLED", false);
  }
  if (range.sourceKey !== config.TELEGRAM_SOURCE_KEY) {
    throw new WorkerJobError("TELEGRAM_SOURCE_KEY_NOT_ALLOWED", false);
  }
  return Promise.resolve(telegram.source);
};

const ingest = createIngestJobHandler(sourceFor, runs, occurrences, queue);
const resolve = createResolveJobHandler(
  (runId) => {
    let resolver = resolvers.get(runId);
    if (resolver === undefined) {
      resolver = new HnParentChainResolver(hnItems, undefined, undefined, {
        cacheHit: () => pipelineMetrics.increment("hn_cache_hit_total"),
        resolved: ({ depth, displayedRootMismatch }) => {
          pipelineMetrics.observe("hn_resolution_depth", depth);
          if (displayedRootMismatch) {
            pipelineMetrics.increment("displayed_root_mismatch_total");
          }
        },
      });
      resolvers.set(runId, resolver);
    }
    return resolver;
  },
  occurrences,
  resolutions,
  clock,
  hasher,
  queue,
  pipelineMetrics,
);
const classify = createClassifyJobHandler(
  null,
  classifications,
  hasher,
  reviews,
  config.WORKER_MAX_ATTEMPTS,
  pipelineMetrics,
);
const reconcileHn = createReconcileHnJobHandler(
  hnItems,
  reconciliations,
  hasher,
  exportOutbox,
);

const workerId = `worker-${randomUUID()}`;
let stopping = false;
let stopSignal: NodeJS.Signals | null = null;
let resolveStop: (() => void) | undefined;
const stopped = new Promise<void>((resolveStopped) => {
  resolveStop = resolveStopped;
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopping = true;
    stopSignal = signal;
    resolveStop?.();
  });
}

const sleep = async (milliseconds: number): Promise<void> =>
  new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  });

const processJob = async (job: PipelineJob): Promise<void> => {
  const startedAt = Date.now();
  const heartbeat = setInterval(
    () => {
      void queue
        .renew(job.id, workerId, config.WORKER_LEASE_DURATION_MS)
        .catch((error: unknown) => {
          logger.warn(
            {
              errorName: error instanceof Error ? error.name : "UnknownError",
              event: "pipeline_job_lease_renewal_failed",
              jobId: job.id,
            },
            "Pipeline job lease renewal failed",
          );
        });
    },
    Math.max(1_000, Math.floor(config.WORKER_LEASE_DURATION_MS / 3)),
  );
  heartbeat.unref();
  let finalState: "COMPLETED" | "RETRYABLE" | "TERMINAL" = "COMPLETED";
  let errorCode: string | null = null;
  try {
    if (job.type === "INGEST_SELECTION_RANGE") {
      const result = await ingest(job);
      pipelineMetrics.increment(
        "ingestion_messages_total",
        result.occurrenceCount,
      );
      const minId = job.payload["minId"];
      const maxId = job.payload["maxId"];
      if (typeof minId === "number" && typeof maxId === "number") {
        const gaps = Math.max(0, maxId - minId + 1 - result.occurrenceCount);
        if (gaps > 0) {
          pipelineMetrics.increment("ingestion_gap_total", gaps);
        }
      }
    } else if (job.type === "RESOLVE_HN_COMMENT") {
      await resolve(job);
    } else if (job.type === "CLASSIFY_COMMENT") {
      await classify(job);
    } else {
      await reconcileHn(job);
    }
    await queue.complete(job.id, workerId);
  } catch (error) {
    const failure = jobError(error);
    errorCode = failure.code;
    pipelineMetrics.increment("pipeline_failure_total");
    if (failure.retryable && job.attempts < config.WORKER_MAX_ATTEMPTS) {
      finalState = "RETRYABLE";
      const retryAfterMs =
        failure.retryAfterMs ??
        Math.min(
          config.WORKER_RETRY_BASE_MS * 2 ** Math.max(0, job.attempts - 1),
          3_600_000,
        );
      await queue.retry(
        job.id,
        workerId,
        failure.code,
        new Date(Date.now() + retryAfterMs),
      );
    } else {
      finalState = "TERMINAL";
      await queue.terminal(job.id, workerId, failure.code);
    }
  } finally {
    clearInterval(heartbeat);
    if (job.ingestionRunId !== null) {
      const run = await runs.reconcile(job.ingestionRunId);
      if (run.status === "COMPLETED" || run.status === "PARTIAL") {
        resolvers.delete(job.ingestionRunId);
      }
    }
    logger.info(
      {
        attempts: job.attempts,
        durationMs: Date.now() - startedAt,
        errorCode,
        event: "pipeline_job_finished",
        jobId: job.id,
        jobType: job.type,
        runId: job.ingestionRunId,
        state: finalState,
      },
      "Pipeline job finished",
    );
  }
};

logger.info(
  {
    config: redactConfig(config),
    event: "worker_started",
    workerId,
  },
  "Worker started",
);

const active = new Set<Promise<void>>();
const workerHeartbeat = setInterval(() => {
  logger.info(
    {
      activeJobs: active.size,
      event: "worker_heartbeat",
      workerId,
    },
    "Worker heartbeat",
  );
}, config.WORKER_HEARTBEAT_INTERVAL_MS);
workerHeartbeat.unref();
const shouldStop = (): boolean => stopping;
while (!shouldStop()) {
  let claimed = false;
  while (!shouldStop() && active.size < config.WORKER_CONCURRENCY) {
    let job: PipelineJob | null;
    try {
      job = await queue.claim({
        leaseOwner: workerId,
        leaseDurationMs: config.WORKER_LEASE_DURATION_MS,
      });
    } catch (error) {
      logger.warn(
        {
          errorName: error instanceof Error ? error.name : "UnknownError",
          event: "pipeline_job_claim_deferred",
        },
        "Pipeline job claim deferred",
      );
      await Promise.race([sleep(config.WORKER_POLL_INTERVAL_MS), stopped]);
      break;
    }
    if (job === null) {
      break;
    }
    claimed = true;
    const task = processJob(job)
      .catch((error: unknown) => {
        logger.error(
          {
            errorName: error instanceof Error ? error.name : "UnknownError",
            event: "pipeline_job_transition_failed",
            jobId: job.id,
          },
          "Pipeline job transition failed",
        );
      })
      .finally(() => active.delete(task));
    active.add(task);
  }

  if (active.size === 0) {
    await Promise.race([sleep(config.WORKER_POLL_INTERVAL_MS), stopped]);
  } else if (!claimed || active.size >= config.WORKER_CONCURRENCY) {
    await Promise.race([...active, stopped]);
  }
}

clearInterval(workerHeartbeat);
await Promise.allSettled(active);
await telegram?.close();
await database.close();
logger.info({ event: "worker_stopped", signal: stopSignal }, "Worker stopped");
