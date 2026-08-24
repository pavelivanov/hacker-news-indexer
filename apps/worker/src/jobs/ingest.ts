import {
  createIngestSelectionRange,
  type IngestSelectionRangeResult,
} from "@hn-knowledge/application";
import {
  SELECTION_SOURCES,
  telegramMessageId,
  type IngestionRange,
  type PipelineJob,
  type SelectionSourceKind,
} from "@hn-knowledge/domain";
import type {
  IngestionRunRepository,
  OccurrenceRepository,
  PipelineJobPublisher,
  SelectionSource,
} from "@hn-knowledge/ports";

import { WorkerJobError } from "./errors.js";

export type SelectionSourceProvider = (
  range: IngestionRange,
) => Promise<SelectionSource>;

export type IngestJobHandler = (
  job: PipelineJob,
) => Promise<IngestSelectionRangeResult>;

const payloadRange = (job: PipelineJob): IngestionRange => {
  const source = job.payload["source"];
  const sourceKey = job.payload["sourceKey"];
  const minId = job.payload["minId"];
  const maxId = job.payload["maxId"];
  if (
    typeof source !== "string" ||
    !SELECTION_SOURCES.includes(source as SelectionSourceKind) ||
    typeof sourceKey !== "string" ||
    typeof minId !== "number" ||
    typeof maxId !== "number"
  ) {
    throw new WorkerJobError("INVALID_INGEST_PAYLOAD", false);
  }
  try {
    return {
      source: source as SelectionSourceKind,
      sourceKey,
      minId: telegramMessageId(minId),
      maxId: telegramMessageId(maxId),
    };
  } catch (error) {
    throw new WorkerJobError("INVALID_INGEST_PAYLOAD", false, null, {
      cause: error,
    });
  }
};

export const createIngestJobHandler =
  (
    sourceFor: SelectionSourceProvider,
    runs: IngestionRunRepository,
    occurrences: OccurrenceRepository,
    jobs: PipelineJobPublisher,
  ): IngestJobHandler =>
  async (job): Promise<IngestSelectionRangeResult> => {
    if (job.ingestionRunId === null) {
      throw new WorkerJobError("INGEST_JOB_WITHOUT_RUN", false);
    }
    const range = payloadRange(job);
    const source = await sourceFor(range);
    return createIngestSelectionRange(
      source,
      runs,
      occurrences,
      jobs,
    )({
      runId: job.ingestionRunId,
      range,
    });
  };
