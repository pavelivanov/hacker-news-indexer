import { createHash } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createReconcileHnItem,
  createReviewService,
  normalizeHnCommentHtml,
} from "@hn-knowledge/application";
import {
  createDatabase,
  createHnReconciliationRepository,
  createHnResolutionRepository,
  createReviewRepository,
  type Database,
} from "@hn-knowledge/db";
import {
  contentDecisionId,
  hnItemId,
  type HnFetchResult,
  type HnItem,
  type HnItemId,
} from "@hn-knowledge/domain";
import type { HnItems } from "@hn-knowledge/ports";

const databaseUrl =
  process.env["DATABASE_URL"] ??
  "postgresql://hn_knowledge:hn_knowledge@127.0.0.1:5432/hn_knowledge";
const database: Database = createDatabase({ connectionString: databaseUrl });
const hasher = {
  sha256: (value: string): string =>
    createHash("sha256").update(value).digest("hex"),
};
const repository = createHnReconciliationRepository(database.client);
const resolutions = createHnResolutionRepository(database.client);
const reviews = createReviewService(
  createReviewRepository(database.client),
  hasher,
);
const now = new Date("2026-08-26T15:00:00.000Z");
const later = new Date("2026-08-27T15:00:00.000Z");
const rootId = hnItemId(88_000);
const secondRootId = hnItemId(88_100);
const commentId = hnItemId(88_001);

const clean = async (): Promise<void> => {
  await database.client.$executeRawUnsafe(
    'TRUNCATE TABLE "ingestion_runs", "selection_occurrences", "hn_items" CASCADE',
  );
};

beforeEach(clean);
afterEach(clean);
afterAll(async () => database.close());

const item = (
  id: HnItemId,
  input: Partial<HnItem> & Pick<HnItem, "type" | "responseHash">,
): HnItem => ({
  id,
  type: input.type,
  parentId: input.parentId ?? null,
  author: input.author ?? "fixture",
  time: input.time ?? now,
  title: input.title ?? null,
  textHtml: input.textHtml ?? null,
  url: input.url ?? null,
  availability: input.availability ?? "AVAILABLE",
  fetchedAt: input.fetchedAt ?? now,
  responseHash: input.responseHash,
});

const root = (id: HnItemId, hash: string, fetchedAt = now): HnItem =>
  item(id, {
    type: "story",
    title: `Root ${id}`,
    textHtml: "<p>Root context</p>",
    responseHash: hash,
    fetchedAt,
  });

const comment = (
  text: string,
  hash: string,
  parentId: HnItemId = rootId,
  availability: HnItem["availability"] = "AVAILABLE",
): HnItem =>
  item(commentId, {
    type: "comment",
    parentId,
    textHtml: `<p>${text}</p>`,
    responseHash: hash,
    availability,
    fetchedAt: hash === "comment-old" ? now : later,
  });

const source = (items: readonly HnItem[]): HnItems => {
  const byId = new Map(
    items.map((value) => [Number(value.id), value] as const),
  );
  return {
    async get(id): Promise<HnFetchResult> {
      const value = byId.get(Number(id));
      return value === undefined
        ? {
            kind: "MISSING",
            id,
            fetchedAt: later,
            responseHash: `missing-${id}`,
          }
        : { kind: "ITEM", item: value };
    },
  };
};

const seed = async (): Promise<string> => {
  const rootItem = root(rootId, "root-old");
  const commentItem = comment("Original technical comment", "comment-old");
  await resolutions.saveItem(rootItem);
  await resolutions.saveItem(commentItem);
  const normalized = normalizeHnCommentHtml(
    commentItem.textHtml ?? "",
    `hn:item:${commentId}`,
    hasher,
  );
  await resolutions.saveResolution(
    {
      selectedCommentId: commentId,
      ancestorIds: [rootId],
      displayedStoryId: rootId,
      resolvedRootId: rootId,
      resolverVersion: "reconciliation-fixture.v1",
    },
    {
      id: commentId,
      rootId,
      canonicalHtml: normalized.canonicalHtml,
      canonicalText: normalized.canonicalText,
      contentHash: normalized.contentHash,
      availability: "AVAILABLE",
      firstSeenAt: now,
      lastSeenAt: now,
    },
    normalized.urlCandidates,
  );
  const run = await database.client.classificationRun.create({
    data: {
      commentId: BigInt(commentId),
      inputHash: "reconciliation-input",
      promptVersion: "fixture.v1",
      promptHash: "reconciliation-prompt",
      schemaVersion: "classification.v1",
      modelConfigId: "fixture",
      provider: "fixture",
      modelId: "fixture",
      outputHash: "reconciliation-output",
      status: "SUCCEEDED",
      createdAt: now,
    },
  });
  const decision = await database.client.contentDecision.create({
    data: {
      commentId: BigInt(commentId),
      classificationRunId: run.id,
      source: "MODEL",
      primaryDecision: "EXPERT_NOTE",
      decisionConfidence: 0.9,
      materiallyTechnical: true,
      reviewRequired: true,
      validatedOutput: {},
      createdAt: now,
    },
  });
  await database.client.expertNote.create({
    data: {
      selectedCommentId: BigInt(commentId),
      contentDecisionId: decision.id,
      noteType: "IMPLEMENTATION_CAVEAT",
      title: "Original note",
      summary: "Original technical comment",
      relatedSubjectNames: [],
      evidenceOrigin: "COMMENT",
      confidence: 0.9,
      status: "APPROVED",
      extractionVersion: "fixture.v1",
      createdAt: now,
      updatedAt: now,
    },
  });
  const opened = await reviews.openPolicyReview({
    commentId,
    contentDecisionId: contentDecisionId(decision.id),
    policy: {
      required: true,
      priority: "LOW",
      priorityScore: 1,
      reasons: ["UNPROMOTED_MODEL_DECISION"],
    },
  });
  await reviews.approve({
    taskId: opened.task.id,
    expectedVersion: 1,
    actorId: "reconciliation-test",
    commandKey: `approve-reconciliation:${decision.id}`,
    reason: "Approved before reconciliation",
  });
  return decision.id;
};

describe("HN reconciliation", () => {
  it("preserves canonical history, invalidates publication, and enqueues reclassification", async () => {
    const decisionId = await seed();
    const reconcile = createReconcileHnItem(
      source([
        comment("Changed technical comment", "comment-new"),
        root(rootId, "root-old", later),
      ]),
      repository,
      hasher,
    );

    const result = await reconcile(commentId);
    const replay = await reconcile(commentId);
    const selected = await database.client.selectedComment.findUniqueOrThrow({
      where: { id: BigInt(commentId) },
    });
    const revisions = await database.client.selectedCommentRevision.findMany({
      where: { selectedCommentId: BigInt(commentId) },
      orderBy: { revision: "asc" },
    });
    const note = await database.client.expertNote.findFirstOrThrow({
      where: { contentDecisionId: decisionId },
    });
    const divergence = await database.client.reviewTask.findFirstOrThrow({
      where: {
        contentDecisionId: decisionId,
        state: "OPEN",
        reasonCodes: { has: "TELEGRAM_HN_DIVERGENCE" },
      },
    });
    const classify = await database.client.pipelineJob.findFirstOrThrow({
      where: { type: "CLASSIFY_COMMENT" },
    });

    expect(result).toMatchObject({
      outcome: "CONTENT_CHANGED",
      changed: true,
      classificationEnqueued: true,
      reviewOpened: true,
      replayed: false,
    });
    expect(replay.replayed).toBe(true);
    expect(selected.activeDecisionId).toBeNull();
    expect(selected.canonicalText).toBe("Changed technical comment");
    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toMatchObject({
      revision: 1,
      canonicalText: "Original technical comment",
    });
    expect(revisions[1]).toMatchObject({
      revision: 2,
      canonicalText: "Changed technical comment",
    });
    expect(note).toMatchObject({
      status: "SUPERSEDED",
      publicationRevision: 2,
    });
    expect(divergence.revision).toBe(2);
    expect(classify.ingestionRunId).toBeNull();
  });

  it("preserves resolution paths when an HN comment is reparented", async () => {
    await seed();
    const newRoot = root(secondRootId, "root-second", later);
    const reconcile = createReconcileHnItem(
      source([
        comment(
          "Original technical comment",
          "comment-reparented",
          secondRootId,
        ),
        newRoot,
      ]),
      repository,
      hasher,
    );

    const result = await reconcile(commentId);
    const paths = await database.client.resolutionPathRevision.findMany({
      where: { selectedCommentId: BigInt(commentId) },
      orderBy: { revision: "asc" },
    });
    const selected = await database.client.selectedComment.findUniqueOrThrow({
      where: { id: BigInt(commentId) },
    });

    expect(result.outcome).toBe("ROOT_CHANGED");
    expect(paths.map((path) => Number(path.resolvedRootId))).toEqual([
      rootId,
      secondRootId,
    ]);
    expect(Number(selected.rootId)).toBe(secondRootId);
  });

  it("scrubs bodies and retracts publication when the selected item disappears", async () => {
    await seed();
    const reconcile = createReconcileHnItem(
      source([root(rootId, "root-old")]),
      repository,
      hasher,
    );

    const result = await reconcile(commentId);
    const itemRow = await database.client.hnItem.findUniqueOrThrow({
      where: { id: BigInt(commentId) },
    });
    const itemRevisions = await database.client.hnItemRevision.findMany({
      where: { hnItemId: BigInt(commentId) },
    });
    const commentRevisions =
      await database.client.selectedCommentRevision.findMany({
        where: { selectedCommentId: BigInt(commentId) },
      });
    const selected = await database.client.selectedComment.findUniqueOrThrow({
      where: { id: BigInt(commentId) },
    });
    const tombstoneReview = await database.client.reviewTask.findFirstOrThrow({
      where: {
        state: "OPEN",
        reasonCodes: { has: "DELETED_OR_FLAGGED_CONTENT" },
      },
    });

    expect(result).toMatchObject({
      outcome: "TOMBSTONED",
      classificationEnqueued: false,
      reviewOpened: true,
    });
    expect(itemRow).toMatchObject({
      availability: "MISSING",
      textHtml: null,
      textPlain: null,
      url: null,
    });
    expect(itemRevisions.every((revision) => revision.textHtml === null)).toBe(
      true,
    );
    expect(
      commentRevisions.every(
        (revision) =>
          revision.canonicalHtml === null && revision.canonicalText === null,
      ),
    ).toBe(true);
    expect(selected).toMatchObject({
      availability: "MISSING",
      canonicalHtml: "",
      canonicalText: "",
      activeDecisionId: null,
    });
    expect(tombstoneReview.revision).toBe(2);
  });

  it("schedules each selected comment once per schedule key", async () => {
    await seed();

    const first = await repository.schedule("2026-08-26", later, 100);
    const second = await repository.schedule("2026-08-26", later, 100);
    const jobs = await database.client.pipelineJob.findMany({
      where: { type: "RECONCILE_HN_ITEM" },
    });

    expect(first).toEqual({ lockAcquired: true, scheduled: 1 });
    expect(second).toEqual({ lockAcquired: true, scheduled: 0 });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.availableAt).toEqual(later);
  });
});
