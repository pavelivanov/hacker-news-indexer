import {
  ClassificationExecutionError,
  createClassifyComment,
  loadClassifierInput,
  type ClassificationReviewQueue,
} from "@hn-knowledge/application";
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
    try {
      await classify({
        commentId: selectedId,
        boundedInput: input,
        persistRetryableFailure: job.attempts >= maximumAttempts,
      });
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
    }
  };
};
