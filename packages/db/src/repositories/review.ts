import { createHash } from "node:crypto";

import {
  REVIEW_REASON_CODES,
  contentDecisionId,
  hnItemId,
  manualOverrideEventId,
  reviewTaskId,
  type ManualOverrideEvent,
  type ReviewReasonCode,
  type ReviewTask,
} from "@hn-knowledge/domain";
import type {
  OpenReviewTaskInput,
  OpenReviewTaskResult,
  ResolveReviewTaskInput,
  ResolveReviewTaskResult,
  ReviewRepository,
} from "@hn-knowledge/ports";

import type {
  ManualOverrideEvent as DatabaseEvent,
  PrismaClient,
  ReviewTask as DatabaseTask,
} from "../generated/prisma/client.js";
import { Prisma } from "../generated/prisma/client.js";

type ReviewClient = Pick<PrismaClient, "manualOverrideEvent" | "reviewTask">;

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const hasPrismaErrorCode = (error: unknown, code: string): boolean =>
  error !== null &&
  typeof error === "object" &&
  "code" in error &&
  error.code === code;

const requiredText = (
  value: string,
  field: string,
  maximum: number,
): string => {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new TypeError(`${field} must contain 1 to ${maximum} characters`);
  }
  return normalized;
};

const positiveInteger = (value: number, field: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
};

const reasonCodes = (values: readonly string[]): ReviewReasonCode[] => {
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new TypeError("Review reason codes must be non-empty and unique");
  }
  return values.map((value) => {
    if (!REVIEW_REASON_CODES.includes(value as ReviewReasonCode)) {
      throw new TypeError(`Unknown review reason code: ${value}`);
    }
    return value as ReviewReasonCode;
  });
};

const toTask = (task: DatabaseTask): ReviewTask => ({
  id: reviewTaskId(task.id),
  commentId: hnItemId(Number(task.commentId)),
  contentDecisionId: contentDecisionId(task.contentDecisionId),
  state: task.state,
  priority: task.priority,
  reasonCodes: reasonCodes(task.reasonCodes),
  version: task.version,
  revision: task.revision,
  supersedesTaskId:
    task.supersedesTaskId === null ? null : reviewTaskId(task.supersedesTaskId),
  resolutionReason: task.resolutionReason,
  resolvedBy: task.resolvedBy,
  resolvedAt: task.resolvedAt,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
});

const toEvent = (event: DatabaseEvent): ManualOverrideEvent => ({
  id: manualOverrideEventId(event.id),
  reviewTaskId: reviewTaskId(event.reviewTaskId),
  commentId: hnItemId(Number(event.commentId)),
  action: event.action,
  previousDecisionId:
    event.previousDecisionId === null
      ? null
      : contentDecisionId(event.previousDecisionId),
  newDecisionId:
    event.newDecisionId === null
      ? null
      : contentDecisionId(event.newDecisionId),
  actorId: event.actorId,
  requestHash: event.requestHash,
  previousValueHash: event.previousValueHash,
  newValueHash: event.newValueHash,
  reason: event.reason,
  commandKey: event.commandKey,
  createdAt: event.createdAt,
});

const taskValueHash = (task: DatabaseTask): string =>
  sha256(
    JSON.stringify({
      id: task.id,
      state: task.state,
      priority: task.priority,
      reasonCodes: task.reasonCodes,
      version: task.version,
      revision: task.revision,
    }),
  );

const pointerHash = (decisionId: string | null): string =>
  sha256(JSON.stringify({ activeDecisionId: decisionId }));

const assertOpenInput = (input: OpenReviewTaskInput): void => {
  requiredText(input.actorId, "actorId", 128);
  requiredText(input.commandKey, "commandKey", 256);
  requiredText(input.requestHash, "requestHash", 256);
  requiredText(input.reason, "reason", 1_000);
  reasonCodes(input.reasonCodes);
};

const assertResolveInput = (input: ResolveReviewTaskInput): void => {
  positiveInteger(input.expectedVersion, "expectedVersion");
  requiredText(input.actorId, "actorId", 128);
  requiredText(input.commandKey, "commandKey", 256);
  requiredText(input.requestHash, "requestHash", 256);
  requiredText(input.reason, "reason", 1_000);
};

const sameReasons = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const findOpenResult = async (
  client: PrismaClient,
  input: OpenReviewTaskInput,
): Promise<OpenReviewTaskResult | null> => {
  const task = await client.reviewTask.findUnique({
    where: {
      contentDecisionId_revision: {
        contentDecisionId: input.contentDecisionId,
        revision: 1,
      },
    },
  });
  if (task === null) {
    return null;
  }
  if (
    task.commentId !== BigInt(input.commentId) ||
    task.priority !== input.priority ||
    !sameReasons(task.reasonCodes, input.reasonCodes)
  ) {
    throw new Error("REVIEW_TASK_IDEMPOTENCY_CONFLICT");
  }
  const event = await client.manualOverrideEvent.findFirst({
    where: { reviewTaskId: task.id, action: "OPENED" },
    orderBy: { createdAt: "asc" },
  });
  if (event === null) {
    throw new Error("REVIEW_TASK_OPEN_EVENT_MISSING");
  }
  return { task: toTask(task), event: toEvent(event), created: false };
};

const replayResolution = async (
  client: ReviewClient,
  input: ResolveReviewTaskInput,
): Promise<ResolveReviewTaskResult | null> => {
  const event = await client.manualOverrideEvent.findUnique({
    where: { commandKey: input.commandKey },
  });
  if (event === null) {
    return null;
  }
  const expectedAction = input.outcome;
  if (
    event.reviewTaskId !== input.taskId ||
    event.action !== expectedAction ||
    event.requestHash !== input.requestHash
  ) {
    return { kind: "IDEMPOTENCY_CONFLICT" };
  }
  const task = await client.reviewTask.findUnique({
    where: { id: input.taskId },
  });
  if (task === null) {
    throw new Error("REVIEW_EVENT_TASK_MISSING");
  }
  return {
    kind: "RESOLVED",
    task: toTask(task),
    event: toEvent(event),
    replayed: true,
  };
};

const resolutionAfterSerializationConflict = async (
  client: PrismaClient,
  input: ResolveReviewTaskInput,
): Promise<ResolveReviewTaskResult> => {
  const replay = await replayResolution(client, input);
  if (replay !== null) {
    return replay;
  }
  const current = await client.reviewTask.findUnique({
    where: { id: input.taskId },
    select: { state: true, version: true },
  });
  if (current === null) {
    return { kind: "NOT_FOUND" };
  }
  if (current.state !== "OPEN") {
    return { kind: "INVALID_STATE", state: current.state };
  }
  return { kind: "VERSION_CONFLICT", currentVersion: current.version };
};

export const createReviewRepository = (
  client: PrismaClient,
): ReviewRepository => ({
  async openTask(input) {
    assertOpenInput(input);
    const existing = await findOpenResult(client, input);
    if (existing !== null) {
      return existing;
    }
    try {
      return await client.$transaction(
        async (transaction) => {
          const decision = await transaction.contentDecision.findFirst({
            where: {
              id: input.contentDecisionId,
              commentId: BigInt(input.commentId),
              reviewRequired: true,
            },
          });
          if (decision === null) {
            throw new TypeError(
              "Review task decision must belong to the comment and require review",
            );
          }
          const selected = await transaction.selectedComment.findUniqueOrThrow({
            where: { id: BigInt(input.commentId) },
            select: { activeDecisionId: true },
          });
          const task = await transaction.reviewTask.create({
            data: {
              commentId: BigInt(input.commentId),
              contentDecisionId: input.contentDecisionId,
              priority: input.priority,
              reasonCodes: [...input.reasonCodes],
            },
          });
          const event = await transaction.manualOverrideEvent.create({
            data: {
              reviewTaskId: task.id,
              commentId: BigInt(input.commentId),
              action: "OPENED",
              previousDecisionId: selected.activeDecisionId,
              newDecisionId: selected.activeDecisionId,
              actorId: requiredText(input.actorId, "actorId", 128),
              requestHash: requiredText(input.requestHash, "requestHash", 256),
              previousValueHash: pointerHash(selected.activeDecisionId),
              newValueHash: taskValueHash(task),
              reason: requiredText(input.reason, "reason", 1_000),
              commandKey: requiredText(input.commandKey, "commandKey", 256),
            },
          });
          return { task: toTask(task), event: toEvent(event), created: true };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (hasPrismaErrorCode(error, "P2002")) {
        const raced = await findOpenResult(client, input);
        if (raced !== null) {
          return raced;
        }
      }
      throw error;
    }
  },

  async getTask(id) {
    const task = await client.reviewTask.findUnique({ where: { id } });
    return task === null ? null : toTask(task);
  },

  async listOpenTasks(limit, afterId) {
    positiveInteger(limit, "limit");
    if (limit > 100) {
      throw new TypeError("limit must not exceed 100");
    }
    const rows = await client.reviewTask.findMany({
      where: { state: "OPEN" },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }, { id: "asc" }],
      take: limit + 1,
      ...(afterId === null ? {} : { cursor: { id: afterId }, skip: 1 }),
    });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    return {
      items: items.map(toTask),
      nextCursor:
        hasMore && items.length > 0
          ? reviewTaskId(items[items.length - 1]?.id ?? "")
          : null,
    };
  },

  async resolveTask(input) {
    assertResolveInput(input);
    const replay = await replayResolution(client, input);
    if (replay !== null) {
      return replay;
    }
    try {
      return await client.$transaction(
        async (transaction): Promise<ResolveReviewTaskResult> => {
          const repeated = await replayResolution(transaction, input);
          if (repeated !== null) {
            return repeated;
          }
          const task = await transaction.reviewTask.findUnique({
            where: { id: input.taskId },
          });
          if (task === null) {
            return { kind: "NOT_FOUND" };
          }
          if (task.state !== "OPEN") {
            return { kind: "INVALID_STATE", state: task.state };
          }
          if (task.version !== input.expectedVersion) {
            return {
              kind: "VERSION_CONFLICT",
              currentVersion: task.version,
            };
          }
          const selected = await transaction.selectedComment.findUniqueOrThrow({
            where: { id: task.commentId },
            select: { activeDecisionId: true },
          });
          const resolvedAt = new Date();
          const updated = await transaction.reviewTask.updateMany({
            where: {
              id: input.taskId,
              state: "OPEN",
              version: input.expectedVersion,
            },
            data: {
              state: input.outcome,
              version: { increment: 1 },
              resolutionReason: requiredText(input.reason, "reason", 1_000),
              resolvedBy: requiredText(input.actorId, "actorId", 128),
              resolvedAt,
            },
          });
          if (updated.count !== 1) {
            const current = await transaction.reviewTask.findUniqueOrThrow({
              where: { id: input.taskId },
              select: { version: true },
            });
            return {
              kind: "VERSION_CONFLICT",
              currentVersion: current.version,
            };
          }
          const nextDecisionId =
            input.outcome === "APPROVED"
              ? task.contentDecisionId
              : selected.activeDecisionId;
          const event = await transaction.manualOverrideEvent.create({
            data: {
              reviewTaskId: task.id,
              commentId: task.commentId,
              action: input.outcome,
              previousDecisionId: selected.activeDecisionId,
              newDecisionId: nextDecisionId,
              actorId: requiredText(input.actorId, "actorId", 128),
              requestHash: requiredText(input.requestHash, "requestHash", 256),
              previousValueHash: pointerHash(selected.activeDecisionId),
              newValueHash: pointerHash(nextDecisionId),
              reason: requiredText(input.reason, "reason", 1_000),
              commandKey: requiredText(input.commandKey, "commandKey", 256),
            },
          });
          if (input.outcome === "APPROVED") {
            const approvalInvariant = await transaction.reviewTask.count({
              where: {
                id: task.id,
                state: "APPROVED",
                auditEvents: {
                  some: {
                    action: "APPROVED",
                    newDecisionId: task.contentDecisionId,
                  },
                },
              },
            });
            if (approvalInvariant !== 1) {
              throw new Error("REVIEW_APPROVAL_AUDIT_INVARIANT_FAILED");
            }
            await transaction.selectedComment.update({
              where: { id: task.commentId },
              data: { activeDecisionId: task.contentDecisionId },
            });
          }
          const resolvedTask = await transaction.reviewTask.findUniqueOrThrow({
            where: { id: task.id },
          });
          return {
            kind: "RESOLVED",
            task: toTask(resolvedTask),
            event: toEvent(event),
            replayed: false,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (hasPrismaErrorCode(error, "P2002")) {
        return (
          (await replayResolution(client, input)) ?? {
            kind: "IDEMPOTENCY_CONFLICT",
          }
        );
      }
      if (hasPrismaErrorCode(error, "P2034")) {
        return resolutionAfterSerializationConflict(client, input);
      }
      throw error;
    }
  },
});
