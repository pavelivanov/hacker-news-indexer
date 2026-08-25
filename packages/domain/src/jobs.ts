import type { IngestionRunId, PipelineJobId } from "./identities.js";

export const PIPELINE_JOB_TYPES = [
  "INGEST_SELECTION_RANGE",
  "RESOLVE_HN_COMMENT",
  "CLASSIFY_COMMENT",
  "RECONCILE_HN_ITEM",
] as const;
export type PipelineJobType = (typeof PIPELINE_JOB_TYPES)[number];

export const PIPELINE_JOB_STATES = [
  "AVAILABLE",
  "LEASED",
  "COMPLETED",
  "RETRYABLE",
  "TERMINAL",
] as const;
export type PipelineJobState = (typeof PIPELINE_JOB_STATES)[number];

export interface PipelineJob {
  readonly id: PipelineJobId;
  readonly ingestionRunId: IngestionRunId | null;
  readonly type: PipelineJobType;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly state: PipelineJobState;
  readonly attempts: number;
  readonly availableAt: Date;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly lastErrorCode: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
