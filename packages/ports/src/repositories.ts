import type {
  HnItem,
  HnItemId,
  IngestionRange,
  IngestionRun,
  IngestionRunId,
  MultipartReconstruction,
  MultipartPart,
  OccurrenceStatus,
  PipelineJob,
  ResolutionPath,
  SelectedComment,
  SelectionOccurrence,
  SelectionOccurrenceInput,
  SelectedOccurrenceContext,
  UrlCandidate,
} from "@hn-knowledge/domain";

export interface StartIngestionResult {
  readonly run: IngestionRun;
  readonly job: PipelineJob;
  readonly created: boolean;
}

export interface IngestionRunRepository {
  startOrGet(
    range: IngestionRange,
    requestKey: string,
  ): Promise<StartIngestionResult>;
  get(id: IngestionRunId): Promise<IngestionRun | null>;
  markRunning(id: IngestionRunId): Promise<void>;
  reconcile(id: IngestionRunId): Promise<IngestionRun>;
}

export interface OccurrenceRepository {
  upsert(
    runId: IngestionRunId,
    occurrence: SelectionOccurrenceInput,
  ): Promise<SelectionOccurrence>;
  clearTelegramBody(occurrenceId: string): Promise<void>;
  listSelectedCommentOccurrences(
    runId: IngestionRunId,
    selectedCommentId: HnItemId,
  ): Promise<readonly SelectedOccurrenceContext[]>;
  setStatus(occurrenceId: string, status: OccurrenceStatus): Promise<void>;
}

export interface HnResolutionRepository {
  saveItem(item: HnItem): Promise<void>;
  saveResolution(
    path: ResolutionPath,
    selectedComment: SelectedComment,
    urlCandidates: readonly UrlCandidate[],
  ): Promise<void>;
  saveMultipart(
    reconstruction: MultipartReconstruction,
    parts: readonly MultipartPart[],
    snapshotHash: string | null,
  ): Promise<void>;
}
