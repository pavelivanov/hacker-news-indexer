import { createReconcileHnItem } from "@hn-knowledge/application";
import { hnItemId, type PipelineJob } from "@hn-knowledge/domain";
import type {
  Hasher,
  HnItems,
  HnReconciliationRepository,
} from "@hn-knowledge/ports";

import { WorkerJobError } from "./errors.js";

export type ReconcileHnJobHandler = (job: PipelineJob) => Promise<void>;

export const createReconcileHnJobHandler = (
  items: HnItems,
  repository: HnReconciliationRepository,
  hasher: Hasher,
): ReconcileHnJobHandler => {
  const reconcile = createReconcileHnItem(items, repository, hasher);
  return async (job): Promise<void> => {
    const selectedCommentId = job.payload["selectedCommentId"];
    if (typeof selectedCommentId !== "number") {
      throw new WorkerJobError("INVALID_RECONCILE_PAYLOAD", false);
    }
    try {
      await reconcile(hnItemId(selectedCommentId));
    } catch (error) {
      if (error instanceof TypeError) {
        throw new WorkerJobError("INVALID_RECONCILE_PAYLOAD", false, null, {
          cause: error,
        });
      }
      throw error;
    }
  };
};
