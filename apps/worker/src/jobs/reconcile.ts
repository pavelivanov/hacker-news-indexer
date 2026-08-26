import { createReconcileHnItem } from "@hn-knowledge/application";
import { hnItemId, type PipelineJob } from "@hn-knowledge/domain";
import type {
  Hasher,
  HnItems,
  FindThatProjectExportRepository,
  HnReconciliationRepository,
} from "@hn-knowledge/ports";

import { WorkerJobError } from "./errors.js";

export type ReconcileHnJobHandler = (job: PipelineJob) => Promise<void>;

export const createReconcileHnJobHandler = (
  items: HnItems,
  repository: HnReconciliationRepository,
  hasher: Hasher,
  exports: Pick<
    FindThatProjectExportRepository,
    "retractForComment"
  > | null = null,
): ReconcileHnJobHandler => {
  const reconcile = createReconcileHnItem(items, repository, hasher);
  return async (job): Promise<void> => {
    const selectedCommentId = job.payload["selectedCommentId"];
    if (typeof selectedCommentId !== "number") {
      throw new WorkerJobError("INVALID_RECONCILE_PAYLOAD", false);
    }
    try {
      const result = await reconcile(hnItemId(selectedCommentId));
      if (result.changed && exports !== null) {
        await exports.retractForComment(
          hnItemId(selectedCommentId),
          result.outcome === "TOMBSTONED"
            ? "CONTENT_UNAVAILABLE"
            : "CONTENT_CHANGED",
        );
      }
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
