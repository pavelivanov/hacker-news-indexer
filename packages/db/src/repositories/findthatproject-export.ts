import { createHash, randomUUID } from "node:crypto";

import {
  discoveryId,
  exportId,
  exportOutboxId,
  findThatProjectIneligibility,
  hnItemId,
  reviewTaskId,
  telegramMessageId,
  type ExportOutboxRevision,
  type FindThatProjectExportPayloadV1,
  type FindThatProjectIneligibilityCode,
  type FindThatProjectRetractionReason,
  type FindThatProjectSubjectType,
  type ReviewReasonCode,
  type ReviewTask,
} from "@hn-knowledge/domain";
import type {
  ApproveFindThatProjectReviewInput,
  ApproveFindThatProjectReviewResult,
  FindThatProjectExportRepository,
  RequestFindThatProjectReviewResult,
} from "@hn-knowledge/ports";

import {
  Prisma,
  type ExportOutbox as DatabaseExportOutbox,
  type PrismaClient,
  type ReviewTask as DatabaseReviewTask,
} from "../generated/prisma/client.js";

type Transaction = Prisma.TransactionClient;
type ExportClient = PrismaClient | Transaction;

interface Candidate {
  readonly discoveryId: string;
  readonly contentDecisionId: string;
  readonly commentId: bigint;
  readonly rootId: bigint;
  readonly subjectName: string;
  readonly subjectType: string;
  readonly canonicalUrl: string | null;
  readonly description: string;
  readonly confidence: number;
  readonly evidenceOrigin: "COMMENT" | "BOTH";
  readonly evidenceQuote: string;
  readonly telegramMessageIds: readonly number[];
  readonly sourceHash: string;
  readonly reasons: readonly FindThatProjectIneligibilityCode[];
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

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

const positiveInteger = (
  value: number,
  field: string,
  maximum: number,
): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${field} must be between 1 and ${maximum}`);
  }
  return value;
};

const hasPrismaErrorCode = (error: unknown, code: string): boolean =>
  error !== null &&
  typeof error === "object" &&
  "code" in error &&
  error.code === code;

const reviewReasons = (values: readonly string[]): ReviewReasonCode[] =>
  values as ReviewReasonCode[];

const toTask = (task: DatabaseReviewTask): ReviewTask => ({
  id: reviewTaskId(task.id),
  commentId: hnItemId(Number(task.commentId)),
  contentDecisionId: task.contentDecisionId as ReviewTask["contentDecisionId"],
  kind: task.kind,
  targetKey: task.targetKey,
  targetSnapshotHash: task.targetSnapshotHash,
  state: task.state,
  priority: task.priority,
  reasonCodes: reviewReasons(task.reasonCodes),
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

const asPayload = (value: Prisma.JsonValue): FindThatProjectExportPayloadV1 =>
  value as unknown as FindThatProjectExportPayloadV1;

const toRevision = (row: DatabaseExportOutbox): ExportOutboxRevision => ({
  id: exportOutboxId(row.id),
  exportId: exportId(row.exportId),
  destination: row.destination,
  discoveryId: discoveryId(row.discoveryId),
  revision: row.revision,
  action: row.action,
  payload: asPayload(row.payload),
  payloadHash: row.payloadHash,
  sourceHash: row.sourceHash,
  deliveryState: row.deliveryState,
  reviewTaskId:
    row.reviewTaskId === null ? null : reviewTaskId(row.reviewTaskId),
  acknowledgedAt: row.acknowledgedAt,
  createdAt: row.createdAt,
});

const evidenceQuote = (
  canonicalText: string,
  spans: readonly {
    readonly sourceDocument: string;
    readonly origin: "COMMENT" | "ROOT_STORY";
    readonly startOffset: number;
    readonly endOffset: number;
  }[],
): string => {
  const span = spans.find(
    (value) =>
      value.origin === "COMMENT" &&
      value.startOffset >= 0 &&
      value.endOffset > value.startOffset &&
      value.endOffset <= canonicalText.length,
  );
  return span === undefined
    ? ""
    : canonicalText
        .slice(span.startOffset, span.endOffset)
        .trim()
        .slice(0, 500);
};

const loadCandidate = async (
  client: ExportClient,
  rawDiscoveryId: string,
  requiredDecisionId: string | null,
  explicitlyApprovedForExport: boolean,
  excludedReviewTaskId: string | null,
): Promise<Candidate | null> => {
  const discovery = await client.discovery.findUnique({
    where: { id: rawDiscoveryId },
    include: {
      subject: { include: { canonicalUrlCandidate: true } },
      sources: {
        ...(requiredDecisionId === null
          ? {}
          : { where: { contentDecisionId: requiredDecisionId } }),
        include: {
          selectedComment: {
            include: { item: true, resolutionPath: true },
          },
          contentDecision: {
            include: {
              reviewTasks: {
                where: { kind: "CONTENT_DECISION", state: "APPROVED" },
                take: 1,
              },
            },
          },
          evidenceSpans: { include: { evidenceSpan: true } },
        },
        orderBy: [{ confidence: "desc" }, { createdAt: "desc" }, { id: "asc" }],
      },
    },
  });
  if (discovery === null) {
    return null;
  }

  const rootIds = [
    ...new Set(
      discovery.sources.map((source) => source.selectedComment.rootId),
    ),
  ];
  const roots = await client.hnItem.findMany({
    where: { id: { in: rootIds } },
  });
  const rootsById = new Map(roots.map((root) => [root.id, root] as const));
  const candidates: Candidate[] = [];

  for (const source of discovery.sources) {
    const selected = source.selectedComment;
    const decision = source.contentDecision;
    const root = rootsById.get(selected.rootId);
    const mention = await client.subjectMention.findFirst({
      where: {
        subjectId: discovery.subjectId,
        contentDecisionId: source.contentDecisionId,
        sourceKind: "DISCOVERY",
        sourceOrdinal: source.sourceOrdinal,
      },
    });
    const openReviewCount = await client.reviewTask.count({
      where: {
        contentDecisionId: source.contentDecisionId,
        state: "OPEN",
        ...(excludedReviewTaskId === null
          ? {}
          : { id: { not: excludedReviewTaskId } }),
      },
    });
    const references = await client.hnReference.findMany({
      where: {
        hnItemId: source.selectedCommentId,
        role: "SELECTED_COMMENT",
        occurrence: {
          source: "TELEGRAM",
          status: { in: ["OBSERVED", "RESOLVED"] },
        },
      },
      include: { occurrence: { select: { externalId: true } } },
      orderBy: { occurrenceId: "asc" },
    });
    const telegramMessageIds = [
      ...new Set(
        references.map((reference) => Number(reference.occurrence.externalId)),
      ),
    ].sort((left, right) => left - right);
    const url = discovery.subject.canonicalUrlCandidate;
    const groundedUrl =
      url !== null &&
      url.validationState === "VALID" &&
      (url.scheme === "http" || url.scheme === "https") &&
      url.canonicalUrl !== null &&
      (url.hnItemId === selected.id || url.hnItemId === selected.rootId) &&
      (url.sourceDocument === `hn:item:${selected.id}` ||
        url.sourceDocument === `hn:item:${selected.rootId}`);
    const spans = source.evidenceSpans.map(({ evidenceSpan }) => evidenceSpan);
    const quote = evidenceQuote(selected.canonicalText, spans);
    const hasRootEvidence = spans.some((span) => span.origin === "ROOT_STORY");
    const candidateSource = {
      discoveryId: discovery.id,
      contentDecisionId: source.contentDecisionId,
      commentId: Number(selected.id),
      rootId: Number(selected.rootId),
      subjectName: discovery.subject.name,
      subjectType: discovery.subject.type,
      canonicalUrl: url?.canonicalUrl ?? null,
      description: source.descriptionClaim,
      confidence: Math.min(source.confidence, decision.decisionConfidence),
      evidenceOrigin: hasRootEvidence
        ? ("BOTH" as const)
        : ("COMMENT" as const),
      evidenceQuote: quote,
      telegramMessageIds,
    };
    const sourceHash = sha256(JSON.stringify(candidateSource));
    const activeAndApproved =
      selected.activeDecisionId === source.contentDecisionId &&
      decision.reviewTasks.length > 0;
    const reasons = findThatProjectIneligibility({
      discoveryStatus: discovery.status,
      contentAvailable:
        activeAndApproved &&
        selected.availability === "AVAILABLE" &&
        selected.item.availability === "AVAILABLE" &&
        selected.resolutionPath !== null &&
        root?.availability === "AVAILABLE",
      canonicalUrl: url?.canonicalUrl ?? null,
      canonicalUrlGroundedInHnEvidence: groundedUrl,
      subjectType: discovery.subject.type,
      classificationConfidence: Math.min(
        source.confidence,
        decision.decisionConfidence,
      ),
      subjectConfidence: mention?.confidence ?? 0,
      urlConfidence: groundedUrl ? 1 : 0,
      selectedCommentMateriallyDiscussesSubject:
        decision.materiallyTechnical &&
        !discovery.rootStoryOnly &&
        quote.length > 0,
      unresolvedReviewFlags: openReviewCount > 0,
      evidencePresent:
        spans.length > 0 && quote.length > 0 && telegramMessageIds.length > 0,
      explicitlyApprovedForExport,
    });
    candidates.push({
      discoveryId: discovery.id,
      contentDecisionId: source.contentDecisionId,
      commentId: selected.id,
      rootId: selected.rootId,
      subjectName: discovery.subject.name,
      subjectType: discovery.subject.type,
      canonicalUrl: url?.canonicalUrl ?? null,
      description: source.descriptionClaim,
      confidence: candidateSource.confidence,
      evidenceOrigin: candidateSource.evidenceOrigin,
      evidenceQuote: quote,
      telegramMessageIds,
      sourceHash,
      reasons,
    });
  }

  return (
    candidates.sort(
      (left, right) =>
        left.reasons.length - right.reasons.length ||
        right.confidence - left.confidence ||
        left.contentDecisionId.localeCompare(right.contentDecisionId),
    )[0] ?? null
  );
};

const latestRevision = (
  client: ExportClient,
  rawDiscoveryId: string,
): Promise<DatabaseExportOutbox | null> =>
  client.exportOutbox.findFirst({
    where: { destination: "FINDTHATPROJECT", discoveryId: rawDiscoveryId },
    orderBy: [{ revision: "desc" }, { id: "asc" }],
  });

const upsertPayload = (
  candidate: Candidate,
  stableExportId: string,
  revision: number,
  reviewedAt: Date,
): FindThatProjectExportPayloadV1 => ({
  schema_version: "findthatproject.discovery.v1",
  export_id: exportId(stableExportId),
  revision,
  action: "UPSERT",
  discovery_id: discoveryId(candidate.discoveryId),
  kind: "DISCOVERY",
  subject: {
    name: candidate.subjectName.slice(0, 160),
    type: candidate.subjectType as FindThatProjectSubjectType,
    canonical_url: candidate.canonicalUrl ?? "",
    evidence_based_summary: candidate.description.slice(0, 1_000),
  },
  provenance: {
    hn_comment_id: hnItemId(Number(candidate.commentId)),
    hn_root_story_id: hnItemId(Number(candidate.rootId)),
    telegram_message_ids: candidate.telegramMessageIds.map(telegramMessageId),
    evidence_origin: candidate.evidenceOrigin,
    evidence_quote: candidate.evidenceQuote,
  },
  confidence: candidate.confidence,
  reviewed_at: reviewedAt.toISOString(),
});

const replayApproval = async (
  client: ExportClient,
  input: ApproveFindThatProjectReviewInput,
): Promise<ApproveFindThatProjectReviewResult | null> => {
  const event = await client.manualOverrideEvent.findUnique({
    where: { commandKey: input.commandKey },
  });
  if (event === null) {
    return null;
  }
  if (
    event.reviewTaskId !== input.taskId ||
    event.action !== "APPROVED" ||
    event.requestHash !== input.requestHash
  ) {
    return { kind: "IDEMPOTENCY_CONFLICT" };
  }
  const task = await client.reviewTask.findUnique({
    where: { id: input.taskId },
  });
  const row = await client.exportOutbox.findUnique({
    where: { reviewTaskId: input.taskId },
  });
  if (task === null || row === null) {
    throw new Error("EXPORT_APPROVAL_REPLAY_INCOMPLETE");
  }
  return {
    kind: "APPROVED",
    task: toTask(task),
    revision: toRevision(row),
    replayed: true,
  };
};

const existingOpenReview = async (
  client: PrismaClient,
  rawDiscoveryId: string,
  snapshotHash: string,
): Promise<RequestFindThatProjectReviewResult | null> => {
  const task = await client.reviewTask.findFirst({
    where: {
      kind: "FINDTHATPROJECT_EXPORT",
      targetKey: rawDiscoveryId,
      targetSnapshotHash: snapshotHash,
      state: "OPEN",
    },
    orderBy: [{ revision: "desc" }, { id: "asc" }],
  });
  return task === null
    ? null
    : { kind: "OPENED", task: toTask(task), created: false };
};

export const createFindThatProjectExportRepository = (
  client: PrismaClient,
): FindThatProjectExportRepository => ({
  async requestReview(input) {
    requiredText(input.actorId, "actorId", 128);
    requiredText(input.commandKey, "commandKey", 256);
    requiredText(input.requestHash, "requestHash", 256);
    requiredText(input.reason, "reason", 1_000);
    const replay = await client.manualOverrideEvent.findUnique({
      where: { commandKey: input.commandKey },
      include: { reviewTask: true },
    });
    if (replay !== null) {
      return replay.requestHash === input.requestHash &&
        replay.reviewTask.targetKey === input.discoveryId
        ? { kind: "OPENED", task: toTask(replay.reviewTask), created: false }
        : { kind: "IDEMPOTENCY_CONFLICT" };
    }
    const initial = await loadCandidate(
      client,
      input.discoveryId,
      null,
      false,
      null,
    );
    if (initial === null) {
      return { kind: "NOT_FOUND" };
    }
    const blockingReasons = initial.reasons.filter(
      (reason) => reason !== "EXPORT_APPROVAL_REQUIRED",
    );
    if (blockingReasons.length > 0) {
      return { kind: "INELIGIBLE", reasons: blockingReasons };
    }
    const latest = await latestRevision(client, input.discoveryId);
    if (
      latest !== null &&
      latest.action === "UPSERT" &&
      latest.sourceHash === initial.sourceHash
    ) {
      return { kind: "ALREADY_CURRENT" };
    }
    const currentOpen = await existingOpenReview(
      client,
      input.discoveryId,
      initial.sourceHash,
    );
    if (currentOpen !== null) {
      return currentOpen;
    }
    try {
      return await client.$transaction(
        async (transaction): Promise<RequestFindThatProjectReviewResult> => {
          const candidate = await loadCandidate(
            transaction,
            input.discoveryId,
            initial.contentDecisionId,
            false,
            null,
          );
          if (candidate === null) {
            return { kind: "NOT_FOUND" };
          }
          const reasons = candidate.reasons.filter(
            (reason) => reason !== "EXPORT_APPROVAL_REQUIRED",
          );
          if (reasons.length > 0) {
            return { kind: "INELIGIBLE", reasons };
          }
          const previous = await transaction.reviewTask.findFirst({
            where: {
              kind: "FINDTHATPROJECT_EXPORT",
              targetKey: input.discoveryId,
            },
            orderBy: [{ revision: "desc" }, { id: "asc" }],
          });
          const task = await transaction.reviewTask.create({
            data: {
              commentId: candidate.commentId,
              contentDecisionId: candidate.contentDecisionId,
              kind: "FINDTHATPROJECT_EXPORT",
              targetKey: input.discoveryId,
              targetSnapshotHash: candidate.sourceHash,
              priority: "MEDIUM",
              reasonCodes: ["FINDTHATPROJECT_INITIAL_ROLLOUT"],
              revision: (previous?.revision ?? 0) + 1,
              supersedesTaskId: previous?.id ?? null,
            },
          });
          await transaction.manualOverrideEvent.create({
            data: {
              reviewTaskId: task.id,
              commentId: task.commentId,
              action: previous === null ? "OPENED" : "REOPENED",
              previousDecisionId: task.contentDecisionId,
              newDecisionId: task.contentDecisionId,
              actorId: requiredText(input.actorId, "actorId", 128),
              requestHash: requiredText(input.requestHash, "requestHash", 256),
              previousValueHash: sha256(
                `export:${input.discoveryId}:unreviewed`,
              ),
              newValueHash: candidate.sourceHash,
              reason: requiredText(input.reason, "reason", 1_000),
              commandKey: requiredText(input.commandKey, "commandKey", 256),
            },
          });
          return { kind: "OPENED", task: toTask(task), created: true };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (
        hasPrismaErrorCode(error, "P2002") ||
        hasPrismaErrorCode(error, "P2034")
      ) {
        return (
          (await existingOpenReview(
            client,
            input.discoveryId,
            initial.sourceHash,
          )) ?? {
            kind: "IDEMPOTENCY_CONFLICT",
          }
        );
      }
      throw error;
    }
  },

  async approveReview(input) {
    positiveInteger(
      input.expectedVersion,
      "expectedVersion",
      Number.MAX_SAFE_INTEGER,
    );
    requiredText(input.actorId, "actorId", 128);
    requiredText(input.commandKey, "commandKey", 256);
    requiredText(input.requestHash, "requestHash", 256);
    requiredText(input.reason, "reason", 1_000);
    const replay = await replayApproval(client, input);
    if (replay !== null) {
      return replay;
    }
    try {
      return await client.$transaction(
        async (transaction): Promise<ApproveFindThatProjectReviewResult> => {
          const repeated = await replayApproval(transaction, input);
          if (repeated !== null) {
            return repeated;
          }
          const task = await transaction.reviewTask.findUnique({
            where: { id: input.taskId },
          });
          if (task === null || task.kind !== "FINDTHATPROJECT_EXPORT") {
            return { kind: "NOT_FOUND" };
          }
          if (task.state !== "OPEN") {
            return { kind: "INVALID_STATE", state: task.state };
          }
          if (task.version !== input.expectedVersion) {
            return { kind: "VERSION_CONFLICT", currentVersion: task.version };
          }
          const candidate = await loadCandidate(
            transaction,
            task.targetKey,
            task.contentDecisionId,
            true,
            task.id,
          );
          if (candidate === null) {
            return { kind: "NOT_FOUND" };
          }
          if (candidate.sourceHash !== task.targetSnapshotHash) {
            return { kind: "SNAPSHOT_CHANGED" };
          }
          if (candidate.reasons.length > 0) {
            return { kind: "INELIGIBLE", reasons: candidate.reasons };
          }
          const previous = await latestRevision(
            transaction,
            candidate.discoveryId,
          );
          const revision = (previous?.revision ?? 0) + 1;
          const stableExportId = previous?.exportId ?? randomUUID();
          const reviewedAt = new Date();
          const payload = upsertPayload(
            candidate,
            stableExportId,
            revision,
            reviewedAt,
          );
          const payloadHash = sha256(JSON.stringify(payload));
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
              resolvedAt: reviewedAt,
            },
          });
          if (updated.count !== 1) {
            const current = await transaction.reviewTask.findUniqueOrThrow({
              where: { id: task.id },
              select: { version: true },
            });
            return {
              kind: "VERSION_CONFLICT",
              currentVersion: current.version,
            };
          }
          await transaction.manualOverrideEvent.create({
            data: {
              reviewTaskId: task.id,
              commentId: task.commentId,
              action: "APPROVED",
              previousDecisionId: task.contentDecisionId,
              newDecisionId: task.contentDecisionId,
              actorId: input.actorId,
              requestHash: input.requestHash,
              previousValueHash: sha256(`export-review:${task.id}:open`),
              newValueHash: payloadHash,
              reason: input.reason,
              commandKey: input.commandKey,
            },
          });
          const row = await transaction.exportOutbox.create({
            data: {
              exportId: stableExportId,
              destination: "FINDTHATPROJECT",
              discoveryId: candidate.discoveryId,
              revision,
              action: "UPSERT",
              payload: payload as unknown as Prisma.InputJsonObject,
              payloadHash,
              sourceHash: candidate.sourceHash,
              reviewTaskId: task.id,
            },
          });
          const resolvedTask = await transaction.reviewTask.findUniqueOrThrow({
            where: { id: task.id },
          });
          return {
            kind: "APPROVED",
            task: toTask(resolvedTask),
            revision: toRevision(row),
            replayed: false,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (
        hasPrismaErrorCode(error, "P2002") ||
        hasPrismaErrorCode(error, "P2034")
      ) {
        return (
          (await replayApproval(client, input)) ?? {
            kind: "IDEMPOTENCY_CONFLICT",
          }
        );
      }
      throw error;
    }
  },

  async listPending(rawLimit, after) {
    const limit = positiveInteger(rawLimit, "limit", 100);
    const rows = await client.exportOutbox.findMany({
      where: {
        destination: "FINDTHATPROJECT",
        deliveryState: "PENDING",
        ...(after === null
          ? {}
          : {
              OR: [
                { createdAt: { gt: after.createdAt } },
                { createdAt: after.createdAt, id: { gt: after.id } },
              ],
            }),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toRevision),
      nextAfter:
        hasMore && last !== undefined
          ? { createdAt: last.createdAt, id: exportOutboxId(last.id) }
          : null,
    };
  },

  async acknowledge(input) {
    positiveInteger(input.revision, "revision", Number.MAX_SAFE_INTEGER);
    requiredText(input.payloadHash, "payloadHash", 64);
    requiredText(input.idempotencyKey, "idempotencyKey", 256);
    requiredText(input.consumerId, "consumerId", 128);
    const replay = await client.exportAcknowledgement.findUnique({
      where: {
        destination_idempotencyKey: {
          destination: "FINDTHATPROJECT",
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (replay !== null) {
      return replay.exportId === input.exportId &&
        replay.revision === input.revision &&
        replay.payloadHash === input.payloadHash
        ? { kind: "ACKNOWLEDGED", replayed: true }
        : { kind: "IDEMPOTENCY_CONFLICT" };
    }
    try {
      return await client.$transaction(
        async (transaction) => {
          const row = await transaction.exportOutbox.findUnique({
            where: {
              exportId_revision: {
                exportId: input.exportId,
                revision: input.revision,
              },
            },
          });
          if (row === null || row.destination !== "FINDTHATPROJECT") {
            return { kind: "NOT_FOUND" } as const;
          }
          if (row.payloadHash !== input.payloadHash) {
            return { kind: "PAYLOAD_HASH_MISMATCH" } as const;
          }
          await transaction.exportAcknowledgement.create({
            data: {
              outboxId: row.id,
              destination: "FINDTHATPROJECT",
              exportId: row.exportId,
              revision: row.revision,
              consumerId: input.consumerId,
              idempotencyKey: input.idempotencyKey,
              payloadHash: input.payloadHash,
            },
          });
          await transaction.exportOutbox.update({
            where: { id: row.id },
            data: { deliveryState: "ACKNOWLEDGED", acknowledgedAt: new Date() },
          });
          return { kind: "ACKNOWLEDGED", replayed: false } as const;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (
        hasPrismaErrorCode(error, "P2002") ||
        hasPrismaErrorCode(error, "P2034")
      ) {
        const repeated = await client.exportAcknowledgement.findUnique({
          where: {
            destination_idempotencyKey: {
              destination: "FINDTHATPROJECT",
              idempotencyKey: input.idempotencyKey,
            },
          },
        });
        return repeated !== null &&
          repeated.exportId === input.exportId &&
          repeated.revision === input.revision &&
          repeated.payloadHash === input.payloadHash
          ? { kind: "ACKNOWLEDGED", replayed: true }
          : { kind: "IDEMPOTENCY_CONFLICT" };
      }
      throw error;
    }
  },

  async retract(rawDiscoveryId, reason: FindThatProjectRetractionReason) {
    return client.$transaction(
      async (transaction) => {
        const previous = await latestRevision(transaction, rawDiscoveryId);
        if (previous === null) {
          return { kind: "NOT_EXPORTED" } as const;
        }
        if (previous.action === "RETRACT") {
          return {
            kind: "RETRACTED",
            revision: toRevision(previous),
            replayed: true,
          } as const;
        }
        const previousPayload = asPayload(previous.payload);
        if (previousPayload.action !== "UPSERT") {
          throw new Error("EXPORT_PREVIOUS_PAYLOAD_ACTION_INVALID");
        }
        const revision = previous.revision + 1;
        const payload: FindThatProjectExportPayloadV1 = {
          schema_version: "findthatproject.discovery.v1",
          export_id: exportId(previous.exportId),
          revision,
          action: "RETRACT",
          discovery_id: discoveryId(previous.discoveryId),
          kind: "DISCOVERY",
          retraction_reason: reason,
          provenance: {
            hn_comment_id: previousPayload.provenance.hn_comment_id,
            hn_root_story_id: previousPayload.provenance.hn_root_story_id,
            telegram_message_ids:
              previousPayload.provenance.telegram_message_ids,
          },
          reviewed_at: new Date().toISOString(),
        };
        const row = await transaction.exportOutbox.create({
          data: {
            exportId: previous.exportId,
            destination: "FINDTHATPROJECT",
            discoveryId: previous.discoveryId,
            revision,
            action: "RETRACT",
            payload: payload as unknown as Prisma.InputJsonObject,
            payloadHash: sha256(JSON.stringify(payload)),
            sourceHash: sha256(`${previous.sourceHash}:${reason}`),
          },
        });
        return {
          kind: "RETRACTED",
          revision: toRevision(row),
          replayed: false,
        } as const;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  },
});
