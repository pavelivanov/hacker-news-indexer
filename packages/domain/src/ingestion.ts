import type {
  HnItemId,
  IngestionRunId,
  SelectionOccurrenceId,
  TelegramMessageId,
} from "./identities.js";

export const SELECTION_SOURCES = ["TELEGRAM", "FIXTURE"] as const;
export type SelectionSourceKind = (typeof SELECTION_SOURCES)[number];

export const INGESTION_RUN_STATUSES = [
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "PARTIAL",
  "FAILED",
] as const;
export type IngestionRunStatus = (typeof INGESTION_RUN_STATUSES)[number];

export const OCCURRENCE_STATUSES = [
  "OBSERVED",
  "MISSING",
  "DELETED",
  "RESOLVED",
  "FAILED",
] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

export const HN_REFERENCE_ROLES = [
  "DISPLAYED_STORY_REFERENCE",
  "SELECTED_COMMENT",
  "INLINE_HN_REFERENCE",
] as const;
export type HnReferenceRole = (typeof HN_REFERENCE_ROLES)[number];

export const TELEGRAM_ENTITY_KINDS = [
  "url",
  "text_link",
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "code",
  "pre",
  "blockquote",
  "unknown",
] as const;
export type TelegramEntityKind = (typeof TELEGRAM_ENTITY_KINDS)[number];

export interface TelegramMessageEntity {
  readonly kind: TelegramEntityKind;
  readonly offset: number;
  readonly length: number;
  readonly url?: string;
}

export interface MultipartMarker {
  readonly part: number;
  readonly total: number;
}

export interface HnReferenceInput {
  readonly itemId: HnItemId;
  readonly role: HnReferenceRole;
  readonly entityOffset: number;
  readonly entityLength: number;
  readonly parseConfidence: number;
}

export interface SelectionOccurrenceInput {
  readonly source: SelectionSourceKind;
  readonly sourceKey: string;
  readonly externalId: TelegramMessageId;
  readonly occurredAt: Date | null;
  readonly editedAt: Date | null;
  readonly text: string | null;
  readonly contentHash: string | null;
  readonly entities: readonly TelegramMessageEntity[];
  readonly references: readonly HnReferenceInput[];
  readonly multipart: MultipartMarker | null;
  readonly status: OccurrenceStatus;
}

export interface SelectionOccurrence extends SelectionOccurrenceInput {
  readonly id: SelectionOccurrenceId;
  readonly ingestionRunId: IngestionRunId;
}

export interface IngestionRange {
  readonly source: SelectionSourceKind;
  readonly sourceKey: string;
  readonly minId: TelegramMessageId;
  readonly maxId: TelegramMessageId;
}

export interface IngestionRun {
  readonly id: IngestionRunId;
  readonly requestKey: string;
  readonly range: IngestionRange;
  readonly status: IngestionRunStatus;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
}

export interface SelectedOccurrenceContext {
  readonly occurrenceId: SelectionOccurrenceId;
  readonly messageId: TelegramMessageId;
  readonly selectedCommentId: HnItemId;
  readonly displayedStoryId: HnItemId | null;
  readonly occurredAt: Date | null;
  readonly text: string | null;
  readonly multipart: MultipartMarker | null;
}
