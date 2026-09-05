import { createHash } from "node:crypto";
import {
  ManualReviewError,
  type ManualDraft,
  type ManualDraftState,
} from "@hn-knowledge/domain";
import type {
  ManualDraftRepository,
  ManualInboxState,
  ManualReviewUnitOfWork,
} from "@hn-knowledge/ports";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { createClassificationRepository } from "./classification.js";
import { createReviewRepository } from "./review.js";
import { createSubjectMaterializationRepository } from "./subjects.js";
import { bindTransactionClient } from "../transaction-context.js";

type Row = Prisma.ManualReviewDraftGetPayload<{
  include: { decision: { select: { id: true } } };
}>;
const include = { decision: { select: { id: true } } } as const;
const toDraft = (row: Row): ManualDraft => ({
  id: row.id,
  commentId: Number(row.commentId),
  payload: row.payload,
  version: row.version,
  sourceHash: row.sourceHash,
  baseActiveDecisionId: row.baseActiveDecisionId,
  state: row.state as ManualDraftState,
  actorId: row.actorId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  decisionId: row.decision?.id ?? null,
});
const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
const retryable = (error: unknown): boolean => {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2034" || error.code === "P2002") return true;
  // adapter-pg reports raw SELECT ... FOR UPDATE conflicts as P2010 with the
  // PostgreSQL SQLSTATE nested in its driver cause, rather than as P2034.
  const adapter = object(error.meta?.["driverAdapterError"]);
  const state =
    object(adapter["cause"])["originalCode"] ?? error.meta?.["code"];
  return error.code === "P2010" && (state === "40001" || state === "40P01");
};

const stateFilter = (
  state: ManualInboxState,
): Prisma.SelectedCommentWhereInput => {
  if (state === "all") return {};
  if (state === "draft")
    return { manualReviewDraft: { is: { state: "DRAFT" } } };
  if (state === "unreviewed")
    return { activeDecisionId: null, manualReviewDraft: { is: null } };
  return {
    activeDecision: {
      is: {
        primaryDecision:
          state === "rejected" ? "REJECTED" : { not: "REJECTED" },
      },
    },
  };
};

const createDraftRepository = (
  client: Prisma.TransactionClient,
): ManualDraftRepository => ({
  async sourceState(commentId) {
    // Lock the canonical source before checking hashes. All writes and source
    // reads below use this transaction's serializable snapshot.
    await client.$queryRaw`SELECT id FROM selected_comments WHERE id = ${BigInt(commentId)} FOR UPDATE`;
    const selected = await client.selectedComment.findUnique({
      where: { id: BigInt(commentId) },
      include: { item: true, resolutionPath: true },
    });
    if (selected === null) return null;
    await client.$queryRaw`SELECT id FROM hn_items WHERE id IN (${selected.id}, ${selected.rootId}) ORDER BY id FOR UPDATE`;
    const root = await client.hnItem.findUnique({
      where: { id: selected.rootId },
    });
    return {
      commentId,
      rootId: Number(selected.rootId),
      activeDecisionId: selected.activeDecisionId,
      available:
        selected.availability === "AVAILABLE" &&
        selected.item.availability === "AVAILABLE" &&
        root?.availability === "AVAILABLE" &&
        selected.resolutionPath?.resolvedRootId === selected.rootId,
      fingerprint: digest({
        contentHash: selected.contentHash,
        availability: selected.availability,
        itemHash: selected.item.responseHash,
        itemAvailability: selected.item.availability,
        rootHash: root?.responseHash ?? null,
        rootAvailability: root?.availability ?? null,
        rootId: String(selected.rootId),
        resolvedRootId: String(selected.resolutionPath?.resolvedRootId ?? ""),
      }),
    };
  },
  async findForComment(commentId) {
    const row = await client.manualReviewDraft.findUnique({
      where: { commentId: BigInt(commentId) },
      include,
    });
    return row === null ? null : toDraft(row);
  },
  async get(id) {
    await client.$queryRaw`SELECT id FROM manual_review_drafts WHERE id = ${id}::uuid FOR UPDATE`;
    const row = await client.manualReviewDraft.findUnique({
      where: { id },
      include,
    });
    return row === null ? null : toDraft(row);
  },
  async create(input) {
    return toDraft(
      await client.manualReviewDraft.create({
        data: {
          ...input,
          commentId: BigInt(input.commentId),
          payload: {},
        },
        include,
      }),
    );
  },
  async save(input) {
    const changed = await client.manualReviewDraft.updateMany({
      where: { id: input.id, state: "DRAFT", version: input.expectedVersion },
      data: {
        payload: json(input.payload),
        sourceHash: input.sourceHash,
        actorId: input.actorId,
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1) throw new ManualReviewError("VERSION_CONFLICT");
    return toDraft(
      await client.manualReviewDraft.findUniqueOrThrow({
        where: { id: input.id },
        include,
      }),
    );
  },
  async finish(input) {
    const changed = await client.manualReviewDraft.updateMany({
      where: { id: input.id, state: "DRAFT", version: input.expectedVersion },
      data: {
        state: input.state,
        actorId: input.actorId,
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1) throw new ManualReviewError("VERSION_CONFLICT");
    return toDraft(
      await client.manualReviewDraft.findUniqueOrThrow({
        where: { id: input.id },
        include,
      }),
    );
  },
  async receipt(commandKey) {
    return client.manualReviewReceipt.findUnique({ where: { commandKey } });
  },
  async recordReceipt(receipt) {
    await client.manualReviewReceipt.create({
      data: { ...receipt, result: json(receipt.result) },
    });
  },
  async inbox(state, after) {
    const rows = await client.selectedComment.findMany({
      where: {
        AND: [
          stateFilter(state),
          after === null
            ? {}
            : {
                OR: [
                  { firstSeenAt: { gt: after.firstSeenAt } },
                  {
                    firstSeenAt: after.firstSeenAt,
                    id: { gt: BigInt(after.commentId) },
                  },
                ],
              },
        ],
      },
      include: {
        manualReviewDraft: true,
        activeDecision: true,
        item: true,
        resolutionPath: true,
      },
      orderBy: [{ firstSeenAt: "asc" }, { id: "asc" }],
      take: 21,
    });
    const roots = new Set(
      (
        await client.hnItem.findMany({
          where: {
            id: { in: rows.map((row) => row.rootId) },
            availability: "AVAILABLE",
          },
          select: { id: true },
        })
      ).map((row) => row.id),
    );
    return rows.map((row) => ({
      commentId: Number(row.id),
      firstSeenAt: row.firstSeenAt,
      excerpt: row.canonicalText.slice(0, 300),
      state:
        row.manualReviewDraft?.state === "DRAFT"
          ? "draft"
          : row.activeDecision === null
            ? "unreviewed"
            : row.activeDecision.primaryDecision === "REJECTED"
              ? "rejected"
              : "approved",
      available:
        row.availability === "AVAILABLE" &&
        row.item.availability === "AVAILABLE" &&
        row.resolutionPath?.resolvedRootId === row.rootId &&
        roots.has(row.rootId),
    }));
  },
});

export const createManualReviewUnitOfWork = (
  client: PrismaClient,
): ManualReviewUnitOfWork => ({
  async run(operation, draftId) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await client.$transaction(
          (transaction) => {
            bindTransactionClient(transaction);
            return operation({
              drafts: createDraftRepository(transaction),
              classifications: createClassificationRepository(
                transaction,
                draftId ?? null,
              ),
              subjects: createSubjectMaterializationRepository(transaction),
              review: createReviewRepository(transaction, draftId ?? null),
            });
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            timeout: 15_000,
          },
        );
      } catch (error) {
        if (attempt < 2 && retryable(error)) continue;
        throw error;
      }
    }
  },
});
