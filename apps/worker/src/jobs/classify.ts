import {
  ClassificationExecutionError,
  createClassifyComment,
  loadClassifierInput,
  type ClassificationReviewQueue,
} from "@hn-knowledge/application";
import type { PipelineMetrics } from "@hn-knowledge/config";
import { hnItemId, type PipelineJob } from "@hn-knowledge/domain";
import type {
  ClassificationRepository,
  ClassifierPort,
  Hasher,
} from "@hn-knowledge/ports";

import { WorkerJobError } from "./errors.js";

export type ClassifyJobHandler = (job: PipelineJob) => Promise<void>;

export const createClassifyJobHandler = (
  classifier: ClassifierPort | null,
  repository: ClassificationRepository,
  hasher: Hasher,
  reviewQueue: ClassificationReviewQueue,
  maximumAttempts: number,
  metrics: PipelineMetrics | null = null,
): ClassifyJobHandler => {
  const classify =
    classifier === null
      ? null
      : createClassifyComment(classifier, repository, hasher, reviewQueue);
  return async (job): Promise<void> => {
    if (classify === null) {
      throw new WorkerJobError("CLASSIFIER_DISABLED", false);
    }
    const selectedCommentId = job.payload["selectedCommentId"];
    if (typeof selectedCommentId !== "number") {
      throw new WorkerJobError("INVALID_CLASSIFY_PAYLOAD", false);
    }
    let selectedId;
    try {
      selectedId = hnItemId(selectedCommentId);
    } catch (error) {
      throw new WorkerJobError("INVALID_CLASSIFY_PAYLOAD", false, null, {
        cause: error,
      });
    }
    const input = await loadClassifierInput(selectedId, repository, hasher);
    metrics?.increment("classification_total");
    const startedAt = Date.now();
    try {
      const result = await classify({
        commentId: selectedId,
        boundedInput: input,
        persistRetryableFailure: job.attempts >= maximumAttempts,
      });
      if (
        result.kind === "REVIEW" &&
        result.errorCode.toLowerCase().includes("schema")
      ) {
        metrics?.increment("classification_schema_error_total");
      }
    } catch (error) {
      if (error instanceof ClassificationExecutionError) {
        throw new WorkerJobError(
          error.code,
          error.retryable,
          error.retryAfterMs,
          { cause: error },
        );
      }
      throw error;
    } finally {
      metrics?.observe(
        "classification_latency_seconds",
        (Date.now() - startedAt) / 1_000,
      );
    }
  };
};
