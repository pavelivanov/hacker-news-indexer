import {
  createResolveSelectedComment,
  type HnParentChainResolver,
} from "@hn-knowledge/application";
import type { PipelineMetrics } from "@hn-knowledge/config";
import { hnItemId, type PipelineJob } from "@hn-knowledge/domain";
import type {
  Clock,
  Hasher,
  HnResolutionRepository,
  OccurrenceRepository,
  PipelineJobPublisher,
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
    jobs: PipelineJobPublisher,
    metrics: PipelineMetrics | null = null,
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
      jobs,
      metrics === null
        ? null
        : {
            rejectedUrls: (count) => {
              if (count > 0) {
                metrics.increment("url_candidate_rejected_total", count);
              }
            },
            multipartIncomplete: () =>
              metrics.increment("multipart_incomplete_total"),
          },
    )({ runId: job.ingestionRunId, selectedCommentId: selectedId });
  };
