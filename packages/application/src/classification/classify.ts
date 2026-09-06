import {
  ClassificationV1Schema,
  type ClassificationV1,
} from "@hn-knowledge/contracts";
import {
  UNPROMOTED_MODEL_REVIEW_DECISION,
  reviewPolicyFromReasons,
  type ReviewReasonCode,
  type ClassificationRun,
  type ContentDecision,
  type HnItemId,
} from "@hn-knowledge/domain";
import {
  ClassifierProviderError,
  type BoundedClassifierInput,
  type ClassificationRepository,
  type ClassifierPort,
  type ClassifierResponse,
  type Hasher,
} from "@hn-knowledge/ports";

import {
  CLASSIFICATION_PROMPT_VERSION,
  CLASSIFICATION_SYSTEM_PROMPT,
} from "./prompt.js";
import { routeClassificationDecision } from "./decision-router.js";
import {
  validateClassifierOutput,
  type ClassifierOutputValidationErrorCode,
} from "./validate-output.js";
import type { OpenPolicyReviewInput } from "../review/review-service.js";

export const CLASSIFIER_REQUEST_TIMEOUT_MS = 45_000;
export const CLASSIFICATION_SCHEMA_VERSION = "classification.v1";

export class ClassificationExecutionError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "ClassificationExecutionError";
  }
}

export interface ClassifyCommentInput {
  readonly attempt?: number;
  readonly signal?: AbortSignal;
  readonly commentId: HnItemId;
  readonly boundedInput: BoundedClassifierInput;
  readonly persistRetryableFailure?: boolean;
}

export type ClassifyCommentResult =
  | {
      readonly kind: "DECISION";
      readonly run: ClassificationRun;
      readonly decision: ContentDecision;
      readonly output: ClassificationV1;
    }
  | {
      readonly kind: "REVIEW";
      readonly run: ClassificationRun;
      readonly errorCode: ClassifierOutputValidationErrorCode;
    };

export interface ClassificationReviewQueue {
  readonly openPolicyReview: (input: OpenPolicyReviewInput) => Promise<unknown>;
}

const sumUsage = (
  responses: readonly ClassifierResponse[],
  field:
    | "inputTokens"
    | "cachedInputTokens"
    | "cacheWriteInputTokens"
    | "outputTokens",
): number | null => {
  const values = responses.map((response) => response[field]);
  if (values.length === 0 || values.some((value) => value === null)) {
    return null;
  }
  return (values as number[]).reduce((total, value) => total + value, 0);
};

const assertMetadata = (
  classifier: ClassifierPort,
  response: ClassifierResponse,
): void => {
  if (
    response.provider !== classifier.provider ||
    response.modelId !== classifier.modelId ||
    response.modelConfigId !== classifier.modelConfigId
  ) {
    throw new ClassificationExecutionError(
      "CLASSIFIER_METADATA_MISMATCH",
      false,
    );
  }
};

const retryableValidation = (
  code: ClassifierOutputValidationErrorCode,
): boolean => code === "JSON_INVALID" || code === "SCHEMA_INVALID";

const outputReviewReason = (
  reason: ClassificationV1["review"]["reasons"][number],
): ReviewReasonCode => {
  switch (reason) {
    case "UNAVAILABLE_CONTENT":
      return "DELETED_OR_FLAGGED_CONTENT";
    case "INVALID_EVIDENCE_SPAN":
      return "CONFLICTING_EVIDENCE_ORIGIN";
    case "UNSUPPORTED_URL":
      return "MISSING_CANONICAL_URL";
    default:
      return reason;
  }
};

export const createClassifyComment =
  (
    classifier: ClassifierPort,
    repository: ClassificationRepository,
    hasher: Hasher,
    reviewQueue: ClassificationReviewQueue | null,
  ) =>
  async (input: ClassifyCommentInput): Promise<ClassifyCommentResult> => {
    if (input.boundedInput.selectedCommentId !== input.commentId) {
      throw new TypeError("Classifier input comment ID does not match job");
    }
    const inputHash = hasher.sha256(JSON.stringify(input.boundedInput));
    const promptHash = hasher.sha256(CLASSIFICATION_SYSTEM_PROMPT);
    const request = {
      input: input.boundedInput,
      prompt: CLASSIFICATION_SYSTEM_PROMPT,
      promptVersion: CLASSIFICATION_PROMPT_VERSION,
      promptHash,
      schemaVersion: CLASSIFICATION_SCHEMA_VERSION,
      outputSchema: ClassificationV1Schema as unknown as Readonly<
        Record<string, unknown>
      >,
      timeoutMs: CLASSIFIER_REQUEST_TIMEOUT_MS,
      ...(input.signal ? { signal: input.signal } : {}),
    } as const;
    const responses: ClassifierResponse[] = [];
    let invalidCode: ClassifierOutputValidationErrorCode | null = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      input.signal?.throwIfAborted();
      let response: ClassifierResponse;
      try {
        response = await classifier.classify(request);
      } catch (error) {
        if (input.signal?.aborted)
          throw new ClassificationExecutionError(
            "CLASSIFIER_CANCELLED",
            true,
            null,
            { cause: error },
          );
        const providerError =
          error instanceof ClassifierProviderError
            ? error
            : new ClassifierProviderError(
                "CLASSIFIER_INVALID_RESPONSE",
                false,
                null,
                { cause: error },
              );
        if (
          !providerError.retryable ||
          input.persistRetryableFailure === true
        ) {
          await repository.recordRun({
            attempt: input.attempt ?? 1,
            commentId: input.commentId,
            inputHash,
            promptVersion: CLASSIFICATION_PROMPT_VERSION,
            promptHash,
            schemaVersion: CLASSIFICATION_SCHEMA_VERSION,
            modelConfigId: classifier.modelConfigId,
            provider: classifier.provider,
            modelId: classifier.modelId,
            outputHash: null,
            providerOutput: null,
            latencyMs: null,
            inputTokens: null,
            cachedInputTokens: null,
            cacheWriteInputTokens: null,
            outputTokens: null,
            status: "FAILED",
            errorCode: providerError.code,
          });
        }
        throw new ClassificationExecutionError(
          providerError.code,
          providerError.retryable,
          providerError.retryAfterMs,
          { cause: error },
        );
      }
      assertMetadata(classifier, response);
      responses.push(response);
      const validated = validateClassifierOutput(
        response.rawOutput,
        input.boundedInput,
        hasher,
      );
      if (!validated.ok) {
        invalidCode = validated.code;
        if (attempt === 0 && retryableValidation(validated.code)) {
          continue;
        }
        const recorded = await repository.recordRun({
          attempt: input.attempt ?? 1,
          commentId: input.commentId,
          inputHash,
          promptVersion: CLASSIFICATION_PROMPT_VERSION,
          promptHash,
          schemaVersion: CLASSIFICATION_SCHEMA_VERSION,
          modelConfigId: response.modelConfigId,
          provider: response.provider,
          modelId: response.modelId,
          outputHash: hasher.sha256(response.rawOutput),
          providerOutput: responses.map((value) => value.rawOutput),
          latencyMs: responses.reduce(
            (total, value) => total + value.latencyMs,
            0,
          ),
          inputTokens: sumUsage(responses, "inputTokens"),
          cachedInputTokens: sumUsage(responses, "cachedInputTokens"),
          cacheWriteInputTokens: sumUsage(responses, "cacheWriteInputTokens"),
          outputTokens: sumUsage(responses, "outputTokens"),
          status: "REVIEW",
          errorCode: validated.code,
        });
        return {
          kind: "REVIEW",
          run: recorded.run,
          errorCode: validated.code,
        };
      }

      const providerOutput = validated.output;
      const route = routeClassificationDecision(providerOutput);
      const output = route.output;
      const reviewPolicy = reviewPolicyFromReasons([
        ...UNPROMOTED_MODEL_REVIEW_DECISION.reasons,
        ...output.review.reasons.map(outputReviewReason),
      ]);
      const recorded = await repository.recordRun({
        attempt: input.attempt ?? 1,
        commentId: input.commentId,
        inputHash,
        promptVersion: CLASSIFICATION_PROMPT_VERSION,
        promptHash,
        schemaVersion: CLASSIFICATION_SCHEMA_VERSION,
        modelConfigId: response.modelConfigId,
        provider: response.provider,
        modelId: response.modelId,
        outputHash: hasher.sha256(response.rawOutput),
        providerOutput,
        latencyMs: responses.reduce(
          (total, value) => total + value.latencyMs,
          0,
        ),
        inputTokens: sumUsage(responses, "inputTokens"),
        cachedInputTokens: sumUsage(responses, "cachedInputTokens"),
        cacheWriteInputTokens: sumUsage(responses, "cacheWriteInputTokens"),
        outputTokens: sumUsage(responses, "outputTokens"),
        status: reviewPolicy.required ? "REVIEW" : "SUCCEEDED",
        errorCode: null,
      });
      // A concurrent/replayed call must derive its decision from the run that
      // actually won persistence, never from the losing provider response.
      const persisted = recorded.created
        ? validated
        : validateClassifierOutput(
            JSON.stringify(recorded.run.providerOutput),
            input.boundedInput,
            hasher,
          );
      if (recorded.run.errorCode !== null || !persisted.ok)
        throw new ClassificationExecutionError(
          "CLASSIFIER_RUN_CONFLICT",
          false,
        );
      const persistedRoute = routeClassificationDecision(persisted.output);
      const persistedOutput = persistedRoute.output;
      const routedEvidenceSpanIds = new Set(persistedRoute.evidenceSpanIds);
      const persistedPolicy = reviewPolicyFromReasons([
        ...UNPROMOTED_MODEL_REVIEW_DECISION.reasons,
        ...persistedOutput.review.reasons.map(outputReviewReason),
      ]);
      const decision = await repository.saveDecision({
        commentId: input.commentId,
        classificationRunId: recorded.run.id,
        source: "MODEL",
        primaryDecision: persistedOutput.primary_decision,
        decisionConfidence: persistedOutput.decision_confidence,
        materiallyTechnical:
          persistedOutput.comment_relevance.is_materially_technical,
        reviewRequired: persistedPolicy.required,
        validatedOutput: persistedOutput,
        manualOverrideOfId: null,
        evidenceSpans: persisted.evidenceSpans
          .filter((span) => routedEvidenceSpanIds.has(span.id))
          .map((span) => ({
            spanId: span.id,
            sourceDocument: span.documentId,
            origin: span.origin,
            start: span.start,
            end: span.end,
            textHash: span.textHash,
          })),
      });
      if (reviewQueue !== null) {
        await reviewQueue.openPolicyReview({
          commentId: input.commentId,
          contentDecisionId: decision.id,
          policy: persistedPolicy,
        });
      }
      return {
        kind: "DECISION",
        run: recorded.run,
        decision,
        output: persistedOutput,
      };
    }

    throw new ClassificationExecutionError(
      invalidCode ?? "CLASSIFIER_INVALID_RESPONSE",
      false,
    );
  };
