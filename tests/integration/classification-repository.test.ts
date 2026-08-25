import { createHash } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createClassificationRepository,
  createDatabase,
  type Database,
} from "@hn-knowledge/db";
import { contentDecisionId, hnItemId } from "@hn-knowledge/domain";

const databaseUrl =
  process.env["DATABASE_URL"] ??
  "postgresql://hn_knowledge:hn_knowledge@127.0.0.1:5432/hn_knowledge";
const database: Database = createDatabase({ connectionString: databaseUrl });
const repository = createClassificationRepository(database.client);
const commentId = hnItemId(9001);
const now = new Date("2026-08-24T12:00:00.000Z");
const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const clean = async (): Promise<void> => {
  await database.client.$executeRawUnsafe(
    'TRUNCATE TABLE "evidence_spans", "content_decisions", "classification_runs" CASCADE',
  );
  await database.client.hnItem.deleteMany({ where: { id: BigInt(commentId) } });
};

const prepareComment = async (): Promise<void> => {
  await database.client.hnItem.create({
    data: {
      id: BigInt(commentId),
      type: "comment",
      parentId: null,
      author: "fixture",
      time: now,
      title: null,
      textHtml: "<p>Fixture</p>",
      textPlain: "Fixture",
      url: null,
      availability: "AVAILABLE",
      fetchedAt: now,
      responseHash: hash("response"),
      selectedComment: {
        create: {
          rootId: BigInt(commentId),
          canonicalHtml: "<p>Fixture</p>",
          canonicalText: "Fixture",
          contentHash: hash("Fixture"),
          availability: "AVAILABLE",
          firstSeenAt: now,
          lastSeenAt: now,
        },
      },
    },
  });
};

beforeEach(async () => {
  await clean();
  await prepareComment();
});
afterEach(clean);
afterAll(async () => database.close());

const successfulRun = (inputHash = hash("input")) => ({
  commentId,
  inputHash,
  promptVersion: "classification-prompt.v1",
  promptHash: hash("prompt"),
  schemaVersion: "classification.v1",
  modelConfigId: "fixture-v1",
  provider: "fixture",
  modelId: "gold-replay-v1",
  outputHash: hash("output"),
  providerOutput: { schema_version: "classification.v1" },
  latencyMs: 3,
  inputTokens: 120,
  cachedInputTokens: 80,
  cacheWriteInputTokens: 20,
  outputTokens: 42,
  status: "SUCCEEDED" as const,
  errorCode: null,
});

describe("classification repository", () => {
  it("is idempotent for the same logical run and appends changed inputs", async () => {
    const [first, duplicate] = await Promise.all([
      repository.recordRun(successfulRun()),
      repository.recordRun(successfulRun()),
    ]);
    const changed = await repository.recordRun(successfulRun(hash("input-2")));

    expect(first.run.id).toBe(duplicate.run.id);
    expect(new Set([first.created, duplicate.created])).toEqual(
      new Set([true, false]),
    );
    expect(first.run).toMatchObject({
      inputTokens: 120,
      cachedInputTokens: 80,
      cacheWriteInputTokens: 20,
      outputTokens: 42,
    });
    expect(changed.run.id).not.toBe(first.run.id);
    expect(await database.client.classificationRun.count()).toBe(2);
  });

  it("enforces immutable run, decision, and evidence history in PostgreSQL", async () => {
    const { run } = await repository.recordRun(successfulRun());
    const decision = await repository.saveDecision({
      commentId,
      classificationRunId: run.id,
      source: "MODEL",
      primaryDecision: "EXPERT_NOTE",
      decisionConfidence: 0.93,
      materiallyTechnical: true,
      reviewRequired: false,
      validatedOutput: { primary_decision: "EXPERT_NOTE" },
      manualOverrideOfId: null,
      evidenceSpans: [
        {
          spanId: "span:0",
          sourceDocument: `hn:item:${commentId}`,
          origin: "COMMENT",
          start: 0,
          end: 7,
          textHash: hash("Fixture"),
        },
      ],
    });

    await expect(
      database.client.classificationRun.update({
        where: { id: run.id },
        data: { latencyMs: 99 },
      }),
    ).rejects.toThrow(/append-only/u);
    await expect(
      database.client.contentDecision.delete({ where: { id: decision.id } }),
    ).rejects.toThrow(/append-only/u);
    await expect(
      database.client.evidenceSpan.update({
        where: { id: decision.evidenceSpans[0]?.id ?? "missing" },
        data: { textHash: hash("changed") },
      }),
    ).rejects.toThrow(/append-only/u);
  });

  it("appends manual decisions but reserves activation for review", async () => {
    const { run } = await repository.recordRun(successfulRun());
    const modelDecision = await repository.saveDecision({
      commentId,
      classificationRunId: run.id,
      source: "MODEL",
      primaryDecision: "DISCOVERY",
      decisionConfidence: 0.8,
      materiallyTechnical: true,
      reviewRequired: true,
      validatedOutput: { primary_decision: "DISCOVERY" },
      manualOverrideOfId: null,
      evidenceSpans: [],
    });
    const manualDecision = await repository.saveDecision({
      commentId,
      classificationRunId: null,
      source: "MANUAL",
      primaryDecision: "REJECTED",
      decisionConfidence: 1,
      materiallyTechnical: false,
      reviewRequired: false,
      validatedOutput: { primary_decision: "REJECTED" },
      manualOverrideOfId: modelDecision.id,
      evidenceSpans: [],
    });

    await expect(
      database.client.selectedComment.update({
        where: { id: BigInt(commentId) },
        data: { activeDecisionId: manualDecision.id },
      }),
    ).rejects.toThrow(/active decision requires approved review/u);
    await expect(repository.getActiveDecision(commentId)).resolves.toBeNull();
    expect(await database.client.contentDecision.count()).toBe(2);
  });

  it("rejects evidence spans whose decision foreign key does not exist", async () => {
    await expect(
      database.client.evidenceSpan.create({
        data: {
          contentDecisionId: contentDecisionId(
            "00000000-0000-4000-8000-000000000000",
          ),
          spanId: "span:0",
          sourceDocument: `hn:item:${commentId}`,
          origin: "COMMENT",
          startOffset: 0,
          endOffset: 7,
          textHash: hash("Fixture"),
        },
      }),
    ).rejects.toThrow();
  });
});
