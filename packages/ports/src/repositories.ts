import type {
  ClassificationRun,
  ClassificationRunId,
  ClassificationRunStatus,
  ContentDecision,
  ContentDecisionClass,
  ContentDecisionId,
  DiscoveryId,
  ExportId,
  ExportOutboxPage,
  ExportOutboxRevision,
  FindThatProjectIneligibilityCode,
  FindThatProjectRetractionReason,
  HnItem,
  HnItemId,
  IngestionRange,
  IngestionRun,
  IngestionRunId,
  MultipartReconstruction,
  MultipartPart,
  OccurrenceStatus,
  PipelineJob,
  ManualOverrideEvent,
  ExpertNoteType,
  MaterializedEvidenceOrigin,
  ReviewPriority,
  ReviewReasonCode,
  ReviewTask,
  ReviewTaskId,
  ReviewTaskKind,
  ResolutionPath,
  SelectedComment,
  SelectionOccurrence,
  SelectionOccurrenceInput,
  SelectedOccurrenceContext,
  SubjectId,
  SubjectIdentity,
  SubjectType,
  UrlCandidate,
  UrlCandidateId,
} from "@hn-knowledge/domain";

import type { StoredClassifierSource } from "./classifier.js";

export interface RecordClassificationRunInput {
  readonly attempt?: number;
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
  getActiveDecision(commentId: HnItemId): Promise<ContentDecision | null>;
}

export interface OpenReviewTaskInput {
  readonly commentId: HnItemId;
  readonly contentDecisionId: ContentDecisionId;
  readonly kind: ReviewTaskKind;
  readonly targetKey: string;
  readonly targetSnapshotHash: string | null;
  readonly priority: Exclude<ReviewPriority, "NONE">;
  readonly reasonCodes: readonly ReviewReasonCode[];
  readonly actorId: string;
  readonly commandKey: string;
  readonly requestHash: string;
  readonly reason: string;
}

export interface OpenReviewTaskResult {
  readonly task: ReviewTask;
  readonly event: ManualOverrideEvent;
  readonly created: boolean;
}

export interface ResolveReviewTaskInput {
  readonly taskId: ReviewTaskId;
  readonly expectedVersion: number;
  readonly outcome: "APPROVED" | "REJECTED" | "SUPERSEDED";
  readonly actorId: string;
  readonly commandKey: string;
  readonly requestHash: string;
  readonly reason: string;
}

export type ResolveReviewTaskResult =
  | {
      readonly kind: "RESOLVED";
      readonly task: ReviewTask;
      readonly event: ManualOverrideEvent;
      readonly replayed: boolean;
    }
  | { readonly kind: "NOT_FOUND" }
  | {
      readonly kind: "VERSION_CONFLICT";
      readonly currentVersion: number;
    }
  | {
      readonly kind: "INVALID_STATE";
      readonly state: ReviewTask["state"];
    }
  | { readonly kind: "POLICY_INVALID" }
  | { readonly kind: "IDEMPOTENCY_CONFLICT" };

export interface ReopenReviewTaskInput {
  readonly taskId: ReviewTaskId;
  readonly expectedVersion: number;
  readonly actorId: string;
  readonly commandKey: string;
  readonly requestHash: string;
  readonly reason: string;
}

export type ReopenReviewTaskResult =
  | {
      readonly kind: "REOPENED";
      readonly task: ReviewTask;
      readonly event: ManualOverrideEvent;
      readonly replayed: boolean;
    }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "VERSION_CONFLICT"; readonly currentVersion: number }
  | { readonly kind: "INVALID_STATE"; readonly state: ReviewTask["state"] }
  | { readonly kind: "POLICY_INVALID" }
  | { readonly kind: "IDEMPOTENCY_CONFLICT" };

export interface MergeSubjectsReviewInput {
  readonly taskId: ReviewTaskId;
  readonly expectedVersion: number;
  readonly sourceSubjectId: SubjectId;
  readonly targetSubjectId: SubjectId;
  readonly actorId: string;
  readonly commandKey: string;
  readonly requestHash: string;
  readonly reason: string;
}

export interface ResolveSubjectUrlReviewInput {
  readonly taskId: ReviewTaskId;
  readonly expectedVersion: number;
  readonly subjectId: SubjectId;
  readonly urlCandidateId: UrlCandidateId;
  readonly actorId: string;
  readonly commandKey: string;
  readonly requestHash: string;
  readonly reason: string;
}

export type EntityReviewMutationResult =
  | {
      readonly kind: "RESOLVED";
      readonly task: ReviewTask;
      readonly event: ManualOverrideEvent;
      readonly replayed: boolean;
    }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "VERSION_CONFLICT"; readonly currentVersion: number }
  | { readonly kind: "INVALID_STATE"; readonly state: ReviewTask["state"] }
  | { readonly kind: "POLICY_INVALID" }
  | { readonly kind: "IDEMPOTENCY_CONFLICT" };

export interface ReviewTaskPage {
  readonly items: readonly ReviewTask[];
  readonly nextCursor: ReviewTaskId | null;
}

export interface ReviewRepository {
  openTask(input: OpenReviewTaskInput): Promise<OpenReviewTaskResult>;
  getTask(id: ReviewTaskId): Promise<ReviewTask | null>;
  listOpenTasks(
    limit: number,
    afterId: ReviewTaskId | null,
  ): Promise<ReviewTaskPage>;
  resolveTask(input: ResolveReviewTaskInput): Promise<ResolveReviewTaskResult>;
  reopenTask(input: ReopenReviewTaskInput): Promise<ReopenReviewTaskResult>;
  mergeSubjects(
    input: MergeSubjectsReviewInput,
  ): Promise<EntityReviewMutationResult>;
  resolveSubjectUrl(
    input: ResolveSubjectUrlReviewInput,
  ): Promise<EntityReviewMutationResult>;
}

export interface SubjectMaterializationSource {
  readonly decision: ContentDecision;
  readonly resolvedRootId: HnItemId;
}

export interface MaterializationUrlCandidate {
  readonly classifierId: string;
  readonly rawUrl: string;
  readonly canonicalUrl: string;
  readonly sourceDocument: string;
  readonly originField: string;
  readonly scheme: "http" | "https";
  readonly host: string;
  readonly contentHash: string;
  readonly sourceOrdinal: number;
}

export interface MaterializedSubjectInput {
  readonly localKey: string;
  readonly identity: SubjectIdentity;
  readonly name: string;
  readonly aliases: readonly {
    readonly value: string;
    readonly normalized: string;
  }[];
  readonly canonicalUrlCandidate: MaterializationUrlCandidate | null;
}

export interface MaterializedSubjectMentionInput {
  readonly subjectLocalKey: string | null;
  readonly existingSubjectId: SubjectId | null;
  readonly sourceKind: "DISCOVERY" | "EXPERT_NOTE";
  readonly sourceOrdinal: number;
  readonly evidenceOrigin: MaterializedEvidenceOrigin;
  readonly confidence: number;
  readonly evidenceSpanIds: readonly string[];
}

export interface MaterializedDiscoveryInput {
  readonly subjectLocalKey: string;
  readonly sourceOrdinal: number;
  readonly identityKey: string;
  readonly rootStoryOnly: boolean;
  readonly descriptionClaim: string;
  readonly evidenceOrigin: MaterializedEvidenceOrigin;
  readonly confidence: number;
  readonly evidenceSpanIds: readonly string[];
}

export interface MaterializedExpertNoteInput {
  readonly noteType: ExpertNoteType;
  readonly title: string;
  readonly summary: string;
  readonly relatedSubjectNames: readonly string[];
  readonly evidenceOrigin: MaterializedEvidenceOrigin;
  readonly confidence: number;
  readonly evidenceSpanIds: readonly string[];
  readonly subjectLocalKeys: readonly string[];
  readonly subjectIds: readonly SubjectId[];
}

export interface MaterializeClassificationInput {
  readonly decisionId: ContentDecisionId;
  readonly commentId: HnItemId;
  readonly resolvedRootId: HnItemId;
  readonly extractionVersion: string;
  readonly urlCandidates: readonly MaterializationUrlCandidate[];
  readonly subjects: readonly MaterializedSubjectInput[];
  readonly mentions: readonly MaterializedSubjectMentionInput[];
  readonly discoveries: readonly MaterializedDiscoveryInput[];
  readonly expertNote: MaterializedExpertNoteInput | null;
}

export interface MaterializeClassificationResult {
  readonly subjects: number;
  readonly mentions: number;
  readonly discoveries: number;
  readonly discoverySources: number;
  readonly expertNotes: number;
}

export interface SubjectNameMatch {
  readonly id: SubjectId;
  readonly type: SubjectType;
  readonly normalizedName: string;
  readonly normalizedAliases: readonly string[];
  readonly contextKey: string;
  readonly dedupKey: string;
}

export interface SubjectMaterializationRepository {
  loadSource(
    decisionId: ContentDecisionId,
  ): Promise<SubjectMaterializationSource | null>;
  findNameMatches(
    normalizedNames: readonly string[],
    contextKey: string | null,
  ): Promise<readonly SubjectNameMatch[]>;
  materialize(
    input: MaterializeClassificationInput,
  ): Promise<MaterializeClassificationResult>;
}

export interface ReaderSubjectLinkRecord {
  readonly id: string;
  readonly name: string;
  readonly type: SubjectType;
}

export interface ReaderEvidenceRecord {
  readonly origin: "COMMENT" | "ROOT_STORY";
  readonly hnItemId: HnItemId;
  readonly start: number;
  readonly end: number;
  readonly excerpt: string;
}

export interface ReaderPublicationRecord {
  readonly publishedAt: Date;
  readonly updatedAt: Date;
  readonly reviewRevision: number;
  readonly publicationRevision: number;
}

export interface ReaderContentProvenanceRecord {
  readonly selectedCommentId: HnItemId;
  readonly resolvedRootId: HnItemId;
  readonly displayedStoryId: HnItemId | null;
  readonly sourceOccurrenceIds: readonly string[];
}

export interface ReaderDiscoveryRecord
  extends ReaderPublicationRecord, ReaderContentProvenanceRecord {
  readonly id: string;
  readonly kind: "discovery";
  readonly title: string;
  readonly summary: string;
  readonly confidence: number;
  readonly subjects: readonly ReaderSubjectLinkRecord[];
  readonly evidence: readonly ReaderEvidenceRecord[];
}

export interface ReaderExpertNoteRecord
  extends ReaderPublicationRecord, ReaderContentProvenanceRecord {
  readonly id: string;
  readonly kind: "expert_note";
  readonly noteType: ExpertNoteType;
  readonly title: string;
  readonly summary: string;
  readonly confidence: number;
  readonly subjects: readonly ReaderSubjectLinkRecord[];
  readonly evidence: readonly ReaderEvidenceRecord[];
}

export type ReaderContentRecord =
  ReaderDiscoveryRecord | ReaderExpertNoteRecord;

export interface ReaderContentFilter {
  readonly kind: ReaderContentRecord["kind"] | null;
  readonly selectedCommentId: HnItemId | null;
  readonly resolvedRootId: HnItemId | null;
  readonly subjectId: SubjectId | null;
  readonly limit: number;
}

export interface ReaderCommentRecord {
  readonly id: HnItemId;
  readonly author: string | null;
  readonly canonicalHtml: string;
  readonly canonicalText: string;
  readonly createdAt: Date | null;
  readonly resolvedRootId: HnItemId;
  readonly displayedStoryId: HnItemId | null;
  readonly sourceOccurrenceIds: readonly string[];
}

export interface ReaderStoryRecord {
  readonly id: HnItemId;
  readonly title: string | null;
  readonly author: string | null;
  readonly canonicalHtml: string;
  readonly canonicalText: string;
  readonly url: string | null;
  readonly createdAt: Date | null;
}

export interface ReaderSubjectRecord extends ReaderSubjectLinkRecord {
  readonly aliases: readonly string[];
  readonly canonicalUrl: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface KnowledgeReaderRepository {
  listPublishedContent(
    filter: ReaderContentFilter,
  ): Promise<readonly ReaderContentRecord[]>;
  getAvailableComment(id: HnItemId): Promise<ReaderCommentRecord | null>;
  getAvailableStory(id: HnItemId): Promise<ReaderStoryRecord | null>;
  getActiveSubject(id: SubjectId): Promise<ReaderSubjectRecord | null>;
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

export type HnReconciliationOutcome =
  "UNCHANGED" | "CONTENT_CHANGED" | "ROOT_CHANGED" | "TOMBSTONED";

export interface HnReconciliationTarget {
  readonly selectedCommentId: HnItemId;
  readonly displayedStoryId: HnItemId | null;
  readonly resolvedRootId: HnItemId;
  readonly contentHash: string;
  readonly responseHash: string;
}

export interface ApplyHnReconciliationInput {
  readonly selected: SelectedComment;
  readonly path: ResolutionPath;
  readonly fetchedItems: readonly HnItem[];
  readonly urlCandidates: readonly UrlCandidate[];
  readonly idempotencyKey: string;
}

export interface ApplyHnTombstoneInput {
  readonly selectedCommentId: HnItemId;
  readonly availability: "DELETED" | "DEAD" | "MISSING";
  readonly responseHash: string;
  readonly fetchedAt: Date;
  readonly item: HnItem | null;
  readonly idempotencyKey: string;
}

export interface HnReconciliationResult {
  readonly outcome: HnReconciliationOutcome;
  readonly changed: boolean;
  readonly classificationEnqueued: boolean;
  readonly reviewOpened: boolean;
  readonly replayed: boolean;
}

export interface ReconciliationScheduleResult {
  readonly lockAcquired: boolean;
  readonly scheduled: number;
}

export interface HnReconciliationRepository {
  loadTarget(id: HnItemId): Promise<HnReconciliationTarget | null>;
  apply(input: ApplyHnReconciliationInput): Promise<HnReconciliationResult>;
  tombstone(input: ApplyHnTombstoneInput): Promise<HnReconciliationResult>;
  schedule(
    scheduleKey: string,
    availableAt: Date,
    limit: number,
  ): Promise<ReconciliationScheduleResult>;
}

export interface RequestFindThatProjectReviewInput {
  readonly discoveryId: DiscoveryId;
  readonly actorId: string;
  readonly commandKey: string;
  readonly requestHash: string;
  readonly reason: string;
}

export type RequestFindThatProjectReviewResult =
  | {
      readonly kind: "OPENED";
      readonly task: ReviewTask;
      readonly created: boolean;
    }
  | {
      readonly kind: "INELIGIBLE";
      readonly reasons: readonly FindThatProjectIneligibilityCode[];
    }
  | { readonly kind: "ALREADY_CURRENT" }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "IDEMPOTENCY_CONFLICT" };

export interface ApproveFindThatProjectReviewInput {
  readonly taskId: ReviewTaskId;
  readonly expectedVersion: number;
  readonly actorId: string;
  readonly commandKey: string;
  readonly requestHash: string;
  readonly reason: string;
}

export type ApproveFindThatProjectReviewResult =
  | {
      readonly kind: "APPROVED";
      readonly task: ReviewTask;
      readonly revision: ExportOutboxRevision;
      readonly replayed: boolean;
    }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "VERSION_CONFLICT"; readonly currentVersion: number }
  | { readonly kind: "INVALID_STATE"; readonly state: ReviewTask["state"] }
  | {
      readonly kind: "INELIGIBLE";
      readonly reasons: readonly FindThatProjectIneligibilityCode[];
    }
  | { readonly kind: "SNAPSHOT_CHANGED" }
  | { readonly kind: "IDEMPOTENCY_CONFLICT" };

export type AcknowledgeExportResult =
  | { readonly kind: "ACKNOWLEDGED"; readonly replayed: boolean }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "PAYLOAD_HASH_MISMATCH" }
  | { readonly kind: "IDEMPOTENCY_CONFLICT" };

export type RetractFindThatProjectResult =
  | {
      readonly kind: "RETRACTED";
      readonly revision: ExportOutboxRevision;
      readonly replayed: boolean;
    }
  | { readonly kind: "NOT_EXPORTED" };

export interface FindThatProjectExportRepository {
  requestReview(
    input: RequestFindThatProjectReviewInput,
  ): Promise<RequestFindThatProjectReviewResult>;
  approveReview(
    input: ApproveFindThatProjectReviewInput,
  ): Promise<ApproveFindThatProjectReviewResult>;
  listPending(
    limit: number,
    after: { readonly createdAt: Date; readonly id: string } | null,
  ): Promise<ExportOutboxPage>;
  acknowledge(input: {
    readonly exportId: ExportId;
    readonly revision: number;
    readonly payloadHash: string;
    readonly idempotencyKey: string;
    readonly consumerId: string;
  }): Promise<AcknowledgeExportResult>;
  retract(
    discoveryId: DiscoveryId,
    reason: FindThatProjectRetractionReason,
  ): Promise<RetractFindThatProjectResult>;
  retractForComment(
    commentId: HnItemId,
    reason: FindThatProjectRetractionReason,
  ): Promise<number>;
}
