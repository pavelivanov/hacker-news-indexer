import type {
  IngestionRange,
  IngestionRun,
  IngestionRunId,
  PipelineJob,
} from "@hn-knowledge/domain";
import {
  ingestionRunId,
  pipelineJobId,
  telegramMessageId,
} from "@hn-knowledge/domain";
import type {
  IngestionRunRepository,
  StartIngestionResult,
} from "@hn-knowledge/ports";

import type {
  IngestionRun as DatabaseIngestionRun,
  PipelineJob as DatabasePipelineJob,
  PrismaClient,
} from "../generated/prisma/client.js";
import { Prisma } from "../generated/prisma/client.js";

type RunWithJobs = DatabaseIngestionRun & {
  readonly jobs: readonly DatabasePipelineJob[];
};

const toDomainRun = (run: DatabaseIngestionRun): IngestionRun => ({
  id: ingestionRunId(run.id),
  requestKey: run.requestKey,
  range: {
    source: run.source,
    sourceKey: run.sourceKey,
    minId: telegramMessageId(Number(run.minId)),
    maxId: telegramMessageId(Number(run.maxId)),
  },
  status: run.status,
  startedAt: run.startedAt,
  completedAt: run.completedAt,
});

const toPayload = (value: Prisma.JsonValue): Record<string, unknown> => {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError("Stored job payload must be a JSON object");
  }
  return value;
};

const toDomainJob = (job: DatabasePipelineJob): PipelineJob => ({
  id: pipelineJobId(job.id),
  ingestionRunId:
    job.ingestionRunId === null ? null : ingestionRunId(job.ingestionRunId),
  type: job.type,
  payload: toPayload(job.payload),
  idempotencyKey: job.idempotencyKey,
  state: job.state,
  attempts: job.attempts,
  availableAt: job.availableAt,
  leaseOwner: job.leaseOwner,
  leaseExpiresAt: job.leaseExpiresAt,
  lastErrorCode: job.lastErrorCode,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
});

const result = (
  record: RunWithJobs,
  created: boolean,
): StartIngestionResult => {
  const job = record.jobs[0];
  if (job === undefined) {
    throw new Error("Ingestion run is missing its range job");
  }
  return { run: toDomainRun(record), job: toDomainJob(job), created };
};

const jobKey = (requestKey: string): string => `ingest-range:${requestKey}`;

const findRunWithJob = async (
  client: PrismaClient,
  requestKey: string,
): Promise<RunWithJobs | null> =>
  client.ingestionRun.findUnique({
    where: { requestKey },
    include: {
      jobs: {
        where: { idempotencyKey: jobKey(requestKey) },
        take: 1,
      },
    },
  });

export const createIngestionRunRepository = (
  client: PrismaClient,
): IngestionRunRepository => ({
  async startOrGet(
    range: IngestionRange,
    requestKey: string,
  ): Promise<StartIngestionResult> {
    try {
      const record = await client.ingestionRun.create({
        data: {
          source: range.source,
          sourceKey: range.sourceKey,
          minId: BigInt(range.minId),
          maxId: BigInt(range.maxId),
          requestKey,
          jobs: {
            create: {
              type: "INGEST_SELECTION_RANGE",
              idempotencyKey: jobKey(requestKey),
              payload: {
                source: range.source,
                sourceKey: range.sourceKey,
                minId: range.minId,
                maxId: range.maxId,
                requestKey,
              },
            },
          },
        },
        include: {
          jobs: {
            where: { idempotencyKey: jobKey(requestKey) },
            take: 1,
          },
        },
      });
      return result(record, true);
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2002"
      ) {
        throw error;
      }

      const existing = await findRunWithJob(client, requestKey);
      if (existing === null) {
        throw error;
      }
      return result(existing, false);
    }
  },

  async get(id: IngestionRunId): Promise<IngestionRun | null> {
    const run = await client.ingestionRun.findUnique({ where: { id } });
    return run === null ? null : toDomainRun(run);
  },

  async markRunning(id: IngestionRunId): Promise<void> {
    await client.ingestionRun.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "RUNNING", startedAt: new Date() },
    });
  },

  async reconcile(id: IngestionRunId): Promise<IngestionRun> {
    return client.$transaction(async (transaction) => {
      const [run, observedCount, states, resolvedCount] = await Promise.all([
        transaction.ingestionRun.findUniqueOrThrow({ where: { id } }),
        transaction.ingestionRunOccurrence.count({
          where: { ingestionRunId: id },
        }),
        transaction.pipelineJob.groupBy({
          by: ["state"],
          where: { ingestionRunId: id },
          _count: { _all: true },
        }),
        transaction.pipelineJob.count({
          where: {
            ingestionRunId: id,
            type: "RESOLVE_HN_COMMENT",
            state: "COMPLETED",
          },
        }),
      ]);
      const count = (state: (typeof states)[number]["state"]): number =>
        states.find((entry) => entry.state === state)?._count._all ?? 0;
      const activeCount =
        count("AVAILABLE") + count("RETRYABLE") + count("LEASED");
      const terminalCount = count("TERMINAL");
      const status =
        activeCount > 0
          ? "RUNNING"
          : terminalCount === 0
            ? "COMPLETED"
            : resolvedCount > 0
              ? "PARTIAL"
              : "FAILED";
      const updated = await transaction.ingestionRun.update({
        where: { id },
        data: {
          status,
          observedCount,
          resolvedCount,
          terminalCount,
          completedAt: activeCount === 0 ? new Date() : null,
          startedAt: run.startedAt ?? new Date(),
        },
      });
      return toDomainRun(updated);
    });
  },
});
