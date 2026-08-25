import type {
  HnItemId,
  IngestionRunId,
  MultipartPart,
  SelectedComment,
} from "@hn-knowledge/domain";
import type {
  Clock,
  Hasher,
  HnResolutionRepository,
  OccurrenceRepository,
  PipelineJobPublisher,
} from "@hn-knowledge/ports";

import { normalizeHnCommentHtml } from "../normalize/hn-html.js";
import { reconstructMultipart } from "../reconstruct/multipart.js";
import type { HnParentChainResolver } from "./parent-chain.js";

export interface ResolveSelectedCommentInput {
  readonly runId: IngestionRunId;
  readonly selectedCommentId: HnItemId;
}

export type ResolveSelectedComment = (
  input: ResolveSelectedCommentInput,
) => Promise<void>;

export interface SelectedCommentResolutionTelemetry {
  readonly rejectedUrls: (count: number) => void;
  readonly multipartIncomplete: () => void;
}

const telegramFragment = (text: string): string => {
  const headerEnd = text.indexOf("\n\n");
  const body = headerEnd < 0 ? text : text.slice(headerEnd + 2);
  return body.replace(/\n\n[^\n]+,\s[^\n]+\[(\d{1,2})\/(\d{1,2})\]\s*$/u, "");
};

export const createResolveSelectedComment =
  (
    resolver: HnParentChainResolver,
    occurrences: OccurrenceRepository,
    resolutions: HnResolutionRepository,
    clock: Clock,
    hasher: Hasher,
    jobs: PipelineJobPublisher,
    telemetry: SelectedCommentResolutionTelemetry | null = null,
  ): ResolveSelectedComment =>
  async (input): Promise<void> => {
    const contexts = await occurrences.listSelectedCommentOccurrences(
      input.runId,
      input.selectedCommentId,
    );
    if (contexts.length === 0) {
      throw new TypeError("Selected comment has no occurrence provenance");
    }
    const displayedStoryId =
      contexts.find((context) => context.displayedStoryId !== null)
        ?.displayedStoryId ?? null;
    const resolved = await resolver.resolve({
      selectedCommentId: input.selectedCommentId,
      displayedStoryId,
    });
    await Promise.all(
      resolved.fetchedItems.map(async (item) => resolutions.saveItem(item)),
    );

    const normalized = normalizeHnCommentHtml(
      resolved.selectedItem.textHtml ?? "",
      `hn:item:${resolved.selectedItem.id}`,
      hasher,
    );
    const now = clock.now();
    const selected: SelectedComment = {
      id: resolved.selectedItem.id,
      rootId: resolved.rootItem.id,
      canonicalHtml: normalized.canonicalHtml,
      canonicalText: normalized.canonicalText,
      contentHash: normalized.contentHash,
      availability: resolved.selectedItem.availability,
      firstSeenAt: now,
      lastSeenAt: now,
    };
    telemetry?.rejectedUrls(
      normalized.urlCandidates.filter(
        (candidate) => candidate.validationState === "REJECTED",
      ).length,
    );
    await resolutions.saveResolution(
      resolved.path,
      selected,
      normalized.urlCandidates,
    );

    const multipartContexts = contexts.filter(
      (context) => context.multipart !== null,
    );
    if (multipartContexts.length > 0) {
      const parts: MultipartPart[] = multipartContexts.map((context) => {
        if (
          context.multipart === null ||
          context.occurredAt === null ||
          context.text === null
        ) {
          throw new TypeError(
            "Multipart occurrence is missing its source snapshot",
          );
        }
        const fragment = telegramFragment(context.text);
        return {
          occurrenceId: context.occurrenceId,
          selectedCommentId: context.selectedCommentId,
          displayedStoryId: context.displayedStoryId,
          messageId: context.messageId,
          occurredAt: context.occurredAt,
          part: context.multipart.part,
          total: context.multipart.total,
          fragment,
          fragmentHash: hasher.sha256(fragment),
        };
      });
      const reconstruction = reconstructMultipart({
        selectedCommentId: input.selectedCommentId,
        canonicalText: normalized.canonicalText,
        parts,
      });
      if (reconstruction.state !== "COMPLETE_MATCH") {
        telemetry?.multipartIncomplete();
      }
      await resolutions.saveMultipart(
        reconstruction,
        parts,
        reconstruction.normalizedSnapshot === null
          ? null
          : hasher.sha256(reconstruction.normalizedSnapshot),
      );
    }

    await Promise.all(
      contexts.map(async (context) => {
        await occurrences.clearTelegramBody(context.occurrenceId);
        await occurrences.setStatus(context.occurrenceId, "RESOLVED");
      }),
    );

    await jobs.enqueue({
      type: "CLASSIFY_COMMENT",
      ingestionRunId: input.runId,
      payload: { selectedCommentId: input.selectedCommentId },
      idempotencyKey: `classify:${input.selectedCommentId}:${selected.contentHash}`,
    });
  };
