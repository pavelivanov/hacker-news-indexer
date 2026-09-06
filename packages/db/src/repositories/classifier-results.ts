import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  ClassifierResultsError,
  type ResultCorrection,
} from "@hn-knowledge/domain";
import type {
  BoundedClassifierInput,
  ClassifierResultRecord,
  ClassifierResultsRepository,
  ResultFeedbackRecord,
} from "@hn-knowledge/ports";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";

const include = {
  run: { include: { comment: { include: { item: true } } } },
  feedback: { orderBy: { version: "desc" as const } },
};
type Row = Prisma.ClassifierResultSnapshotGetPayload<{
  include: typeof include;
}>;
type Feedback = Row["feedback"][number];
const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const feedback = (row: Feedback): ResultFeedbackRecord => ({
  id: row.id,
  version: row.version,
  values: row.values as unknown as ResultCorrection,
  actorId: row.actorId,
  createdAt: row.createdAt,
});
const record = (row: Row): ClassifierResultRecord => ({
  id: row.runId,
  commentId: Number(row.run.commentId),
  createdAt: row.createdAt,
  category: row.category as ClassifierResultRecord["category"],
  title: row.title,
  summary: row.summary,
  feedbackVersion: row.feedbackVersion,
  input: row.sourceInput as unknown as BoundedClassifierInput,
  output: row.originalOutput,
  errorCode: row.errorCode,
  inputHash: row.run.inputHash,
  provider: row.run.provider,
  modelId: row.run.modelId,
  modelConfigId: row.run.modelConfigId,
  promptVersion: row.run.promptVersion,
  promptHash: row.run.promptHash,
  available:
    row.run.comment.availability === "AVAILABLE" &&
    row.run.comment.item.availability === "AVAILABLE",
  feedback: row.feedback.map(feedback),
});
export const createClassifierResultsRepository = (
  client: PrismaClient,
): ClassifierResultsRepository => ({
  async list(filter, after) {
    const categories =
      filter === "discovery"
        ? ["DISCOVERY"]
        : filter === "expert_note"
          ? ["EXPERT_NOTE"]
          : filter === "skipped"
            ? ["REJECTED"]
            : filter === "uncertain"
              ? ["REVIEW", "FAILED"]
              : null;
    const rows = await client.classifierResultSnapshot.findMany({
      where: {
        ...(categories ? { category: { in: categories } } : {}),
        ...(filter === "corrected" ? { feedbackVersion: { gt: 0 } } : {}),
        ...(after
          ? {
              OR: [
                { createdAt: { lt: after.createdAt } },
                { createdAt: after.createdAt, runId: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { runId: "desc" }],
      take: 21,
      include,
    });
    return rows.map(record);
  },
  async get(id) {
    const row = await client.classifierResultSnapshot.findUnique({
      where: { runId: id },
      include,
    });
    return row ? record(row) : null;
  },
  async capture(input) {
    const run = await client.classificationRun.findUniqueOrThrow({
      where: { id: input.runId },
    });
    if (
      Number(run.commentId) !== input.source.selectedCommentId ||
      run.inputHash !==
        createHash("sha256").update(JSON.stringify(input.source)).digest("hex")
    )
      throw new TypeError("Snapshot does not match classifier input");
    if (
      input.output !== null &&
      (!isDeepStrictEqual(run.providerOutput, input.output) ||
        run.errorCode !== null)
    )
      throw new TypeError("Snapshot does not match stored classifier output");
    await client.classifierResultSnapshot.upsert({
      where: { runId: input.runId },
      update: {},
      create: {
        runId: input.runId,
        sourceInput: json(input.source),
        originalOutput:
          input.output === null ? Prisma.DbNull : json(input.output),
        errorCode: input.errorCode,
        category: input.category,
        title: input.title,
        summary: input.summary,
      },
    });
  },
  async correct(input) {
    const replay = (row: Feedback) => {
      if (row.resultId !== input.id || row.requestHash !== input.requestHash)
        throw new ClassifierResultsError("IDEMPOTENCY_CONFLICT");
      return { feedback: feedback(row), replayed: true };
    };
    try {
      return await client.$transaction(async (transaction) => {
        const existing = await transaction.classifierFeedback.findUnique({
          where: { commandKey: input.commandKey },
        });
        if (existing) return replay(existing);
        const updated = await transaction.classifierResultSnapshot.updateMany({
          where: { runId: input.id, feedbackVersion: input.expectedVersion },
          data: {
            feedbackVersion: { increment: 1 },
            category: input.values.category,
            title: input.values.title,
            summary: input.values.summary,
          },
        });
        if (!updated.count) {
          const exists = await transaction.classifierResultSnapshot.findUnique({
            where: { runId: input.id },
            select: { runId: true },
          });
          throw new ClassifierResultsError(
            exists ? "VERSION_CONFLICT" : "NOT_FOUND",
          );
        }
        const row = await transaction.classifierFeedback.create({
          data: {
            resultId: input.id,
            version: input.expectedVersion + 1,
            commandKey: input.commandKey,
            requestHash: input.requestHash,
            actorId: input.actorId,
            values: json(input.values),
          },
        });
        return { feedback: feedback(row), replayed: false };
      });
    } catch (error) {
      if (
        error instanceof ClassifierResultsError ||
        (error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002")
      ) {
        const existing = await client.classifierFeedback.findUnique({
          where: { commandKey: input.commandKey },
        });
        if (existing) return replay(existing);
      }
      throw error;
    }
  },
});
