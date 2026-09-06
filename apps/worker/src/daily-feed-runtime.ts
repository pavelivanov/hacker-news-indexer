import {
  CLASSIFICATION_PROMPT_VERSION,
  CLASSIFICATION_SCHEMA_VERSION,
  ClassificationExecutionError,
  createClassifyComment,
  captureClassifierResult,
  loadClassifierInput,
  HnParentChainResolver,
  restoreClassifierInputOrder,
} from "@hn-knowledge/application";
import {
  classificationRunId,
  hnItemId,
  type PipelineJob,
} from "@hn-knowledge/domain";
import {
  createClassificationRepository,
  createClassifierResultsRepository,
  createFeedProcessingRepository,
  createHnResolutionRepository,
  createIngestionRunRepository,
  createJobQueue,
  createOccurrenceRepository,
  type Database,
} from "@hn-knowledge/db";
import {
  type BoundedClassifierInput,
  type ClassifierPort,
  type Hasher,
  type HnItems,
  type SelectionSource,
} from "@hn-knowledge/ports";
import { createIngestJobHandler } from "./jobs/ingest.js";
import { createResolveJobHandler } from "./jobs/resolve.js";
import { WorkerJobError, jobError } from "./jobs/errors.js";

const MAX_ATTEMPTS = 3;
export interface DailyFeedOptions {
  database: Database;
  classifier: ClassifierPort;
  source: () => Promise<{
    source: SelectionSource;
    latestId(sourceKey: string): Promise<number | null>;
  }>;
  hnItems: HnItems;
  hasher: Hasher;
  owner: string;
  signal?: AbortSignal;
  onLeaseLost?: () => void;
}

export const createDailyFeedRuntime = (options: DailyFeedOptions) => {
  const client = options.database.client;
  const processing = createFeedProcessingRepository(client);
  const queue = createJobQueue(client);
  const classifications = createClassificationRepository(client);
  const results = createClassifierResultsRepository(client);
  const runs = createIngestionRunRepository(client);
  const occurrences = createOccurrenceRepository(client);
  const jobs = {
    enqueue: (input: Parameters<typeof queue.enqueue>[0]) =>
      queue.enqueue({
        ...input,
        lane: "feed",
        idempotencyKey: `feed:${input.idempotencyKey}`,
      }),
  };
  const ingest = createIngestJobHandler(
    async () => (await options.source()).source,
    runs,
    occurrences,
    jobs,
  );
  const resolve = createResolveJobHandler(
    () => new HnParentChainResolver(options.hnItems),
    occurrences,
    createHnResolutionRepository(client),
    { now: () => new Date() },
    options.hasher,
    jobs,
  );
  const processClassification = async (
    job: PipelineJob,
    signal: AbortSignal,
  ) => {
    const selectedCommentId = job.payload["selectedCommentId"];
    if (typeof selectedCommentId !== "number")
      throw new WorkerJobError("INVALID_CLASSIFY_PAYLOAD", false);
    const commentId = hnItemId(selectedCommentId);
    const selected = await client.selectedComment.findUnique({
      where: { id: BigInt(commentId) },
      include: { item: true },
    });
    if (
      !selected ||
      selected.availability !== "AVAILABLE" ||
      selected.item.availability !== "AVAILABLE"
    )
      throw new WorkerJobError("SOURCE_UNAVAILABLE", false);
    const input = restoreClassifierInputOrder(
      (job.payload["boundedInput"] ??
        (await loadClassifierInput(
          commentId,
          classifications,
          options.hasher,
        ))) as BoundedClassifierInput,
    );
    if (input.selectedCommentId !== commentId)
      throw new WorkerJobError("INVALID_CLASSIFY_PAYLOAD", false);
    const identity = {
      commentId: BigInt(commentId),
      inputHash: options.hasher.sha256(JSON.stringify(input)),
      promptVersion: CLASSIFICATION_PROMPT_VERSION,
      schemaVersion: CLASSIFICATION_SCHEMA_VERSION,
      modelConfigId: options.classifier.modelConfigId,
    };
    if (
      typeof job.payload["modelConfigId"] === "string" &&
      job.payload["modelConfigId"] !== identity.modelConfigId
    )
      throw new WorkerJobError("PROCESSING_MODEL_CHANGED", false);
    const latest = await client.classificationRun.findFirst({
      where: identity,
      orderBy: { attempt: "desc" },
    });
    if (latest?.errorCode === null) {
      await captureClassifierResult(
        results,
        classifications,
        classificationRunId(latest.id),
        input,
        options.hasher,
      );
      return;
    }
    const requested = job.payload["classificationAttempt"];
    const attempt =
      typeof requested === "number"
        ? requested
        : latest
          ? job.payload["retryRequested"] === true
            ? latest.attempt + 1
            : latest.attempt
          : 1;
    if (!Number.isSafeInteger(attempt) || attempt < 1)
      throw new WorkerJobError("INVALID_CLASSIFY_PAYLOAD", false);
    const existing = await client.classificationRun.findUnique({
      where: { runIdentity: { ...identity, attempt } },
    });
    if (existing) {
      await captureClassifierResult(
        results,
        classifications,
        classificationRunId(existing.id),
        input,
        options.hasher,
      );
      if (existing.errorCode)
        throw new WorkerJobError(existing.errorCode, false);
      return;
    }
    const saved = await processing.prepareJob(job.id, options.owner, {
      ...job.payload,
      boundedInput: input,
      classificationAttempt: attempt,
      modelConfigId: options.classifier.modelConfigId,
    });
    if (!saved) throw new WorkerJobError("JOB_LEASE_NOT_OWNED", false);
    const budgetAbort = new AbortController();
    const requestSignal = AbortSignal.any([signal, budgetAbort.signal]);
    const boundedProvider: ClassifierPort = {
      provider: options.classifier.provider,
      modelId: options.classifier.modelId,
      modelConfigId: options.classifier.modelConfigId,
      async classify(request) {
        signal.throwIfAborted();
        if (!(await processing.reserveRequest())) {
          budgetAbort.abort();
          requestSignal.throwIfAborted();
        }
        signal.throwIfAborted();
        return options.classifier.classify(request);
      },
    };
    try {
      const result = await createClassifyComment(
        boundedProvider,
        classifications,
        options.hasher,
        null,
      )({
        commentId,
        boundedInput: input,
        attempt,
        persistRetryableFailure: job.attempts >= MAX_ATTEMPTS,
        signal: requestSignal,
      });
      if (result.kind === "REVIEW")
        throw new WorkerJobError(result.errorCode, false);
    } catch (error) {
      if (budgetAbort.signal.aborted)
        throw new WorkerJobError("DAILY_REQUEST_LIMIT", true);
      throw error;
    } finally {
      const run = await client.classificationRun.findUnique({
        where: { runIdentity: { ...identity, attempt } },
      });
      if (run)
        await captureClassifierResult(
          results,
          classifications,
          classificationRunId(run.id),
          input,
          options.hasher,
        );
    }
  };
  return {
    async tick(): Promise<"idle" | "processed"> {
      options.signal?.throwIfAborted();
      await processing.advanceCursor();
      const state = await processing.state();
      if (
        !state?.enabled ||
        ["CLASSIFIER_AUTH", "CLASSIFIER_CONFIG"].includes(state.errorCode ?? "")
      )
        return "idle";
      const active = await client.pipelineJob.count({
        where: {
          lane: "feed",
          state: { in: ["AVAILABLE", "RETRYABLE", "LEASED"] },
        },
      });
      const blockedIngest = await client.ingestionRun.count({
        where: {
          feedBatch: { isNot: null },
          jobs: {
            none: { type: "INGEST_SELECTION_RANGE", state: "COMPLETED" },
          },
        },
      });
      if (
        !active &&
        !blockedIngest &&
        (state.syncRequested || state.nextSyncAt.getTime() <= Date.now())
      ) {
        try {
          const source = await options.source();
          await processing.scheduleLatest(
            await source.latestId(state.sourceKey),
          );
        } catch {
          // A completed source check must not overwrite settings saved while it ran.
          await client.feedProcessingState.updateMany({
            where: { id: "local", settingsVersion: state.settingsVersion },
            data: {
              errorCode: "SOURCE_CONNECTION_FAILED",
              syncRequested: false,
              nextSyncAt: new Date(Date.now() + 60_000),
            },
          });
        }
      }
      const job = await queue.claim({
        lane: "feed",
        leaseOwner: options.owner,
        leaseDurationMs: 600_000,
      });
      if (!job) return "idle";
      const jobAbort = new AbortController();
      const signal = options.signal
        ? AbortSignal.any([options.signal, jobAbort.signal])
        : jobAbort.signal;
      let leaseLost = false;
      const hasLostLease = () => leaseLost;
      let renewal: Promise<void> | null = null;
      const heartbeat = setInterval(() => {
        if (renewal) return;
        renewal = queue
          .renew(job.id, options.owner, 600_000)
          .catch(() => {
            leaseLost = true;
            jobAbort.abort();
            options.onLeaseLost?.();
          })
          .finally(() => {
            renewal = null;
          });
      }, 20_000);
      const stopRenewal = async () => {
        clearInterval(heartbeat);
        await renewal;
      };
      const deferForBudget = async () => {
        await processing.deferForBudget(job.id, options.owner);
      };
      try {
        if (job.attempts > MAX_ATTEMPTS)
          throw new WorkerJobError("PROCESSING_INTERRUPTED", false);
        if (job.type === "INGEST_SELECTION_RANGE") await ingest(job);
        else if (job.type === "RESOLVE_HN_COMMENT") await resolve(job);
        else if (job.type === "CLASSIFY_COMMENT") {
          const status = await processing.status();
          if (status.requests_today >= status.daily_request_limit) {
            await stopRenewal();
            signal.throwIfAborted();
            await deferForBudget();
            return "processed";
          }
          await processClassification(job, signal);
        } else throw new WorkerJobError("UNSUPPORTED_FEED_JOB", false);
        await stopRenewal();
        signal.throwIfAborted();
        await queue.complete(job.id, options.owner);
        await processing.advanceCursor();
      } catch (error) {
        await stopRenewal();
        if (hasLostLease()) throw error;
        if (options.signal?.aborted) {
          await queue.retry(
            job.id,
            options.owner,
            "PROCESSING_INTERRUPTED",
            new Date(),
          );
          throw error;
        }
        const failure =
          error instanceof ClassificationExecutionError
            ? new WorkerJobError(
                error.code,
                error.retryable,
                error.retryAfterMs,
              )
            : jobError(error);
        if (failure.code === "DAILY_REQUEST_LIMIT") {
          await deferForBudget();
          return "processed";
        }
        if (["CLASSIFIER_AUTH", "CLASSIFIER_CONFIG"].includes(failure.code))
          await processing.heartbeat(failure.code);
        if (failure.retryable && job.attempts < MAX_ATTEMPTS)
          await queue.retry(
            job.id,
            options.owner,
            failure.code,
            new Date(
              Date.now() + (failure.retryAfterMs ?? 1000 * 2 ** job.attempts),
            ),
          );
        else await queue.terminal(job.id, options.owner, failure.code);
      } finally {
        await stopRenewal();
        if (job.ingestionRunId) await runs.reconcile(job.ingestionRunId);
      }
      return "processed";
    },
  };
};
