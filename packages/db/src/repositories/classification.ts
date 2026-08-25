import type {
  ClassificationRun,
  ClassificationRunId,
  ContentDecision,
  HnItemId,
} from "@hn-knowledge/domain";
import {
  classificationRunId,
  contentDecisionId,
  hnItemId,
} from "@hn-knowledge/domain";
import type {
  ClassificationRepository,
  RecordClassificationRunInput,
  SaveContentDecisionInput,
} from "@hn-knowledge/ports";

import type {
  ClassificationRun as DatabaseClassificationRun,
  EvidenceSpan as DatabaseEvidenceSpan,
  PrismaClient,
} from "../generated/prisma/client.js";
import { Prisma } from "../generated/prisma/client.js";

type DatabaseDecision = Prisma.ContentDecisionGetPayload<{
  include: { evidenceSpans: true };
}>;

const requiredText = (value: string, field: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256) {
    throw new TypeError(`${field} must contain 1 to 256 characters`);
  }
  return normalized;
};

const optionalCount = (value: number | null, field: string): number | null => {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
};

const confidence = (value: number): number => {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError("decisionConfidence must be between 0 and 1");
  }
  return value;
};

const jsonValue = (value: unknown, field: string): Prisma.InputJsonValue => {
  try {
    const serialized = JSON.stringify(value) as string | undefined;
    if (serialized === undefined) {
      throw new TypeError(`${field} must be JSON serializable`);
    }
    return JSON.parse(serialized) as Prisma.InputJsonValue;
  } catch (error) {
    if (error instanceof TypeError) {
      throw error;
    }
    throw new TypeError(`${field} must be JSON serializable`, { cause: error });
  }
};

const toRun = (run: DatabaseClassificationRun): ClassificationRun => ({
  id: classificationRunId(run.id),
  commentId: hnItemId(Number(run.commentId)),
  inputHash: run.inputHash,
  promptVersion: run.promptVersion,
  promptHash: run.promptHash,
  schemaVersion: run.schemaVersion,
  modelConfigId: run.modelConfigId,
  provider: run.provider,
  modelId: run.modelId,
  outputHash: run.outputHash,
  providerOutput: run.providerOutput,
  latencyMs: run.latencyMs,
  inputTokens: run.inputTokens,
  cachedInputTokens: run.cachedInputTokens,
  cacheWriteInputTokens: run.cacheWriteInputTokens,
  outputTokens: run.outputTokens,
  status: run.status,
  errorCode: run.errorCode,
  createdAt: run.createdAt,
});

const toEvidence = (
  span: DatabaseEvidenceSpan,
): ContentDecision["evidenceSpans"][number] => ({
  id: span.id,
  contentDecisionId: contentDecisionId(span.contentDecisionId),
  spanId: span.spanId,
  sourceDocument: span.sourceDocument,
  origin: span.origin,
  start: span.startOffset,
  end: span.endOffset,
  textHash: span.textHash,
  createdAt: span.createdAt,
});

const toDecision = (decision: DatabaseDecision): ContentDecision => ({
  id: contentDecisionId(decision.id),
  commentId: hnItemId(Number(decision.commentId)),
  classificationRunId:
    decision.classificationRunId === null
      ? null
      : classificationRunId(decision.classificationRunId),
  source: decision.source,
  primaryDecision: decision.primaryDecision,
  decisionConfidence: decision.decisionConfidence,
  materiallyTechnical: decision.materiallyTechnical,
  reviewRequired: decision.reviewRequired,
  validatedOutput: decision.validatedOutput,
  manualOverrideOfId:
    decision.manualOverrideOfId === null
      ? null
      : contentDecisionId(decision.manualOverrideOfId),
  evidenceSpans: decision.evidenceSpans.map(toEvidence),
  createdAt: decision.createdAt,
});

const validateRunShape = (input: RecordClassificationRunInput): void => {
  if (input.status === "FAILED") {
    if (input.errorCode === null) {
      throw new TypeError("A failed run requires an error code");
    }
  } else if (
    input.outputHash === null ||
    (input.status === "SUCCEEDED" && input.errorCode !== null)
  ) {
    throw new TypeError(
      "A successful or review run has an invalid output/error shape",
    );
  }
};

const findIdempotentRun = (
  client: PrismaClient,
  input: RecordClassificationRunInput,
): Promise<DatabaseClassificationRun | null> =>
  client.classificationRun.findUnique({
    where: {
      commentId_inputHash_promptVersion_schemaVersion_modelConfigId: {
        commentId: BigInt(input.commentId),
        inputHash: input.inputHash,
        promptVersion: input.promptVersion,
        schemaVersion: input.schemaVersion,
        modelConfigId: input.modelConfigId,
      },
    },
  });

const assertRunIdentity = (
  existing: DatabaseClassificationRun,
  input: RecordClassificationRunInput,
): void => {
  if (
    existing.promptHash !== input.promptHash ||
    existing.provider !== input.provider ||
    existing.modelId !== input.modelId
  ) {
    throw new Error("CLASSIFICATION_RUN_IDEMPOTENCY_CONFLICT");
  }
};

const validateEvidence = (input: SaveContentDecisionInput): void => {
  const ids = new Set<string>();
  for (const span of input.evidenceSpans) {
    requiredText(span.spanId, "spanId");
    requiredText(span.sourceDocument, "sourceDocument");
    requiredText(span.textHash, "textHash");
    if (
      !Number.isSafeInteger(span.start) ||
      !Number.isSafeInteger(span.end) ||
      span.start < 0 ||
      span.end <= span.start
    ) {
      throw new TypeError("Evidence span offsets are invalid");
    }
    if (ids.has(span.spanId)) {
      throw new TypeError("Evidence span IDs must be unique per decision");
    }
    ids.add(span.spanId);
  }
};

export const createClassificationRepository = (
  client: PrismaClient,
): ClassificationRepository => ({
  async loadSource(commentId) {
    const selected = await client.selectedComment.findUnique({
      where: { id: BigInt(commentId) },
      include: {
        item: { include: { urlCandidates: true } },
      },
    });
    if (selected === null) {
      return null;
    }
    const root = await client.hnItem.findUnique({
      where: { id: selected.rootId },
    });
    if (root === null) {
      throw new TypeError("Selected comment root item is missing");
    }
    return {
      selectedCommentId: hnItemId(Number(selected.id)),
      rootId: hnItemId(Number(selected.rootId)),
      commentHtml: selected.canonicalHtml,
      commentText: selected.canonicalText,
      rootTitle: root.title ?? "",
      rootHtml: root.textHtml ?? "",
      rootUrl: root.url,
      commentUrlCandidates: selected.item.urlCandidates.map((candidate) => ({
        canonicalUrl: candidate.canonicalUrl ?? candidate.rawUrl,
        sourceDocument: candidate.sourceDocument,
        originField: candidate.originField,
        validationState: candidate.validationState,
      })),
    };
  },

  async recordRun(input) {
    validateRunShape(input);
    const data = {
      commentId: BigInt(input.commentId),
      inputHash: requiredText(input.inputHash, "inputHash"),
      promptVersion: requiredText(input.promptVersion, "promptVersion"),
      promptHash: requiredText(input.promptHash, "promptHash"),
      schemaVersion: requiredText(input.schemaVersion, "schemaVersion"),
      modelConfigId: requiredText(input.modelConfigId, "modelConfigId"),
      provider: requiredText(input.provider, "provider"),
      modelId: requiredText(input.modelId, "modelId"),
      outputHash:
        input.outputHash === null
          ? null
          : requiredText(input.outputHash, "outputHash"),
      providerOutput:
        input.providerOutput === null
          ? Prisma.DbNull
          : jsonValue(input.providerOutput, "providerOutput"),
      latencyMs: optionalCount(input.latencyMs, "latencyMs"),
      inputTokens: optionalCount(input.inputTokens, "inputTokens"),
      cachedInputTokens: optionalCount(
        input.cachedInputTokens,
        "cachedInputTokens",
      ),
      cacheWriteInputTokens: optionalCount(
        input.cacheWriteInputTokens,
        "cacheWriteInputTokens",
      ),
      outputTokens: optionalCount(input.outputTokens, "outputTokens"),
      status: input.status,
      errorCode:
        input.errorCode === null
          ? null
          : requiredText(input.errorCode, "errorCode"),
    } as const;
    try {
      const created = await client.classificationRun.create({ data });
      return { run: toRun(created), created: true };
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2002"
      ) {
        throw error;
      }
      const existing = await findIdempotentRun(client, input);
      if (existing === null) {
        throw error;
      }
      assertRunIdentity(existing, input);
      return { run: toRun(existing), created: false };
    }
  },

  async getRun(id: ClassificationRunId) {
    const run = await client.classificationRun.findUnique({ where: { id } });
    return run === null ? null : toRun(run);
  },

  async saveDecision(input) {
    confidence(input.decisionConfidence);
    validateEvidence(input);
    const storedOutput = jsonValue(input.validatedOutput, "validatedOutput");
    return client.$transaction(async (transaction) => {
      if (input.source === "MODEL") {
        if (
          input.classificationRunId === null ||
          input.manualOverrideOfId !== null
        ) {
          throw new TypeError(
            "A model decision requires a run and cannot override manually",
          );
        }
        const run = await transaction.classificationRun.findFirst({
          where: {
            id: input.classificationRunId,
            commentId: BigInt(input.commentId),
            status: { in: ["SUCCEEDED", "REVIEW"] },
          },
        });
        if (run === null) {
          throw new TypeError(
            "Classification run is not eligible for decision",
          );
        }
        const existing = await transaction.contentDecision.findUnique({
          where: { classificationRunId: input.classificationRunId },
          include: { evidenceSpans: true },
        });
        if (existing !== null) {
          return toDecision(existing);
        }
      } else {
        if (
          input.classificationRunId !== null ||
          input.manualOverrideOfId === null
        ) {
          throw new TypeError(
            "A manual decision requires an overridden decision and no run",
          );
        }
        const overridden = await transaction.contentDecision.findFirst({
          where: {
            id: input.manualOverrideOfId,
            commentId: BigInt(input.commentId),
          },
        });
        if (overridden === null) {
          throw new TypeError(
            "Manual override target does not belong to comment",
          );
        }
      }

      const created = await transaction.contentDecision.create({
        data: {
          commentId: BigInt(input.commentId),
          classificationRunId: input.classificationRunId,
          source: input.source,
          primaryDecision: input.primaryDecision,
          decisionConfidence: input.decisionConfidence,
          materiallyTechnical: input.materiallyTechnical,
          reviewRequired: input.reviewRequired,
          validatedOutput: storedOutput,
          manualOverrideOfId: input.manualOverrideOfId,
          evidenceSpans: {
            create: input.evidenceSpans.map((span) => ({
              spanId: span.spanId,
              sourceDocument: span.sourceDocument,
              origin: span.origin,
              startOffset: span.start,
              endOffset: span.end,
              textHash: span.textHash,
            })),
          },
        },
        include: { evidenceSpans: true },
      });
      return toDecision(created);
    });
  },

  async getActiveDecision(commentId: HnItemId) {
    const selected = await client.selectedComment.findUnique({
      where: { id: BigInt(commentId) },
      select: {
        activeDecision: { include: { evidenceSpans: true } },
      },
    });
    return selected?.activeDecision === null || selected === null
      ? null
      : toDecision(selected.activeDecision);
  },
});
