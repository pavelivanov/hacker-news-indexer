import type {
  IngestionRunId,
  PipelineJob,
  PipelineJobType,
} from "@hn-knowledge/domain";

export interface EnqueuePipelineJobInput {
  readonly type: PipelineJobType;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly ingestionRunId?: IngestionRunId;
  readonly availableAt?: Date;
}

export interface PipelineJobPublisher {
  enqueue(input: EnqueuePipelineJobInput): Promise<PipelineJob>;
}
