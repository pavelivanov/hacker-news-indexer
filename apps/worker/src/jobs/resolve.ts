import {
  createResolveSelectedComment,
  type HnParentChainResolver,
} from "@hn-knowledge/application";
import { hnItemId, type PipelineJob } from "@hn-knowledge/domain";
import type {
  Clock,
  Hasher,
  HnResolutionRepository,
  OccurrenceRepository,
} from "@hn-knowledge/ports";

import { WorkerJobError } from "./errors.js";

export type ResolverProvider = (runId: string) => HnParentChainResolver;
export type ResolveJobHandler = (job: PipelineJob) => Promise<void>;

export const createResolveJobHandler =
  (
    resolverFor: ResolverProvider,
    occurrences: OccurrenceRepository,
    resolutions: HnResolutionRepository,
    clock: Clock,
    hasher: Hasher,
  ): ResolveJobHandler =>
  async (job): Promise<void> => {
    if (job.ingestionRunId === null) {
      throw new WorkerJobError("RESOLVE_JOB_WITHOUT_RUN", false);
    }
    const selectedCommentId = job.payload["selectedCommentId"];
    if (typeof selectedCommentId !== "number") {
      throw new WorkerJobError("INVALID_RESOLVE_PAYLOAD", false);
    }
    let selectedId;
    try {
      selectedId = hnItemId(selectedCommentId);
    } catch (error) {
      throw new WorkerJobError("INVALID_RESOLVE_PAYLOAD", false, null, {
        cause: error,
      });
    }
    await createResolveSelectedComment(
      resolverFor(job.ingestionRunId),
      occurrences,
      resolutions,
      clock,
      hasher,
    )({ runId: job.ingestionRunId, selectedCommentId: selectedId });
  };
