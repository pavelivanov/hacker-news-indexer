import type {
  HnItem,
  MultipartPart,
  MultipartReconstruction,
  ResolutionPath,
  SelectedComment,
  UrlCandidate,
} from "@hn-knowledge/domain";
import type { HnResolutionRepository } from "@hn-knowledge/ports";

import type { PrismaClient } from "../generated/prisma/client.js";

export const createHnResolutionRepository = (
  client: PrismaClient,
): HnResolutionRepository => ({
  async saveItem(item: HnItem): Promise<void> {
    const retainedHtml =
      item.availability === "AVAILABLE" ? item.textHtml : null;
    await client.$transaction(async (transaction) => {
      await transaction.hnItem.upsert({
        where: { id: BigInt(item.id) },
        create: {
          id: BigInt(item.id),
          type: item.type,
          parentId: item.parentId === null ? null : BigInt(item.parentId),
          author: item.author,
          time: item.time,
          title: item.title,
          textHtml: retainedHtml,
          textPlain: null,
          url: item.url,
          availability: item.availability,
          fetchedAt: item.fetchedAt,
          responseHash: item.responseHash,
        },
        update: {
          type: item.type,
          parentId: item.parentId === null ? null : BigInt(item.parentId),
          author: item.author,
          time: item.time,
          title: item.title,
          textHtml: retainedHtml,
          ...(item.availability === "AVAILABLE" ? {} : { textPlain: null }),
          url: item.url,
          availability: item.availability,
          fetchedAt: item.fetchedAt,
          responseHash: item.responseHash,
        },
      });
      await transaction.hnItemRevision.upsert({
        where: {
          hnItemId_responseHash: {
            hnItemId: BigInt(item.id),
            responseHash: item.responseHash,
          },
        },
        create: {
          hnItemId: BigInt(item.id),
          type: item.type,
          parentId: item.parentId === null ? null : BigInt(item.parentId),
          title: item.title,
          textHtml: retainedHtml,
          textPlain: null,
          url: item.url,
          availability: item.availability,
          responseHash: item.responseHash,
          observedAt: item.fetchedAt,
        },
        update: { observedAt: item.fetchedAt },
      });
    });
  },

  async saveResolution(
    path: ResolutionPath,
    selected: SelectedComment,
    urlCandidates: readonly UrlCandidate[],
  ): Promise<void> {
    await client.$transaction(async (transaction) => {
      const previous = await transaction.selectedComment.findUnique({
        where: { id: BigInt(selected.id) },
        include: { resolutionPath: true },
      });
      await transaction.selectedComment.upsert({
        where: { id: BigInt(selected.id) },
        create: {
          id: BigInt(selected.id),
          rootId: BigInt(selected.rootId),
          canonicalHtml: selected.canonicalHtml,
          canonicalText: selected.canonicalText,
          contentHash: selected.contentHash,
          availability: selected.availability,
          firstSeenAt: selected.firstSeenAt,
          lastSeenAt: selected.lastSeenAt,
        },
        update: {
          rootId: BigInt(selected.rootId),
          canonicalHtml: selected.canonicalHtml,
          canonicalText: selected.canonicalText,
          contentHash: selected.contentHash,
          availability: selected.availability,
          lastSeenAt: selected.lastSeenAt,
        },
      });
      await transaction.resolutionPath.upsert({
        where: { selectedCommentId: BigInt(path.selectedCommentId) },
        create: {
          selectedCommentId: BigInt(path.selectedCommentId),
          ancestorIds: path.ancestorIds.map(BigInt),
          displayedStoryId:
            path.displayedStoryId === null
              ? null
              : BigInt(path.displayedStoryId),
          resolvedRootId: BigInt(path.resolvedRootId),
          resolverVersion: path.resolverVersion,
        },
        update: {
          ancestorIds: path.ancestorIds.map(BigInt),
          displayedStoryId:
            path.displayedStoryId === null
              ? null
              : BigInt(path.displayedStoryId),
          resolvedRootId: BigInt(path.resolvedRootId),
          resolverVersion: path.resolverVersion,
          resolvedAt: selected.lastSeenAt,
        },
      });
      const existingContentRevision =
        await transaction.selectedCommentRevision.findUnique({
          where: {
            selectedCommentId_contentHash: {
              selectedCommentId: BigInt(selected.id),
              contentHash: selected.contentHash,
            },
          },
        });
      if (existingContentRevision === null) {
        const aggregate = await transaction.selectedCommentRevision.aggregate({
          where: { selectedCommentId: BigInt(selected.id) },
          _max: { revision: true },
        });
        await transaction.selectedCommentRevision.updateMany({
          where: {
            selectedCommentId: BigInt(selected.id),
            supersededAt: null,
          },
          data: { supersededAt: selected.lastSeenAt },
        });
        await transaction.selectedCommentRevision.create({
          data: {
            selectedCommentId: BigInt(selected.id),
            revision: (aggregate._max.revision ?? 0) + 1,
            rootId: BigInt(selected.rootId),
            canonicalHtml: selected.canonicalHtml,
            canonicalText: selected.canonicalText,
            contentHash: selected.contentHash,
            availability: selected.availability,
            createdAt: selected.firstSeenAt,
          },
        });
      }
      const previousPath = previous?.resolutionPath;
      const nextAncestors = path.ancestorIds.map(BigInt);
      const pathChanged =
        previousPath === null ||
        previousPath === undefined ||
        previousPath.resolvedRootId !== BigInt(path.resolvedRootId) ||
        previousPath.displayedStoryId !==
          (path.displayedStoryId === null
            ? null
            : BigInt(path.displayedStoryId)) ||
        previousPath.ancestorIds.length !== nextAncestors.length ||
        previousPath.ancestorIds.some(
          (value, index) => value !== nextAncestors[index],
        );
      if (pathChanged) {
        const aggregate = await transaction.resolutionPathRevision.aggregate({
          where: { selectedCommentId: BigInt(selected.id) },
          _max: { revision: true },
        });
        await transaction.resolutionPathRevision.create({
          data: {
            selectedCommentId: BigInt(selected.id),
            revision: (aggregate._max.revision ?? 0) + 1,
            ancestorIds: nextAncestors,
            displayedStoryId:
              path.displayedStoryId === null
                ? null
                : BigInt(path.displayedStoryId),
            resolvedRootId: BigInt(path.resolvedRootId),
            resolverVersion: path.resolverVersion,
            resolvedAt: selected.lastSeenAt,
          },
        });
      }
      await transaction.hnItem.update({
        where: { id: BigInt(selected.id) },
        data: {
          textPlain:
            selected.availability === "AVAILABLE"
              ? selected.canonicalText
              : null,
        },
      });
      await transaction.urlCandidate.updateMany({
        where: {
          hnItemId: BigInt(selected.id),
          classifierEligible: true,
        },
        data: { classifierEligible: false },
      });
      for (const [sourceOrdinal, candidate] of urlCandidates.entries()) {
        await transaction.urlCandidate.upsert({
          where: {
            contentHash_sourceDocument_originField_sourceOrdinal: {
              contentHash: candidate.contentHash,
              sourceDocument: candidate.sourceDocument,
              originField: candidate.originField,
              sourceOrdinal,
            },
          },
          create: {
            hnItemId: BigInt(selected.id),
            rawUrl: candidate.rawUrl,
            canonicalUrl: candidate.canonicalUrl,
            sourceDocument: candidate.sourceDocument,
            originField: candidate.originField,
            scheme: candidate.scheme,
            host: candidate.host,
            validationState: candidate.validationState,
            contentHash: candidate.contentHash,
            sourceOrdinal,
            classifierEligible: true,
          },
          update: {
            hnItemId: BigInt(selected.id),
            rawUrl: candidate.rawUrl,
            canonicalUrl: candidate.canonicalUrl,
            scheme: candidate.scheme,
            host: candidate.host,
            validationState: candidate.validationState,
            classifierEligible: true,
          },
        });
      }
    });
  },

  async saveMultipart(
    reconstruction: MultipartReconstruction,
    parts: readonly MultipartPart[],
    snapshotHash: string | null,
  ): Promise<void> {
    await client.$transaction(async (transaction) => {
      const group = await transaction.multipartGroup.upsert({
        where: {
          selectedCommentId: BigInt(reconstruction.selectedCommentId),
        },
        create: {
          selectedCommentId: BigInt(reconstruction.selectedCommentId),
          expectedParts: reconstruction.expectedParts,
          state: reconstruction.state,
          snapshotHash,
        },
        update: {
          expectedParts: reconstruction.expectedParts,
          state: reconstruction.state,
          snapshotHash,
        },
      });
      await transaction.multipartPart.deleteMany({
        where: { groupId: group.id },
      });
      await transaction.multipartPart.createMany({
        data: parts.map((part) => ({
          groupId: group.id,
          occurrenceId: part.occurrenceId,
          partNo: part.part,
          observedTotal: part.total,
          fragmentHash: part.fragmentHash,
          fragmentSnapshot: null,
        })),
      });
    });
  },
});
