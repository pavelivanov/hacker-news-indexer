import type {
  ClassificationRun,
  ClassificationRunId,
  ClassificationRunStatus,
  ContentDecision,
  ContentDecisionClass,
  ContentDecisionId,
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

import type { StoredClassifierSource } from "./classifier.js";

export interface RecordClassificationRunInput {
  readonly commentId: HnItemId;
  readonly inputHash: string;
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly schemaVersion: string;
  readonly modelConfigId: string;
  readonly provider: string;
  readonly modelId: string;
  readonly outputHash: string | null;
  readonly providerOutput: unknown;
  readonly latencyMs: number | null;
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly cacheWriteInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly status: ClassificationRunStatus;
  readonly errorCode: string | null;
}

export interface RecordClassificationRunResult {
  readonly run: ClassificationRun;
  readonly created: boolean;
}

export interface SaveContentDecisionInput {
  readonly commentId: HnItemId;
  readonly classificationRunId: ClassificationRunId | null;
  readonly source: "MODEL" | "MANUAL";
  readonly primaryDecision: ContentDecisionClass;
  readonly decisionConfidence: number;
  readonly materiallyTechnical: boolean;
  readonly reviewRequired: boolean;
  readonly validatedOutput: unknown;
  readonly manualOverrideOfId: ContentDecisionId | null;
  readonly evidenceSpans: readonly {
    readonly spanId: string;
    readonly sourceDocument: string;
    readonly origin: "COMMENT" | "ROOT_STORY";
    readonly start: number;
    readonly end: number;
    readonly textHash: string;
  }[];
}

export interface ClassificationRepository {
  loadSource(commentId: HnItemId): Promise<StoredClassifierSource | null>;
  recordRun(
    input: RecordClassificationRunInput,
  ): Promise<RecordClassificationRunResult>;
  getRun(id: ClassificationRunId): Promise<ClassificationRun | null>;
  saveDecision(input: SaveContentDecisionInput): Promise<ContentDecision>;
  activateDecision(
    commentId: HnItemId,
    decisionId: ContentDecisionId,
  ): Promise<void>;
  getActiveDecision(commentId: HnItemId): Promise<ContentDecision | null>;
}

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
