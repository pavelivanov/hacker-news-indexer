import { createHash } from "node:crypto";
import { FeedProcessingError } from "@hn-knowledge/domain";
import type { FeedProcessingStatus } from "@hn-knowledge/ports";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const object = (
  value: Prisma.JsonValue,
): Record<string, Prisma.JsonValue | undefined> =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const midnight = () => new Date(new Date().toISOString().slice(0, 10));
export const createFeedProcessingRepository = (client: PrismaClient) => ({
  async prepareJob(
    id: string,
    owner: string,
    payload: Readonly<Record<string, unknown>>,
  ) {
    const saved = await client.pipelineJob.updateMany({
      where: { id, state: "LEASED", leaseOwner: owner },
      data: { payload: json(payload) },
    });
    return saved.count === 1;
  },
  async initialize(sourceKey: string) {
    const state = await client.feedProcessingState.upsert({
      where: { id: "local" },
      update: {},
      create: { id: "local", sourceKey },
    });
    if (state.sourceKey !== sourceKey) throw new Error("FEED_SOURCE_CHANGED");
    return state;
  },
  state: () =>
    client.feedProcessingState.findUnique({ where: { id: "local" } }),
  async heartbeat(errorCode?: string | null) {
    await client.feedProcessingState.update({
      where: { id: "local" },
      data: {
        heartbeatAt: new Date(),
        ...(errorCode !== undefined ? { errorCode } : {}),
      },
    });
  },
  async status(): Promise<FeedProcessingStatus> {
    const [state, usage, groups, failures, latest] = await Promise.all([
      client.feedProcessingState.findUnique({ where: { id: "local" } }),
      client.feedRequestUsage.findUnique({ where: { day: midnight() } }),
      client.pipelineJob.groupBy({
        by: ["state"],
        where: { lane: "feed" },
        _count: { _all: true },
      }),
      client.pipelineJob.findMany({
        where: { lane: "feed", state: "TERMINAL" },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 10,
        select: {
          id: true,
          type: true,
          payload: true,
          lastErrorCode: true,
          attempts: true,
        },
      }),
      client.classifierResultSnapshot.aggregate({ _max: { createdAt: true } }),
    ]);
    const count = (name: string) =>
      groups.find((group) => group.state === name)?._count._all ?? 0;
    return {
      configured: state !== null,
      enabled: state?.enabled ?? false,
      online:
        !!state?.heartbeatAt &&
        Date.now() - state.heartbeatAt.getTime() < 30_000,
      source: state?.sourceKey ?? "hn_best_comments",
      last_checked_at: state?.lastCheckedAt?.toISOString() ?? null,
      last_result_at: latest._max.createdAt?.toISOString() ?? null,
      next_sync_at: state?.nextSyncAt.toISOString() ?? null,
      sync_requested: state?.syncRequested ?? false,
      error_code: state?.errorCode ?? null,
      interval_seconds: state?.intervalSeconds ?? 1800,
      batch_size: state?.batchSize ?? 20,
      daily_request_limit: state?.dailyRequestLimit ?? 100,
      requests_today: usage?.requests ?? 0,
      budget_resets_at: new Date(
        midnight().getTime() + 86_400_000,
      ).toISOString(),
      pending: count("AVAILABLE") + count("RETRYABLE"),
      processing: count("LEASED"),
      failed: count("TERMINAL"),
      failures: failures.map((job) => ({
        id: job.id,
        stage: job.type,
        comment_id:
          typeof object(job.payload)["selectedCommentId"] === "number"
            ? (object(job.payload)["selectedCommentId"] as number)
            : null,
        error_code: job.lastErrorCode,
        attempts: job.attempts,
      })),
    };
  },
  async control(action: "sync" | "pause" | "resume") {
    const result = await client.feedProcessingState.updateMany({
      where: { id: "local" },
      data:
        action === "pause"
          ? { enabled: false }
          : {
              ...(action === "resume" ? { enabled: true } : {}),
              syncRequested: true,
              errorCode: null,
            },
    });
    if (!result.count) throw new FeedProcessingError("NOT_FOUND");
  },
  async reserveRequest(limit: number): Promise<boolean> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new TypeError("Invalid request limit");
    const rows = await client.$queryRaw<Array<{ requests: number }>>(Prisma.sql`
      INSERT INTO feed_request_usage(day,requests)
      VALUES ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date, 1)
      ON CONFLICT(day) DO UPDATE SET requests = feed_request_usage.requests + 1
      WHERE feed_request_usage.requests < ${limit} RETURNING requests
    `);
    return rows.length === 1;
  },
  async advanceCursor() {
    const completed = await client.ingestionRun.aggregate({
      where: {
        feedBatch: { isNot: null },
        jobs: { some: { type: "INGEST_SELECTION_RANGE", state: "COMPLETED" } },
      },
      _max: { maxId: true },
    });
    if (completed._max.maxId !== null)
      await client.feedProcessingState.updateMany({
        where: {
          id: "local",
          OR: [{ cursor: null }, { cursor: { lt: completed._max.maxId } }],
        },
        data: { cursor: completed._max.maxId },
      });
  },
  async scheduleLatest(latestId: number | null) {
    if (latestId !== null && (!Number.isSafeInteger(latestId) || latestId < 1))
      throw new TypeError("Invalid source cursor");
    return client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM feed_processing_state WHERE id = 'local' FOR UPDATE`;
      const state = await tx.feedProcessingState.findUniqueOrThrow({
        where: { id: "local" },
      });
      if (
        !state.enabled ||
        (!state.syncRequested && state.nextSyncAt.getTime() > Date.now())
      )
        return null;
      const waiting = await tx.ingestionRun.count({
        where: {
          feedBatch: { isNot: null },
          jobs: {
            none: { type: "INGEST_SELECTION_RANGE", state: "COMPLETED" },
          },
        },
      });
      if (waiting > 0) return null;
      const nextSyncAt = new Date(Date.now() + state.intervalSeconds * 1000);
      await tx.feedProcessingState.update({
        where: { id: "local" },
        data: {
          nextSyncAt,
          lastCheckedAt: new Date(),
          syncRequested: false,
          errorCode: null,
        },
      });
      if (
        latestId === null ||
        (state.cursor !== null && BigInt(latestId) <= state.cursor)
      )
        return null;
      const minId =
        state.cursor === null
          ? Math.max(1, latestId - state.batchSize + 1)
          : Number(state.cursor) + 1;
      const maxId = Math.min(latestId, minId + state.batchSize - 1);
      const requestKey = hash(
        JSON.stringify(["daily-feed-v1", state.sourceKey, minId, maxId]),
      );
      const run = await tx.ingestionRun.create({
        data: {
          source: "TELEGRAM",
          sourceKey: state.sourceKey,
          minId: BigInt(minId),
          maxId: BigInt(maxId),
          requestKey,
          feedBatch: { create: {} },
          jobs: {
            create: {
              type: "INGEST_SELECTION_RANGE",
              lane: "feed",
              idempotencyKey: `ingest-range:${requestKey}`,
              payload: {
                source: "TELEGRAM",
                sourceKey: state.sourceKey,
                minId,
                maxId,
                requestKey,
              },
            },
          },
        },
      });
      return run.id;
    });
  },
  async retry(kind: "job" | "result", id: string, commandKey: string) {
    const requestHash = hash(JSON.stringify([kind, id]));
    const replay = (receipt: {
      requestHash: string;
      result: Prisma.JsonValue;
    }) => {
      if (receipt.requestHash !== requestHash)
        throw new FeedProcessingError("IDEMPOTENCY_CONFLICT");
      const jobId = object(receipt.result)["job_id"];
      if (typeof jobId !== "string") throw new Error("Invalid retry receipt");
      return {
        job_id: jobId,
        replayed: true,
      };
    };
    try {
      return await client.$transaction(async (tx) => {
        const receipt = await tx.feedCommandReceipt.findUnique({
          where: { commandKey },
        });
        if (receipt) return replay(receipt);
        let jobId: string;
        if (kind === "job") {
          const job = await tx.pipelineJob.findUnique({ where: { id } });
          if (!job || job.lane !== "feed")
            throw new FeedProcessingError("NOT_FOUND");
          if (job.state !== "TERMINAL")
            throw new FeedProcessingError("STATE_CONFLICT");
          const payload = { ...object(job.payload), retryRequested: true };
          delete (payload as Record<string, unknown>)["classificationAttempt"];
          delete (payload as Record<string, unknown>)["modelConfigId"];
          const updated = await tx.pipelineJob.updateMany({
            where: { id, state: "TERMINAL", updatedAt: job.updatedAt },
            data: {
              state: "AVAILABLE",
              attempts: 0,
              availableAt: new Date(),
              lastErrorCode: null,
              payload: json(payload),
              leaseOwner: null,
              leaseExpiresAt: null,
            },
          });
          if (!updated.count) throw new FeedProcessingError("STATE_CONFLICT");
          jobId = id;
        } else {
          const result = await tx.classifierResultSnapshot.findUnique({
            where: { runId: id },
            include: { run: true },
          });
          if (!result) throw new FeedProcessingError("NOT_FOUND");
          if (!result.errorCode)
            throw new FeedProcessingError("STATE_CONFLICT");
          const job = await tx.pipelineJob.upsert({
            where: { idempotencyKey: `feed-retry-result:${id}` },
            update: {},
            create: {
              type: "CLASSIFY_COMMENT",
              lane: "feed",
              idempotencyKey: `feed-retry-result:${id}`,
              payload: {
                selectedCommentId: Number(result.run.commentId),
                boundedInput: json(result.sourceInput),
                classificationAttempt: result.run.attempt + 1,
                modelConfigId: result.run.modelConfigId,
              },
            },
          });
          jobId = job.id;
        }
        await tx.feedCommandReceipt.create({
          data: { commandKey, requestHash, result: { job_id: jobId } },
        });
        return { job_id: jobId, replayed: false };
      });
    } catch (error) {
      if (
        error instanceof FeedProcessingError ||
        (error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002")
      ) {
        const receipt = await client.feedCommandReceipt.findUnique({
          where: { commandKey },
        });
        if (receipt) return replay(receipt);
      }
      throw error;
    }
  },
});
