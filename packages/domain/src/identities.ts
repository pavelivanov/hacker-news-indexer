type Brand<Value, Name extends string> = Value & {
  readonly __brand: Name;
};

export type TelegramMessageId = Brand<number, "TelegramMessageId">;
export type HnItemId = Brand<number, "HnItemId">;
export type IngestionRunId = Brand<string, "IngestionRunId">;
export type SelectionOccurrenceId = Brand<string, "SelectionOccurrenceId">;
export type PipelineJobId = Brand<string, "PipelineJobId">;
export type ClassificationRunId = Brand<string, "ClassificationRunId">;
export type ContentDecisionId = Brand<string, "ContentDecisionId">;
export type ReviewTaskId = Brand<string, "ReviewTaskId">;
export type ManualOverrideEventId = Brand<string, "ManualOverrideEventId">;
export type SubjectId = Brand<string, "SubjectId">;
export type SubjectMentionId = Brand<string, "SubjectMentionId">;
export type DiscoveryId = Brand<string, "DiscoveryId">;
export type DiscoverySourceId = Brand<string, "DiscoverySourceId">;
export type ExpertNoteId = Brand<string, "ExpertNoteId">;
export type UrlCandidateId = Brand<string, "UrlCandidateId">;

const positiveSafeInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
};

const nonEmptyIdentifier = (value: string, name: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 128) {
    throw new TypeError(`${name} must contain 1 to 128 characters`);
  }
  return normalized;
};

export const telegramMessageId = (value: number): TelegramMessageId =>
  positiveSafeInteger(value, "Telegram message ID") as TelegramMessageId;

export const hnItemId = (value: number): HnItemId =>
  positiveSafeInteger(value, "HN item ID") as HnItemId;

export const ingestionRunId = (value: string): IngestionRunId =>
  nonEmptyIdentifier(value, "Ingestion run ID") as IngestionRunId;

export const selectionOccurrenceId = (value: string): SelectionOccurrenceId =>
  nonEmptyIdentifier(value, "Selection occurrence ID") as SelectionOccurrenceId;

export const pipelineJobId = (value: string): PipelineJobId =>
  nonEmptyIdentifier(value, "Pipeline job ID") as PipelineJobId;

export const classificationRunId = (value: string): ClassificationRunId =>
  nonEmptyIdentifier(value, "Classification run ID") as ClassificationRunId;

export const contentDecisionId = (value: string): ContentDecisionId =>
  nonEmptyIdentifier(value, "Content decision ID") as ContentDecisionId;

export const reviewTaskId = (value: string): ReviewTaskId =>
  nonEmptyIdentifier(value, "Review task ID") as ReviewTaskId;

export const manualOverrideEventId = (value: string): ManualOverrideEventId =>
  nonEmptyIdentifier(
    value,
    "Manual override event ID",
  ) as ManualOverrideEventId;

export const subjectId = (value: string): SubjectId =>
  nonEmptyIdentifier(value, "Subject ID") as SubjectId;

export const subjectMentionId = (value: string): SubjectMentionId =>
  nonEmptyIdentifier(value, "Subject mention ID") as SubjectMentionId;

export const discoveryId = (value: string): DiscoveryId =>
  nonEmptyIdentifier(value, "Discovery ID") as DiscoveryId;

export const discoverySourceId = (value: string): DiscoverySourceId =>
  nonEmptyIdentifier(value, "Discovery source ID") as DiscoverySourceId;

export const expertNoteId = (value: string): ExpertNoteId =>
  nonEmptyIdentifier(value, "Expert note ID") as ExpertNoteId;

export const urlCandidateId = (value: string): UrlCandidateId =>
  nonEmptyIdentifier(value, "URL candidate ID") as UrlCandidateId;
