import {
  withTransaction,
  isTransactionClient,
  type RepositoryClient,
} from "../transaction-context.js";
import { createHash } from "node:crypto";

import {
  REVIEW_REASON_CODES,
  contentDecisionId,
  createSubjectIdentity,
  hnItemId,
  manualOverrideEventId,
  reviewTaskId,
  subjectId,
  urlCandidateId,
  type ManualOverrideEvent,
  type ReviewReasonCode,
  type ReviewTask,
} from "@hn-knowledge/domain";
import type {
  EntityReviewMutationResult,
  MergeSubjectsReviewInput,
  OpenReviewTaskInput,
  OpenReviewTaskResult,
  ResolveReviewTaskInput,
  ResolveReviewTaskResult,
  ResolveSubjectUrlReviewInput,
  ReopenReviewTaskInput,
  ReopenReviewTaskResult,
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
  kind: task.kind,
  targetKey: task.targetKey,
  targetSnapshotHash: task.targetSnapshotHash,
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
  affectedSubjectId:
    event.affectedSubjectId === null
      ? null
      : subjectId(event.affectedSubjectId),
  relatedSubjectId:
    event.relatedSubjectId === null ? null : subjectId(event.relatedSubjectId),
  previousUrlCandidateId:
    event.previousUrlCandidateId === null
      ? null
      : urlCandidateId(event.previousUrlCandidateId),
  newUrlCandidateId:
    event.newUrlCandidateId === null
      ? null
      : urlCandidateId(event.newUrlCandidateId),
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
      kind: task.kind,
      targetKey: task.targetKey,
      targetSnapshotHash: task.targetSnapshotHash,
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
  requiredText(input.targetKey, "targetKey", 256);
  if (input.targetSnapshotHash !== null) {
    requiredText(input.targetSnapshotHash, "targetSnapshotHash", 256);
  }
  reasonCodes(input.reasonCodes);
};

const assertCommandInput = (input: {
  readonly expectedVersion: number;
  readonly actorId: string;
  readonly commandKey: string;
  readonly requestHash: string;
  readonly reason: string;
}): void => {
  positiveInteger(input.expectedVersion, "expectedVersion");
  requiredText(input.actorId, "actorId", 128);
  requiredText(input.commandKey, "commandKey", 256);
  requiredText(input.requestHash, "requestHash", 256);
  requiredText(input.reason, "reason", 1_000);
};

const assertResolveInput = (input: ResolveReviewTaskInput): void => {
  assertCommandInput(input);
};

const sameReasons = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const findOpenResult = async (
  client: RepositoryClient,
  input: OpenReviewTaskInput,
): Promise<OpenReviewTaskResult | null> => {
  const task = await client.reviewTask.findUnique({
    where: {
      contentDecisionId_kind_targetKey_revision: {
        contentDecisionId: input.contentDecisionId,
        kind: input.kind,
        targetKey: input.targetKey,
        revision: 1,
      },
    },
  });
  if (task === null) {
    return null;
  }
  if (
    task.commentId !== BigInt(input.commentId) ||
    task.kind !== input.kind ||
    task.targetKey !== input.targetKey ||
    task.targetSnapshotHash !== input.targetSnapshotHash ||
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
  client: RepositoryClient,
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

const replayReopen = async (
  client: ReviewClient,
  input: ReopenReviewTaskInput,
): Promise<ReopenReviewTaskResult | null> => {
  const event = await client.manualOverrideEvent.findUnique({
    where: { commandKey: input.commandKey },
  });
  if (event === null) {
    return null;
  }
  if (event.action !== "REOPENED" || event.requestHash !== input.requestHash) {
    return { kind: "IDEMPOTENCY_CONFLICT" };
  }
  const task = await client.reviewTask.findUnique({
    where: { id: event.reviewTaskId },
  });
  if (task === null || task.supersedesTaskId !== input.taskId) {
    return { kind: "IDEMPOTENCY_CONFLICT" };
  }
  return {
    kind: "REOPENED",
    task: toTask(task),
    event: toEvent(event),
    replayed: true,
  };
};

const replayEntityMutation = async (
  client: ReviewClient,
  input: MergeSubjectsReviewInput | ResolveSubjectUrlReviewInput,
): Promise<EntityReviewMutationResult | null> => {
  const event = await client.manualOverrideEvent.findUnique({
    where: { commandKey: input.commandKey },
  });
  if (event === null) {
    return null;
  }
  const matches =
    event.reviewTaskId === input.taskId &&
    event.action === "APPROVED" &&
    event.requestHash === input.requestHash &&
    ("sourceSubjectId" in input
      ? event.affectedSubjectId === input.sourceSubjectId &&
        event.relatedSubjectId === input.targetSubjectId
      : event.affectedSubjectId === input.subjectId &&
        event.newUrlCandidateId === input.urlCandidateId);
  if (!matches) {
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

const taskMutationState = async (
  client: RepositoryClient,
  taskId: string,
): Promise<EntityReviewMutationResult> => {
  const task = await client.reviewTask.findUnique({
    where: { id: taskId },
    select: { state: true, version: true },
  });
  if (task === null) {
    return { kind: "NOT_FOUND" };
  }
  if (task.state !== "OPEN") {
    return { kind: "INVALID_STATE", state: task.state };
  }
  return { kind: "VERSION_CONFLICT", currentVersion: task.version };
};

const reopenState = async (
  client: RepositoryClient,
  taskId: string,
): Promise<ReopenReviewTaskResult> => {
  const task = await client.reviewTask.findUnique({
    where: { id: taskId },
    select: { state: true, version: true },
  });
  if (task === null) {
    return { kind: "NOT_FOUND" };
  }
  if (task.state === "OPEN") {
    return { kind: "INVALID_STATE", state: task.state };
  }
  return { kind: "VERSION_CONFLICT", currentVersion: task.version };
};

const completeEntityReview = async (
  transaction: Prisma.TransactionClient,
  task: DatabaseTask,
  input: MergeSubjectsReviewInput | ResolveSubjectUrlReviewInput,
  previousValueHash: string,
  newValueHash: string,
  entity: {
    readonly affectedSubjectId: string;
    readonly relatedSubjectId: string | null;
    readonly previousUrlCandidateId: string | null;
    readonly newUrlCandidateId: string | null;
  },
): Promise<EntityReviewMutationResult> => {
  const selected = await transaction.selectedComment.findUniqueOrThrow({
    where: { id: task.commentId },
    select: { activeDecisionId: true },
  });
  const resolvedAt = new Date();
  const updated = await transaction.reviewTask.updateMany({
    where: {
      id: task.id,
      state: "OPEN",
      version: input.expectedVersion,
    },
    data: {
      state: "APPROVED",
      version: { increment: 1 },
      resolutionReason: requiredText(input.reason, "reason", 1_000),
      resolvedBy: requiredText(input.actorId, "actorId", 128),
      resolvedAt,
    },
  });
  if (updated.count !== 1) {
    const current = await transaction.reviewTask.findUniqueOrThrow({
      where: { id: task.id },
      select: { version: true },
    });
    return { kind: "VERSION_CONFLICT", currentVersion: current.version };
  }
  const event = await transaction.manualOverrideEvent.create({
    data: {
      reviewTaskId: task.id,
      commentId: task.commentId,
      action: "APPROVED",
      previousDecisionId: selected.activeDecisionId,
      newDecisionId: task.contentDecisionId,
      ...entity,
      actorId: requiredText(input.actorId, "actorId", 128),
      requestHash: requiredText(input.requestHash, "requestHash", 256),
      previousValueHash,
      newValueHash,
      reason: requiredText(input.reason, "reason", 1_000),
      commandKey: requiredText(input.commandKey, "commandKey", 256),
    },
  });
  const resolved = await transaction.reviewTask.findUniqueOrThrow({
    where: { id: task.id },
  });
  return {
    kind: "RESOLVED",
    task: toTask(resolved),
    event: toEvent(event),
    replayed: false,
  };
};

export const createReviewRepository = (
  client: RepositoryClient,
  manualDraftId: string | null = null,
): ReviewRepository => ({
  async openTask(input) {
    assertOpenInput(input);
    const existing = await findOpenResult(client, input);
    if (existing !== null) {
      return existing;
    }
    try {
      return await withTransaction(
        client,
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
              kind: input.kind,
              targetKey: input.targetKey,
              targetSnapshotHash: input.targetSnapshotHash,
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
      if (isTransactionClient(client)) throw error;
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
      return await withTransaction(
        client,
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
          const owned = await transaction.contentDecision.findUnique({
            where: { id: task.contentDecisionId },
            select: { manualDraftId: true },
          });
          if (
            task.kind === "CONTENT_DECISION" &&
            owned?.manualDraftId != null &&
            (owned.manualDraftId !== manualDraftId ||
              !isTransactionClient(client))
          )
            return { kind: "POLICY_INVALID" };
          if (task.state !== "OPEN") {
            return { kind: "INVALID_STATE", state: task.state };
          }
          if (task.version !== input.expectedVersion) {
            return {
              kind: "VERSION_CONFLICT",
              currentVersion: task.version,
            };
          }
          if (
            input.outcome === "APPROVED" &&
            task.kind !== "CONTENT_DECISION"
          ) {
            return { kind: "POLICY_INVALID" };
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
          if (
            input.outcome === "APPROVED" &&
            task.kind === "CONTENT_DECISION"
          ) {
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
            await transaction.expertNote.updateMany({
              where: {
                contentDecisionId: task.contentDecisionId,
                status: "REVIEW_PENDING",
              },
              data: { status: "APPROVED" },
            });
            const discoverySources = await transaction.discoverySource.findMany(
              {
                where: { contentDecisionId: task.contentDecisionId },
                select: { discoveryId: true },
              },
            );
            await transaction.discovery.updateMany({
              where: {
                id: {
                  in: [
                    ...new Set(
                      discoverySources.map((source) => source.discoveryId),
                    ),
                  ],
                },
                status: "REVIEW_PENDING",
              },
              data: { status: "APPROVED" },
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
      if (isTransactionClient(client)) throw error;
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

  async reopenTask(input) {
    assertCommandInput(input);
    const replay = await replayReopen(client, input);
    if (replay !== null) {
      return replay;
    }
    try {
      return await withTransaction(
        client,
        async (transaction): Promise<ReopenReviewTaskResult> => {
          const repeated = await replayReopen(transaction, input);
          if (repeated !== null) {
            return repeated;
          }
          const previous = await transaction.reviewTask.findUnique({
            where: { id: input.taskId },
          });
          if (previous === null) {
            return { kind: "NOT_FOUND" };
          }
          const owned = await transaction.contentDecision.findUnique({
            where: { id: previous.contentDecisionId },
            select: { manualDraftId: true },
          });
          if (
            previous.kind === "CONTENT_DECISION" &&
            owned?.manualDraftId != null
          )
            return { kind: "POLICY_INVALID" };
          if (previous.state === "OPEN") {
            return { kind: "INVALID_STATE", state: previous.state };
          }
          if (previous.version !== input.expectedVersion) {
            return {
              kind: "VERSION_CONFLICT",
              currentVersion: previous.version,
            };
          }
          const latest = await transaction.reviewTask.findFirstOrThrow({
            where: {
              contentDecisionId: previous.contentDecisionId,
              kind: previous.kind,
              targetKey: previous.targetKey,
              targetSnapshotHash: previous.targetSnapshotHash,
            },
            orderBy: { revision: "desc" },
          });
          if (latest.id !== previous.id) {
            return { kind: "POLICY_INVALID" };
          }
          const selected = await transaction.selectedComment.findUniqueOrThrow({
            where: { id: previous.commentId },
            select: { activeDecisionId: true },
          });
          const reopened = await transaction.reviewTask.create({
            data: {
              commentId: previous.commentId,
              contentDecisionId: previous.contentDecisionId,
              kind: previous.kind,
              targetKey: previous.targetKey,
              targetSnapshotHash: previous.targetSnapshotHash,
              priority: previous.priority,
              reasonCodes: previous.reasonCodes,
              revision: previous.revision + 1,
              supersedesTaskId: previous.id,
            },
          });
          const event = await transaction.manualOverrideEvent.create({
            data: {
              reviewTaskId: reopened.id,
              commentId: reopened.commentId,
              action: "REOPENED",
              previousDecisionId: selected.activeDecisionId,
              newDecisionId: selected.activeDecisionId,
              actorId: requiredText(input.actorId, "actorId", 128),
              requestHash: requiredText(input.requestHash, "requestHash", 256),
              previousValueHash: taskValueHash(previous),
              newValueHash: taskValueHash(reopened),
              reason: requiredText(input.reason, "reason", 1_000),
              commandKey: requiredText(input.commandKey, "commandKey", 256),
            },
          });
          return {
            kind: "REOPENED",
            task: toTask(reopened),
            event: toEvent(event),
            replayed: false,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (isTransactionClient(client)) throw error;
      if (hasPrismaErrorCode(error, "P2002")) {
        return (
          (await replayReopen(client, input)) ?? {
            kind: "IDEMPOTENCY_CONFLICT",
          }
        );
      }
      if (hasPrismaErrorCode(error, "P2034")) {
        const repeated = await replayReopen(client, input);
        return repeated ?? reopenState(client, input.taskId);
      }
      throw error;
    }
  },

  async mergeSubjects(input) {
    assertCommandInput(input);
    if (input.sourceSubjectId === input.targetSubjectId) {
      return { kind: "POLICY_INVALID" };
    }
    const replay = await replayEntityMutation(client, input);
    if (replay !== null) {
      return replay;
    }
    try {
      return await withTransaction(
        client,
        async (transaction): Promise<EntityReviewMutationResult> => {
          const repeated = await replayEntityMutation(transaction, input);
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
          if (
            task.kind !== "SUBJECT_MERGE" ||
            !task.reasonCodes.includes("NAME_ONLY_MERGE_SUGGESTION")
          ) {
            return { kind: "POLICY_INVALID" };
          }
          const source = await transaction.subject.findUnique({
            where: { id: input.sourceSubjectId },
            include: { aliases: true },
          });
          const target = await transaction.subject.findUnique({
            where: { id: input.targetSubjectId },
            include: { aliases: true },
          });
          if (
            source === null ||
            target === null ||
            source.lifecycleState !== "ACTIVE" ||
            target.lifecycleState !== "ACTIVE" ||
            source.type !== target.type
          ) {
            return { kind: "POLICY_INVALID" };
          }
          const sourceNames = new Set([
            source.normalizedName,
            ...source.aliases.map((alias) => alias.normalizedAlias),
          ]);
          const targetNames = [
            target.normalizedName,
            ...target.aliases.map((alias) => alias.normalizedAlias),
          ];
          if (!targetNames.some((name) => sourceNames.has(name))) {
            return { kind: "POLICY_INVALID" };
          }
          const sourceBelongsToDecision =
            source.createdFromDecisionId === task.contentDecisionId ||
            (await transaction.subjectMention.count({
              where: {
                subjectId: source.id,
                contentDecisionId: task.contentDecisionId,
              },
            })) > 0;
          if (!sourceBelongsToDecision) {
            return { kind: "POLICY_INVALID" };
          }
          const previousHash = sha256(
            JSON.stringify({
              id: source.id,
              lifecycleState: source.lifecycleState,
              mergedIntoSubjectId: source.mergedIntoSubjectId,
            }),
          );
          const updated = await transaction.subject.updateMany({
            where: { id: source.id, lifecycleState: "ACTIVE" },
            data: {
              lifecycleState: "MERGED",
              mergedIntoSubjectId: target.id,
            },
          });
          if (updated.count !== 1) {
            return { kind: "POLICY_INVALID" };
          }
          await transaction.subjectAlias.createMany({
            data: [
              {
                subjectId: target.id,
                alias: source.name,
                normalizedAlias: source.normalizedName,
                contentDecisionId: task.contentDecisionId,
              },
              ...source.aliases.map((alias) => ({
                subjectId: target.id,
                alias: alias.alias,
                normalizedAlias: alias.normalizedAlias,
                contentDecisionId: task.contentDecisionId,
              })),
            ],
            skipDuplicates: true,
          });
          const nextHash = sha256(
            JSON.stringify({
              id: source.id,
              lifecycleState: "MERGED",
              mergedIntoSubjectId: target.id,
            }),
          );
          return completeEntityReview(
            transaction,
            task,
            input,
            previousHash,
            nextHash,
            {
              affectedSubjectId: source.id,
              relatedSubjectId: target.id,
              previousUrlCandidateId: null,
              newUrlCandidateId: null,
            },
          );
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (isTransactionClient(client)) throw error;
      if (hasPrismaErrorCode(error, "P2002")) {
        return (
          (await replayEntityMutation(client, input)) ?? {
            kind: "IDEMPOTENCY_CONFLICT",
          }
        );
      }
      if (hasPrismaErrorCode(error, "P2034")) {
        return (
          (await replayEntityMutation(client, input)) ??
          taskMutationState(client, input.taskId)
        );
      }
      throw error;
    }
  },

  async resolveSubjectUrl(input) {
    assertCommandInput(input);
    const replay = await replayEntityMutation(client, input);
    if (replay !== null) {
      return replay;
    }
    try {
      return await withTransaction(
        client,
        async (transaction): Promise<EntityReviewMutationResult> => {
          const repeated = await replayEntityMutation(transaction, input);
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
          if (
            task.kind !== "URL_RESOLUTION" ||
            !task.reasonCodes.some(
              (reason) =>
                reason === "MISSING_CANONICAL_URL" ||
                reason === "AMBIGUOUS_CANONICAL_URL",
            )
          ) {
            return { kind: "POLICY_INVALID" };
          }
          const subject = await transaction.subject.findUnique({
            where: { id: input.subjectId },
            include: { aliases: true },
          });
          const candidate = await transaction.urlCandidate.findUnique({
            where: { id: input.urlCandidateId },
          });
          const selected = await transaction.selectedComment.findUnique({
            where: { id: task.commentId },
            select: {
              rootId: true,
              resolutionPath: { select: { resolvedRootId: true } },
            },
          });
          if (
            subject === null ||
            candidate === null ||
            selected === null ||
            subject.lifecycleState !== "ACTIVE" ||
            candidate.validationState === "REJECTED" ||
            candidate.canonicalUrl === null ||
            (candidate.scheme !== "http" && candidate.scheme !== "https") ||
            candidate.hnItemId === null ||
            candidate.sourceDocument !== `hn:item:${candidate.hnItemId}` ||
            subject.canonicalUrlCandidateId === candidate.id
          ) {
            return { kind: "POLICY_INVALID" };
          }
          const resolvedRootId =
            selected.resolutionPath?.resolvedRootId ?? selected.rootId;
          if (
            candidate.hnItemId !== task.commentId &&
            candidate.hnItemId !== resolvedRootId
          ) {
            return { kind: "POLICY_INVALID" };
          }
          const subjectBelongsToDecision =
            subject.createdFromDecisionId === task.contentDecisionId ||
            (await transaction.subjectMention.count({
              where: {
                subjectId: subject.id,
                contentDecisionId: task.contentDecisionId,
              },
            })) > 0;
          if (!subjectBelongsToDecision) {
            return { kind: "POLICY_INVALID" };
          }
          const identity = createSubjectIdentity(
            {
              name: subject.name,
              aliases: subject.aliases.map((alias) => alias.alias),
              subjectType: subject.type,
              canonicalUrl: candidate.canonicalUrl,
              verifiedOfficialDomain: null,
              disambiguatingRootId: hnItemId(Number(resolvedRootId)),
              provenanceKey: `review-task:${task.id}`,
            },
            { sha256 },
          );
          if (identity.canonicalUrl !== candidate.canonicalUrl) {
            return { kind: "POLICY_INVALID" };
          }
          const collision = await transaction.subject.findUnique({
            where: { dedupKey: identity.dedupKey },
            select: { id: true },
          });
          if (collision !== null && collision.id !== subject.id) {
            return { kind: "POLICY_INVALID" };
          }
          const previousHash = sha256(
            JSON.stringify({
              id: subject.id,
              dedupKey: subject.dedupKey,
              identityBasis: subject.identityBasis,
              ecosystemCoordinate: subject.ecosystemCoordinate,
              canonicalUrlCandidateId: subject.canonicalUrlCandidateId,
              contextKey: subject.contextKey,
            }),
          );
          const updated = await transaction.subject.updateMany({
            where: { id: subject.id, lifecycleState: "ACTIVE" },
            data: {
              dedupKey: identity.dedupKey,
              identityBasis: identity.basis,
              ecosystemCoordinate: identity.ecosystemCoordinate,
              canonicalUrlCandidateId: candidate.id,
              officialDomain: identity.officialDomain,
              contextKey: identity.contextKey,
            },
          });
          if (updated.count !== 1) {
            return { kind: "POLICY_INVALID" };
          }
          const nextHash = sha256(
            JSON.stringify({
              id: subject.id,
              dedupKey: identity.dedupKey,
              identityBasis: identity.basis,
              ecosystemCoordinate: identity.ecosystemCoordinate,
              canonicalUrlCandidateId: candidate.id,
              contextKey: identity.contextKey,
            }),
          );
          return completeEntityReview(
            transaction,
            task,
            input,
            previousHash,
            nextHash,
            {
              affectedSubjectId: subject.id,
              relatedSubjectId: null,
              previousUrlCandidateId: subject.canonicalUrlCandidateId,
              newUrlCandidateId: candidate.id,
            },
          );
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (isTransactionClient(client)) throw error;
      if (hasPrismaErrorCode(error, "P2002")) {
        return (
          (await replayEntityMutation(client, input)) ?? {
            kind: "IDEMPOTENCY_CONFLICT",
          }
        );
      }
      if (hasPrismaErrorCode(error, "P2034")) {
        return (
          (await replayEntityMutation(client, input)) ??
          taskMutationState(client, input.taskId)
        );
      }
      throw error;
    }
  },
});
