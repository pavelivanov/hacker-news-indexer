import type {
  IngestionRunId,
  PipelineJob,
  PipelineJobId,
} from "@hn-knowledge/domain";
import { ingestionRunId, pipelineJobId } from "@hn-knowledge/domain";
import type {
  EnqueuePipelineJobInput,
  PipelineJobPublisher,
} from "@hn-knowledge/ports";

import type { PipelineJob as DatabasePipelineJob } from "./generated/prisma/client.js";
import { Prisma, type PrismaClient } from "./generated/prisma/client.js";

const MIN_LEASE_DURATION_MS = 1;
const MAX_LEASE_DURATION_MS = 24 * 60 * 60 * 1_000;

export type EnqueueJobInput = EnqueuePipelineJobInput;

export interface ClaimJobOptions {
  readonly lane?: "legacy" | "feed";
  readonly leaseOwner: string;
  readonly leaseDurationMs: number;
  readonly ingestionRunId?: IngestionRunId;
}

export interface JobQueue extends PipelineJobPublisher {
  enqueue(input: EnqueueJobInput): Promise<PipelineJob>;
  claim(options: ClaimJobOptions): Promise<PipelineJob | null>;
  renew(
    jobId: PipelineJobId,
    leaseOwner: string,
    leaseDurationMs: number,
  ): Promise<void>;
  complete(jobId: PipelineJobId, leaseOwner: string): Promise<void>;
  retry(
    jobId: PipelineJobId,
    leaseOwner: string,
    errorCode: string,
    availableAt: Date,
  ): Promise<void>;
  terminal(
    jobId: PipelineJobId,
    leaseOwner: string,
    errorCode: string,
  ): Promise<void>;
}

export class JobLeaseError extends Error {
  readonly code = "JOB_LEASE_NOT_OWNED";

  constructor(jobId: PipelineJobId) {
    super(`Active lease not owned for job ${jobId}`);
    this.name = "JobLeaseError";
  }
}

const requiredText = (value: string, field: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256) {
    throw new TypeError(`${field} must contain 1 to 256 characters`);
  }
  return normalized;
};

const validDate = (value: Date, field: string): Date => {
  if (Number.isNaN(value.getTime())) {
    throw new TypeError(`${field} must be a valid date`);
  }
  return value;
};

const serializedJsonPayload = (
  payload: Readonly<Record<string, unknown>>,
): string => {
  try {
    const serialized = JSON.stringify(payload);
    const parsed: unknown = JSON.parse(serialized);
    if (
      parsed === null ||
      Array.isArray(parsed) ||
      typeof parsed !== "object"
    ) {
      throw new TypeError("Job payload must be a JSON object");
    }
    return serialized;
  } catch (error) {
    if (error instanceof TypeError) {
      throw error;
    }
    throw new TypeError("Job payload must be JSON serializable", {
      cause: error,
    });
  }
};

const payloadRecord = (payload: Prisma.JsonValue): Record<string, unknown> => {
  if (
    payload === null ||
    Array.isArray(payload) ||
    typeof payload !== "object"
  ) {
    throw new TypeError("Stored job payload must be a JSON object");
  }
  return payload;
};

const toDomainJob = (job: DatabasePipelineJob): PipelineJob => ({
  id: pipelineJobId(job.id),
  ingestionRunId:
    job.ingestionRunId === null ? null : ingestionRunId(job.ingestionRunId),
  type: job.type,
  payload: payloadRecord(job.payload),
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

const leaseDuration = (milliseconds: number): number => {
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < MIN_LEASE_DURATION_MS ||
    milliseconds > MAX_LEASE_DURATION_MS
  ) {
    throw new TypeError(
      `leaseDurationMs must be an integer between ${MIN_LEASE_DURATION_MS} and ${MAX_LEASE_DURATION_MS}`,
    );
  }
  return milliseconds;
};

const assertTransitioned = (count: number, jobId: PipelineJobId): void => {
  if (count !== 1) {
    throw new JobLeaseError(jobId);
  }
};

export const createJobQueue = (client: PrismaClient): JobQueue => ({
  async enqueue(input): Promise<PipelineJob> {
    const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey");
    const availableAt =
      input.availableAt === undefined
        ? null
        : validDate(input.availableAt, "availableAt");
    const payload = serializedJsonPayload(input.payload);
    const runId = input.ingestionRunId ?? null;
    const jobs = await client.$queryRaw<DatabasePipelineJob[]>(Prisma.sql`
      INSERT INTO pipeline_jobs (
        lane,
        ingestion_run_id,
        type,
        payload,
        idempotency_key,
        available_at,
        updated_at
      )
      VALUES (
        ${input.lane ?? "legacy"},
        ${runId}::uuid,
        ${input.type}::"PipelineJobType",
        ${payload}::jsonb,
        ${idempotencyKey},
        COALESCE(${availableAt}::timestamptz, CURRENT_TIMESTAMP),
        CURRENT_TIMESTAMP
      )
      ON CONFLICT (idempotency_key) DO UPDATE
      SET idempotency_key = EXCLUDED.idempotency_key
      RETURNING
        id,
        ingestion_run_id AS "ingestionRunId",
        type,
        payload,
        idempotency_key AS "idempotencyKey",
        state,
        attempts,
        available_at AS "availableAt",
        lease_owner AS "leaseOwner",
        lease_expires_at AS "leaseExpiresAt",
        last_error_code AS "lastErrorCode",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `);
    const job = jobs[0];
    if (job === undefined) {
      throw new Error("Job enqueue did not return a row");
    }

    return toDomainJob(job);
  },

  async claim(options): Promise<PipelineJob | null> {
    const owner = requiredText(options.leaseOwner, "leaseOwner");
    const durationMs = leaseDuration(options.leaseDurationMs);
    const runId = options.ingestionRunId ?? null;

    const jobs = await client.$queryRaw<DatabasePipelineJob[]>(Prisma.sql`
      WITH candidate AS (
        SELECT queued.id
        FROM pipeline_jobs AS queued
        WHERE queued.lane = ${options.lane ?? "legacy"}
          AND (${runId}::uuid IS NULL OR queued.ingestion_run_id = ${runId}::uuid)
          AND (
            (
              queued.state IN ('AVAILABLE', 'RETRYABLE')
              AND queued.available_at <= CURRENT_TIMESTAMP
            ) OR (
              queued.state = 'LEASED'
              AND queued.lease_expires_at <= CURRENT_TIMESTAMP
            )
          )
          AND (
            queued.type <> 'RESOLVE_HN_COMMENT'
            OR NOT EXISTS (
              SELECT 1
              FROM pipeline_jobs AS prerequisite
              WHERE prerequisite.ingestion_run_id = queued.ingestion_run_id
                AND prerequisite.type = 'INGEST_SELECTION_RANGE'
                AND prerequisite.state <> 'COMPLETED'
                AND (queued.lane <> 'feed' OR prerequisite.state <> 'TERMINAL')
            )
          )
          AND (
            queued.type <> 'CLASSIFY_COMMENT'
            OR NOT EXISTS (
              SELECT 1
              FROM pipeline_jobs AS prerequisite
              WHERE prerequisite.ingestion_run_id = queued.ingestion_run_id
                AND prerequisite.type = 'RESOLVE_HN_COMMENT'
                AND prerequisite.state <> 'COMPLETED'
                AND (queued.lane <> 'feed' OR prerequisite.state <> 'TERMINAL')
            )
          )
        ORDER BY queued.available_at ASC, queued.created_at ASC, queued.id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE pipeline_jobs AS job
      SET
        state = 'LEASED',
        attempts = job.attempts + 1,
        lease_owner = ${owner},
        lease_expires_at = CURRENT_TIMESTAMP + (${durationMs} * INTERVAL '1 millisecond'),
        updated_at = CURRENT_TIMESTAMP
      FROM candidate
      WHERE job.id = candidate.id
      RETURNING
        job.id,
        job.ingestion_run_id AS "ingestionRunId",
        job.type,
        job.payload,
        job.idempotency_key AS "idempotencyKey",
        job.state,
        job.attempts,
        job.available_at AS "availableAt",
        job.lease_owner AS "leaseOwner",
        job.lease_expires_at AS "leaseExpiresAt",
        job.last_error_code AS "lastErrorCode",
        job.created_at AS "createdAt",
        job.updated_at AS "updatedAt"
    `);

    const job = jobs[0];
    return job === undefined ? null : toDomainJob(job);
  },

  async renew(jobId, leaseOwner, leaseDurationMs): Promise<void> {
    const owner = requiredText(leaseOwner, "leaseOwner");
    const durationMs = leaseDuration(leaseDurationMs);
    const count = await client.$executeRaw(Prisma.sql`
      UPDATE pipeline_jobs
      SET
        lease_expires_at = CURRENT_TIMESTAMP + (${durationMs} * INTERVAL '1 millisecond'),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${jobId}::uuid
        AND state = 'LEASED'
        AND lease_owner = ${owner}
        AND lease_expires_at > CURRENT_TIMESTAMP
    `);
    assertTransitioned(count, jobId);
  },

  async complete(jobId, leaseOwner): Promise<void> {
    const owner = requiredText(leaseOwner, "leaseOwner");
    const count = await client.$executeRaw(Prisma.sql`
      UPDATE pipeline_jobs
      SET
        state = 'COMPLETED',
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error_code = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${jobId}::uuid
        AND state = 'LEASED'
        AND lease_owner = ${owner}
        AND lease_expires_at > CURRENT_TIMESTAMP
    `);
    assertTransitioned(count, jobId);
  },

  async retry(jobId, leaseOwner, errorCode, availableAt): Promise<void> {
    const owner = requiredText(leaseOwner, "leaseOwner");
    const normalizedErrorCode = requiredText(errorCode, "errorCode");
    const nextAvailableAt = validDate(availableAt, "availableAt");
    const count = await client.$executeRaw(Prisma.sql`
      UPDATE pipeline_jobs
      SET
        state = 'RETRYABLE',
        available_at = ${nextAvailableAt},
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error_code = ${normalizedErrorCode},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${jobId}::uuid
        AND state = 'LEASED'
        AND lease_owner = ${owner}
        AND lease_expires_at > CURRENT_TIMESTAMP
    `);
    assertTransitioned(count, jobId);
  },

  async terminal(jobId, leaseOwner, errorCode): Promise<void> {
    const owner = requiredText(leaseOwner, "leaseOwner");
    const normalizedErrorCode = requiredText(errorCode, "errorCode");
    const count = await client.$executeRaw(Prisma.sql`
      UPDATE pipeline_jobs
      SET
        state = 'TERMINAL',
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error_code = ${normalizedErrorCode},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${jobId}::uuid
        AND state = 'LEASED'
        AND lease_owner = ${owner}
        AND lease_expires_at > CURRENT_TIMESTAMP
    `);
    assertTransitioned(count, jobId);
  },
});
