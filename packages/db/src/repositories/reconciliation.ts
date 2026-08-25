import { createHash } from "node:crypto";

import { hnItemId } from "@hn-knowledge/domain";
import type {
  ApplyHnReconciliationInput,
  HnReconciliationRepository,
  HnReconciliationResult,
} from "@hn-knowledge/ports";

import {
  Prisma,
  type PrismaClient,
  type HnReconciliationOutcome as DatabaseOutcome,
} from "../generated/prisma/client.js";

type Transaction = Prisma.TransactionClient;

const SCHEDULER_LOCK_ID = 807_131_580_195_932_401n;

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const requiredText = (value: string, field: string, maximum = 256): string => {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new TypeError(`${field} must contain 1 to ${maximum} characters`);
  }
  return normalized;
};

const positiveLimit = (value: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 10_000) {
    throw new TypeError("schedule limit must be between 1 and 10000");
  }
  return value;
};

const sameBigInts = (
  left: readonly bigint[],
  right: readonly bigint[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const replayResult = (outcome: DatabaseOutcome): HnReconciliationResult => ({
  outcome,
  changed: outcome !== "UNCHANGED",
  classificationEnqueued:
    outcome === "CONTENT_CHANGED" || outcome === "ROOT_CHANGED",
  reviewOpened: outcome !== "UNCHANGED",
  replayed: true,
});

const supersedePublications = async (
  transaction: Transaction,
  decisionId: string,
): Promise<void> => {
  await transaction.expertNote.updateMany({
    where: {
      contentDecisionId: decisionId,
      status: { not: "SUPERSEDED" },
    },
    data: {
      status: "SUPERSEDED",
      publicationRevision: { increment: 1 },
    },
  });
  const discoveryIds = await transaction.discoverySource.findMany({
    where: { contentDecisionId: decisionId },
    select: { discoveryId: true },
  });
  for (const discoveryId of new Set(
    discoveryIds.map((value) => value.discoveryId),
  )) {
    const sources = await transaction.discoverySource.findMany({
      where: { discoveryId },
      include: {
        selectedComment: {
          select: { activeDecisionId: true, availability: true },
        },
      },
    });
    const stillPublished = sources.some(
      (source) =>
        source.selectedComment.availability === "AVAILABLE" &&
        source.selectedComment.activeDecisionId === source.contentDecisionId,
    );
    if (!stillPublished) {
      await transaction.discovery.updateMany({
        where: { id: discoveryId, status: { not: "SUPERSEDED" } },
        data: {
          status: "SUPERSEDED",
          publicationRevision: { increment: 1 },
        },
      });
    }
  }
};

const openDivergenceReview = async (
  transaction: Transaction,
  input: {
    readonly commentId: bigint;
    readonly decisionId: string;
    readonly reasonCode:
      "TELEGRAM_HN_DIVERGENCE" | "DELETED_OR_FLAGGED_CONTENT";
    readonly commandSeed: string;
  },
): Promise<boolean> => {
  const suffix = sha256(input.commandSeed).slice(0, 32);
  const existingEvent = await transaction.manualOverrideEvent.findUnique({
    where: { commandKey: `reconcile-review:${suffix}` },
  });
  if (existingEvent !== null) {
    return true;
  }
  const previous = await transaction.reviewTask.findFirst({
    where: {
      contentDecisionId: input.decisionId,
      kind: "CONTENT_DECISION",
    },
    orderBy: [{ revision: "desc" }, { id: "asc" }],
  });
  if (previous?.state === "OPEN") {
    const reason = "Superseded by HN reconciliation";
    await transaction.manualOverrideEvent.create({
      data: {
        reviewTaskId: previous.id,
        commentId: input.commentId,
        action: "SUPERSEDED",
        previousDecisionId: input.decisionId,
        newDecisionId: null,
        actorId: "reconciliation",
        requestHash: sha256(`${input.commandSeed}:supersede`),
        previousValueHash: sha256(`review:${previous.id}:open`),
        newValueHash: sha256(`review:${previous.id}:superseded`),
        reason,
        commandKey: `reconcile-supersede:${suffix}`,
      },
    });
    await transaction.reviewTask.update({
      where: { id: previous.id },
      data: {
        state: "SUPERSEDED",
        version: { increment: 1 },
        resolutionReason: reason,
        resolvedBy: "reconciliation",
        resolvedAt: new Date(),
      },
    });
  }
  const revision = (previous?.revision ?? 0) + 1;
  const reason =
    input.reasonCode === "DELETED_OR_FLAGGED_CONTENT"
      ? "HN item became unavailable during reconciliation"
      : "HN content or parent context changed after publication";
  const task = await transaction.reviewTask.create({
    data: {
      commentId: input.commentId,
      contentDecisionId: input.decisionId,
      kind: "CONTENT_DECISION",
      priority:
        input.reasonCode === "DELETED_OR_FLAGGED_CONTENT" ? "CRITICAL" : "HIGH",
      reasonCodes: [input.reasonCode],
      revision,
      supersedesTaskId: previous?.id ?? null,
    },
  });
  await transaction.manualOverrideEvent.create({
    data: {
      reviewTaskId: task.id,
      commentId: input.commentId,
      action: revision === 1 ? "OPENED" : "REOPENED",
      previousDecisionId: input.decisionId,
      newDecisionId: null,
      actorId: "reconciliation",
      requestHash: sha256(input.commandSeed),
      previousValueHash: sha256(`decision:${input.decisionId}:active`),
      newValueHash: sha256(`decision:${input.decisionId}:invalidated`),
      reason,
      commandKey: `reconcile-review:${suffix}`,
    },
  });
  return true;
};

const invalidateDecision = async (
  transaction: Transaction,
  input: {
    readonly commentId: bigint;
    readonly decisionId: string | null;
    readonly reasonCode:
      "TELEGRAM_HN_DIVERGENCE" | "DELETED_OR_FLAGGED_CONTENT";
    readonly commandSeed: string;
  },
): Promise<boolean> => {
  if (input.decisionId === null) {
    return false;
  }
  await transaction.selectedComment.update({
    where: { id: input.commentId },
    data: { activeDecisionId: null },
  });
  await supersedePublications(transaction, input.decisionId);
  return openDivergenceReview(transaction, {
    commentId: input.commentId,
    decisionId: input.decisionId,
    reasonCode: input.reasonCode,
    commandSeed: input.commandSeed,
  });
};

const storeFetchedItem = async (
  transaction: Transaction,
  input: ApplyHnReconciliationInput,
  item: ApplyHnReconciliationInput["fetchedItems"][number],
): Promise<void> => {
  const isSelected = Number(item.id) === Number(input.selected.id);
  const retainedHtml = item.availability === "AVAILABLE" ? item.textHtml : null;
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
      textPlain: isSelected ? input.selected.canonicalText : null,
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
      ...(isSelected
        ? { textPlain: input.selected.canonicalText }
        : item.availability === "AVAILABLE"
          ? {}
          : { textPlain: null }),
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
      textPlain: isSelected ? input.selected.canonicalText : null,
      url: item.url,
      availability: item.availability,
      responseHash: item.responseHash,
      observedAt: item.fetchedAt,
    },
    update: { observedAt: item.fetchedAt },
  });
};

export const createHnReconciliationRepository = (
  client: PrismaClient,
): HnReconciliationRepository => ({
  async loadTarget(id) {
    const selected = await client.selectedComment.findUnique({
      where: { id: BigInt(id) },
      include: { item: true, resolutionPath: true },
    });
    if (selected?.resolutionPath === null || selected === null) {
      return null;
    }
    return {
      selectedCommentId: hnItemId(Number(selected.id)),
      displayedStoryId:
        selected.resolutionPath.displayedStoryId === null
          ? null
          : hnItemId(Number(selected.resolutionPath.displayedStoryId)),
      resolvedRootId: hnItemId(Number(selected.rootId)),
      contentHash: selected.contentHash,
      responseHash: selected.item.responseHash,
    };
  },

  async apply(input) {
    requiredText(input.idempotencyKey, "idempotencyKey");
    return client.$transaction(
      async (transaction): Promise<HnReconciliationResult> => {
        const replay = await transaction.hnReconciliationEvent.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (replay !== null) {
          return replayResult(replay.outcome);
        }
        const current = await transaction.selectedComment.findUniqueOrThrow({
          where: { id: BigInt(input.selected.id) },
          include: { item: true, resolutionPath: true },
        });
        if (current.resolutionPath === null) {
          throw new Error("RECONCILIATION_PATH_MISSING");
        }
        const storedItems = await transaction.hnItem.findMany({
          where: {
            id: { in: input.fetchedItems.map((item) => BigInt(item.id)) },
          },
          select: { id: true, responseHash: true, availability: true },
        });
        const storedById = new Map(
          storedItems.map((item) => [item.id, item] as const),
        );
        const contextChanged = input.fetchedItems.some((item) => {
          const previous = storedById.get(BigInt(item.id));
          return (
            previous === undefined ||
            previous.responseHash !== item.responseHash ||
            previous.availability !== item.availability
          );
        });
        const contentChanged =
          current.contentHash !== input.selected.contentHash;
        const pathChanged =
          current.resolutionPath.resolvedRootId !==
            BigInt(input.path.resolvedRootId) ||
          current.resolutionPath.displayedStoryId !==
            (input.path.displayedStoryId === null
              ? null
              : BigInt(input.path.displayedStoryId)) ||
          !sameBigInts(
            current.resolutionPath.ancestorIds,
            input.path.ancestorIds.map(BigInt),
          );
        const changed = contentChanged || pathChanged || contextChanged;
        const outcome: DatabaseOutcome = contentChanged
          ? "CONTENT_CHANGED"
          : pathChanged || contextChanged
            ? "ROOT_CHANGED"
            : "UNCHANGED";

        for (const item of input.fetchedItems) {
          await storeFetchedItem(transaction, input, item);
        }
        if (contentChanged) {
          const aggregate = await transaction.selectedCommentRevision.aggregate(
            {
              where: { selectedCommentId: BigInt(input.selected.id) },
              _max: { revision: true },
            },
          );
          await transaction.selectedCommentRevision.updateMany({
            where: {
              selectedCommentId: BigInt(input.selected.id),
              supersededAt: null,
            },
            data: { supersededAt: input.selected.lastSeenAt },
          });
          await transaction.selectedCommentRevision.create({
            data: {
              selectedCommentId: BigInt(input.selected.id),
              revision: (aggregate._max.revision ?? 0) + 1,
              rootId: BigInt(input.selected.rootId),
              canonicalHtml: input.selected.canonicalHtml,
              canonicalText: input.selected.canonicalText,
              contentHash: input.selected.contentHash,
              availability: input.selected.availability,
              createdAt: input.selected.lastSeenAt,
            },
          });
        }
        if (pathChanged) {
          const aggregate = await transaction.resolutionPathRevision.aggregate({
            where: { selectedCommentId: BigInt(input.selected.id) },
            _max: { revision: true },
          });
          await transaction.resolutionPathRevision.create({
            data: {
              selectedCommentId: BigInt(input.selected.id),
              revision: (aggregate._max.revision ?? 0) + 1,
              ancestorIds: input.path.ancestorIds.map(BigInt),
              displayedStoryId:
                input.path.displayedStoryId === null
                  ? null
                  : BigInt(input.path.displayedStoryId),
              resolvedRootId: BigInt(input.path.resolvedRootId),
              resolverVersion: input.path.resolverVersion,
              resolvedAt: input.selected.lastSeenAt,
            },
          });
        }
        await transaction.selectedComment.update({
          where: { id: BigInt(input.selected.id) },
          data: {
            rootId: BigInt(input.selected.rootId),
            canonicalHtml: input.selected.canonicalHtml,
            canonicalText: input.selected.canonicalText,
            contentHash: input.selected.contentHash,
            availability: input.selected.availability,
            lastSeenAt: input.selected.lastSeenAt,
          },
        });
        await transaction.resolutionPath.update({
          where: { selectedCommentId: BigInt(input.selected.id) },
          data: {
            ancestorIds: input.path.ancestorIds.map(BigInt),
            displayedStoryId:
              input.path.displayedStoryId === null
                ? null
                : BigInt(input.path.displayedStoryId),
            resolvedRootId: BigInt(input.path.resolvedRootId),
            resolverVersion: input.path.resolverVersion,
            resolvedAt: input.selected.lastSeenAt,
          },
        });

        if (contentChanged) {
          await transaction.urlCandidate.updateMany({
            where: {
              hnItemId: BigInt(input.selected.id),
              classifierEligible: true,
            },
            data: { classifierEligible: false },
          });
          for (const [
            sourceOrdinal,
            candidate,
          ] of input.urlCandidates.entries()) {
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
                hnItemId: BigInt(input.selected.id),
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
                canonicalUrl: candidate.canonicalUrl,
                scheme: candidate.scheme,
                host: candidate.host,
                validationState: candidate.validationState,
                classifierEligible: true,
              },
            });
          }
        }
        let reviewOpened = false;
        if (changed) {
          reviewOpened = await invalidateDecision(transaction, {
            commentId: BigInt(input.selected.id),
            decisionId: current.activeDecisionId,
            reasonCode: "TELEGRAM_HN_DIVERGENCE",
            commandSeed: input.idempotencyKey,
          });
          await transaction.pipelineJob.upsert({
            where: {
              idempotencyKey: `classify:${input.selected.id}:${input.selected.contentHash}`,
            },
            create: {
              type: "CLASSIFY_COMMENT",
              payload: { selectedCommentId: input.selected.id },
              idempotencyKey: `classify:${input.selected.id}:${input.selected.contentHash}`,
            },
            update: {},
          });
        }
        await transaction.hnReconciliationEvent.create({
          data: {
            selectedCommentId: BigInt(input.selected.id),
            outcome,
            previousResponseHash: current.item.responseHash,
            currentResponseHash:
              input.fetchedItems[0]?.responseHash ?? "unknown",
            previousContentHash: current.contentHash,
            currentContentHash: input.selected.contentHash,
            previousRootId: current.rootId,
            currentRootId: BigInt(input.selected.rootId),
            availability: input.selected.availability,
            idempotencyKey: input.idempotencyKey,
          },
        });
        return {
          outcome,
          changed,
          classificationEnqueued: changed,
          reviewOpened,
          replayed: false,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  },

  async tombstone(input) {
    requiredText(input.idempotencyKey, "idempotencyKey");
    return client.$transaction(
      async (transaction): Promise<HnReconciliationResult> => {
        const replay = await transaction.hnReconciliationEvent.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (replay !== null) {
          return replayResult(replay.outcome);
        }
        const current = await transaction.selectedComment.findUniqueOrThrow({
          where: { id: BigInt(input.selectedCommentId) },
          include: { item: true },
        });
        const tombstoneHash = sha256(
          `tombstone:${input.selectedCommentId}:${input.responseHash}:${input.availability}`,
        );
        await transaction.hnItem.update({
          where: { id: BigInt(input.selectedCommentId) },
          data: {
            ...(input.item === null
              ? {}
              : {
                  type: input.item.type,
                  parentId:
                    input.item.parentId === null
                      ? null
                      : BigInt(input.item.parentId),
                  author: input.item.author,
                  time: input.item.time,
                  title: input.item.title,
                }),
            textHtml: null,
            textPlain: null,
            url: null,
            availability: input.availability,
            fetchedAt: input.fetchedAt,
            responseHash: input.responseHash,
          },
        });
        await transaction.hnItemRevision.updateMany({
          where: { hnItemId: BigInt(input.selectedCommentId) },
          data: { textHtml: null, textPlain: null, url: null },
        });
        await transaction.hnItemRevision.upsert({
          where: {
            hnItemId_responseHash: {
              hnItemId: BigInt(input.selectedCommentId),
              responseHash: input.responseHash,
            },
          },
          create: {
            hnItemId: BigInt(input.selectedCommentId),
            type: input.item?.type ?? current.item.type,
            parentId:
              input.item?.parentId === null ||
              input.item?.parentId === undefined
                ? current.item.parentId
                : BigInt(input.item.parentId),
            title: input.item?.title ?? current.item.title,
            textHtml: null,
            textPlain: null,
            url: null,
            availability: input.availability,
            responseHash: input.responseHash,
            observedAt: input.fetchedAt,
          },
          update: {
            textHtml: null,
            textPlain: null,
            url: null,
            availability: input.availability,
            observedAt: input.fetchedAt,
          },
        });
        await transaction.selectedCommentRevision.updateMany({
          where: { selectedCommentId: BigInt(input.selectedCommentId) },
          data: {
            canonicalHtml: null,
            canonicalText: null,
            supersededAt: input.fetchedAt,
          },
        });
        const existingRevision =
          await transaction.selectedCommentRevision.findUnique({
            where: {
              selectedCommentId_contentHash: {
                selectedCommentId: BigInt(input.selectedCommentId),
                contentHash: tombstoneHash,
              },
            },
          });
        if (existingRevision === null) {
          const aggregate = await transaction.selectedCommentRevision.aggregate(
            {
              where: { selectedCommentId: BigInt(input.selectedCommentId) },
              _max: { revision: true },
            },
          );
          await transaction.selectedCommentRevision.create({
            data: {
              selectedCommentId: BigInt(input.selectedCommentId),
              revision: (aggregate._max.revision ?? 0) + 1,
              rootId: current.rootId,
              canonicalHtml: null,
              canonicalText: null,
              contentHash: tombstoneHash,
              availability: input.availability,
              createdAt: input.fetchedAt,
            },
          });
        }
        await transaction.selectedComment.update({
          where: { id: BigInt(input.selectedCommentId) },
          data: {
            canonicalHtml: "",
            canonicalText: "",
            contentHash: tombstoneHash,
            availability: input.availability,
            activeDecisionId: null,
            lastSeenAt: input.fetchedAt,
          },
        });
        await transaction.urlCandidate.updateMany({
          where: { hnItemId: BigInt(input.selectedCommentId) },
          data: { classifierEligible: false },
        });
        const reviewOpened = await invalidateDecision(transaction, {
          commentId: BigInt(input.selectedCommentId),
          decisionId: current.activeDecisionId,
          reasonCode: "DELETED_OR_FLAGGED_CONTENT",
          commandSeed: input.idempotencyKey,
        });
        await transaction.hnReconciliationEvent.create({
          data: {
            selectedCommentId: BigInt(input.selectedCommentId),
            outcome: "TOMBSTONED",
            previousResponseHash: current.item.responseHash,
            currentResponseHash: input.responseHash,
            previousContentHash: current.contentHash,
            currentContentHash: tombstoneHash,
            previousRootId: current.rootId,
            currentRootId: current.rootId,
            availability: input.availability,
            idempotencyKey: input.idempotencyKey,
          },
        });
        return {
          outcome: "TOMBSTONED",
          changed: true,
          classificationEnqueued: false,
          reviewOpened,
          replayed: false,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  },

  async schedule(scheduleKey, availableAt, rawLimit) {
    const key = requiredText(scheduleKey, "scheduleKey", 128);
    const limit = positiveLimit(rawLimit);
    if (Number.isNaN(availableAt.getTime())) {
      throw new TypeError("availableAt must be valid");
    }
    return client.$transaction(async (transaction) => {
      const lock = await transaction.$queryRaw<
        readonly { readonly acquired: boolean }[]
      >(
        Prisma.sql`SELECT pg_try_advisory_xact_lock(${SCHEDULER_LOCK_ID}) AS acquired`,
      );
      if (lock[0]?.acquired !== true) {
        return { lockAcquired: false, scheduled: 0 };
      }
      const comments = await transaction.selectedComment.findMany({
        select: { id: true },
        orderBy: { id: "asc" },
        take: limit,
      });
      const created = await transaction.pipelineJob.createMany({
        data: comments.map((comment) => ({
          type: "RECONCILE_HN_ITEM" as const,
          payload: { selectedCommentId: Number(comment.id) },
          idempotencyKey: `reconcile-schedule:${key}:${comment.id}`,
          availableAt,
        })),
        skipDuplicates: true,
      });
      return { lockAcquired: true, scheduled: created.count };
    });
  },
});
