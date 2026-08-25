import type {
  ClassificationRunId,
  ContentDecisionId,
  HnItemId,
} from "./identities.js";

export const CLASSIFICATION_RUN_STATUSES = [
  "SUCCEEDED",
  "REVIEW",
  "FAILED",
] as const;
export type ClassificationRunStatus =
  (typeof CLASSIFICATION_RUN_STATUSES)[number];

export const CONTENT_DECISION_CLASSES = [
  "DISCOVERY",
  "EXPERT_NOTE",
  "REJECTED",
  "REVIEW",
] as const;
export type ContentDecisionClass = (typeof CONTENT_DECISION_CLASSES)[number];

export interface ClassificationRun {
  readonly id: ClassificationRunId;
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
  readonly createdAt: Date;
}

export interface EvidenceSpan {
  readonly id: string;
  readonly contentDecisionId: ContentDecisionId;
  readonly spanId: string;
  readonly sourceDocument: string;
  readonly origin: "COMMENT" | "ROOT_STORY";
  readonly start: number;
  readonly end: number;
  readonly textHash: string;
  readonly createdAt: Date;
}

export interface ContentDecision {
  readonly id: ContentDecisionId;
  readonly commentId: HnItemId;
  readonly classificationRunId: ClassificationRunId | null;
  readonly source: "MODEL" | "MANUAL";
  readonly primaryDecision: ContentDecisionClass;
  readonly decisionConfidence: number;
  readonly materiallyTechnical: boolean;
  readonly reviewRequired: boolean;
  readonly validatedOutput: unknown;
  readonly manualOverrideOfId: ContentDecisionId | null;
  readonly evidenceSpans: readonly EvidenceSpan[];
  readonly createdAt: Date;
}
