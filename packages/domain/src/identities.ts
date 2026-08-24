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
