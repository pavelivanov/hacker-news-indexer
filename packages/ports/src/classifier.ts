import type { CanonicalContentBlock, HnItemId } from "@hn-knowledge/domain";

export interface ClassifierInputUrlCandidate {
  readonly canonicalUrl: string | null;
  readonly sourceDocument: string;
  readonly originField: string;
  readonly validationState: "CANDIDATE" | "VALID" | "REJECTED";
}

export interface ClassifierInputSource {
  readonly selectedCommentId: HnItemId;
  readonly rootId: HnItemId;
  readonly commentText: string;
  readonly commentBlocks: readonly CanonicalContentBlock[];
  readonly rootTitle: string;
  readonly rootText: string;
  readonly rootBlocks: readonly CanonicalContentBlock[];
  readonly urlCandidates: readonly ClassifierInputUrlCandidate[];
}

export interface ClassifierInputSpan {
  readonly id: string;
  readonly documentId: string;
  readonly origin: "COMMENT" | "ROOT_STORY";
  readonly kind: "TEXT" | "CODE" | "TITLE";
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly text: string;
}

export interface ClassifierInputDocument {
  readonly id: string;
  readonly origin: "COMMENT" | "ROOT_STORY";
  readonly spans: readonly ClassifierInputSpan[];
}

export interface ClassifierTruncationEntry {
  readonly documentId: string;
  readonly originalLength: number;
  readonly includedRanges: readonly {
    readonly sourceStart: number;
    readonly sourceEnd: number;
  }[];
  readonly omittedRanges: readonly {
    readonly sourceStart: number;
    readonly sourceEnd: number;
  }[];
}

export interface BoundedClassifierInput {
  readonly schemaVersion: "classification-input.v1";
  readonly selectedCommentId: HnItemId;
  readonly rootId: HnItemId;
  readonly documents: readonly ClassifierInputDocument[];
  readonly urlCandidates: readonly {
    readonly id: string;
    readonly url: string;
    readonly sourceDocument: string;
    readonly originField: string;
  }[];
  readonly truncation: readonly ClassifierTruncationEntry[];
}

export interface StoredClassifierSource {
  readonly selectedCommentId: HnItemId;
  readonly rootId: HnItemId;
  readonly commentHtml: string;
  readonly commentText: string;
  readonly rootTitle: string;
  readonly rootHtml: string;
  readonly rootUrl: string | null;
  readonly commentUrlCandidates: readonly ClassifierInputUrlCandidate[];
}

export interface ClassifierRequest {
  readonly input: BoundedClassifierInput;
  readonly prompt: string;
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly schemaVersion: "classification.v1";
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
}

export interface ClassifierResponse {
  readonly rawOutput: string;
  readonly provider: string;
  readonly modelId: string;
  readonly modelConfigId: string;
  readonly latencyMs: number;
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly cacheWriteInputTokens: number | null;
  readonly outputTokens: number | null;
}

export const CLASSIFIER_PROVIDER_ERROR_CODES = [
  "CLASSIFIER_TIMEOUT",
  "CLASSIFIER_RATE_LIMIT",
  "CLASSIFIER_PROVIDER_5XX",
  "CLASSIFIER_AUTH",
  "CLASSIFIER_CONFIG",
  "CLASSIFIER_INVALID_RESPONSE",
] as const;
export type ClassifierProviderErrorCode =
  (typeof CLASSIFIER_PROVIDER_ERROR_CODES)[number];

export class ClassifierProviderError extends Error {
  constructor(
    readonly code: ClassifierProviderErrorCode,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "ClassifierProviderError";
  }
}

export interface ClassifierPort {
  readonly provider: string;
  readonly modelId: string;
  readonly modelConfigId: string;
  classify(request: ClassifierRequest): Promise<ClassifierResponse>;
}
