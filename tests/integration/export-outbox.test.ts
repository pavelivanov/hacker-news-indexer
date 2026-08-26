import { createHash } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFindThatProjectExportService,
  createReviewService,
  FindThatProjectExportError,
} from "@hn-knowledge/application";
import { isFindThatProjectOutboxV1 } from "@hn-knowledge/contracts";
import {
  createDatabase,
  createFindThatProjectExportRepository,
  createReviewRepository,
  type Database,
} from "@hn-knowledge/db";
import { contentDecisionId, discoveryId, hnItemId } from "@hn-knowledge/domain";

const databaseUrl =
  process.env["DATABASE_URL"] ??
  "postgresql://hn_knowledge:hn_knowledge@127.0.0.1:5432/hn_knowledge";
const database: Database = createDatabase({ connectionString: databaseUrl });
const hasher = {
  sha256: (value: string): string =>
    createHash("sha256").update(value).digest("hex"),
};
const repository = createFindThatProjectExportRepository(database.client);
const service = createFindThatProjectExportService(repository, hasher, {
  cursorSecret: "export-integration-cursor-secret",
});
const reviews = createReviewService(
  createReviewRepository(database.client),
  hasher,
);
const observedAt = new Date("2026-08-26T12:00:00.000Z");
const rootId = 88_000;
const commentId = 88_001;

const clean = async (): Promise<void> => {
  await database.client.$executeRawUnsafe(
    'TRUNCATE TABLE "ingestion_runs", "selection_occurrences", "hn_items" CASCADE',
  );
};

beforeEach(clean);
afterAll(async () => database.close());

const seedEligibleDiscovery = async (): Promise<{
  readonly discoveryId: string;
  readonly sourceId: string;
}> => {
  const commentText =
    "UsefulTool provides a grounded full-text and semantic search index.";
  await database.client.hnItem.create({
    data: {
      id: BigInt(rootId),
      type: "story",
      author: "export-root",
      time: observedAt,
      title: "UsefulTool launch",
      textPlain: "UsefulTool project page",
      url: "https://usefultool.example",
      availability: "AVAILABLE",
      fetchedAt: observedAt,
      responseHash: "export-root-hash",
    },
  });
  await database.client.hnItem.create({
    data: {
      id: BigInt(commentId),
      type: "comment",
      parentId: BigInt(rootId),
      author: "export-comment",
      time: observedAt,
      textHtml: `<p>${commentText}</p>`,
      textPlain: commentText,
      availability: "AVAILABLE",
      fetchedAt: observedAt,
      responseHash: "export-comment-hash",
    },
  });
  await database.client.selectedComment.create({
    data: {
      id: BigInt(commentId),
      rootId: BigInt(rootId),
      canonicalHtml: `<p>${commentText}</p>`,
      canonicalText: commentText,
      contentHash: "export-selected-hash",
      availability: "AVAILABLE",
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
      resolutionPath: {
        create: {
          ancestorIds: [BigInt(rootId)],
          displayedStoryId: BigInt(rootId),
          resolvedRootId: BigInt(rootId),
          resolverVersion: "export-fixture.v1",
          resolvedAt: observedAt,
        },
      },
    },
  });
  const occurrence = await database.client.selectionOccurrence.create({
    data: {
      source: "TELEGRAM",
      sourceKey: "hn_best_comments",
      externalId: 32_944n,
      occurredAt: observedAt,
      contentHash: "export-occurrence-hash",
      status: "RESOLVED",
    },
  });
  await database.client.hnReference.create({
    data: {
      occurrenceId: occurrence.id,
      hnItemId: BigInt(commentId),
      role: "SELECTED_COMMENT",
      entityOffset: 0,
      entityLength: 1,
      parseConfidence: 1,
    },
  });
  const run = await database.client.classificationRun.create({
    data: {
      commentId: BigInt(commentId),
      inputHash: "export-input",
      promptVersion: "export.v1",
      promptHash: "export-prompt",
      schemaVersion: "classification.v1",
      modelConfigId: "export-fixture",
      provider: "fixture",
      modelId: "fixture",
      outputHash: "export-output",
      status: "REVIEW",
      createdAt: observedAt,
    },
  });
  const decision = await database.client.contentDecision.create({
    data: {
      commentId: BigInt(commentId),
      classificationRunId: run.id,
      source: "MODEL",
      primaryDecision: "DISCOVERY",
      decisionConfidence: 0.98,
      materiallyTechnical: true,
      reviewRequired: true,
      validatedOutput: {},
      createdAt: observedAt,
      evidenceSpans: {
        create: {
          spanId: "span:comment:0",
          sourceDocument: `comment:${commentId}`,
          origin: "COMMENT",
          startOffset: 0,
          endOffset: commentText.length,
          textHash: hasher.sha256(commentText),
          createdAt: observedAt,
        },
      },
    },
    include: { evidenceSpans: true },
  });
  const canonicalUrl = await database.client.urlCandidate.create({
    data: {
      hnItemId: BigInt(rootId),
      rawUrl: "https://usefultool.example/project",
      canonicalUrl: "https://usefultool.example/project",
      sourceDocument: `hn:item:${rootId}`,
      originField: "story_url",
      scheme: "https",
      host: "usefultool.example",
      validationState: "VALID",
      contentHash: "export-url-hash",
      classifierEligible: false,
    },
  });
  const subject = await database.client.subject.create({
    data: {
      type: "TOOL",
      name: "UsefulTool",
      normalizedName: "usefultool",
      dedupKey: "export-usefultool",
      identityBasis: "CANONICAL_URL",
      canonicalUrlCandidateId: canonicalUrl.id,
      contextKey: "export-fixture",
      createdFromDecisionId: decision.id,
      createdAt: observedAt,
      updatedAt: observedAt,
    },
  });
  const discovery = await database.client.discovery.create({
    data: {
      subjectId: subject.id,
      identityKey: "export-discovery",
      rootStoryOnly: false,
      extractionVersion: "export.v1",
      status: "REVIEW_PENDING",
      createdAt: observedAt,
      updatedAt: observedAt,
    },
  });
  const source = await database.client.discoverySource.create({
    data: {
      discoveryId: discovery.id,
      selectedCommentId: BigInt(commentId),
      contentDecisionId: decision.id,
      sourceOrdinal: 0,
      descriptionClaim: "Personal full-text and semantic search index",
      evidenceOrigin: "COMMENT",
      confidence: 0.98,
      createdAt: observedAt,
    },
  });
  await database.client.discoverySourceEvidence.create({
    data: {
      discoverySourceId: source.id,
      evidenceSpanId: decision.evidenceSpans[0]?.id ?? "missing",
    },
  });
  const mention = await database.client.subjectMention.create({
    data: {
      subjectId: subject.id,
      selectedCommentId: BigInt(commentId),
      contentDecisionId: decision.id,
      sourceKind: "DISCOVERY",
      sourceOrdinal: 0,
      evidenceOrigin: "COMMENT",
      confidence: 0.98,
      extractionVersion: "export.v1",
      createdAt: observedAt,
    },
  });
  await database.client.subjectMentionEvidence.create({
    data: {
      subjectMentionId: mention.id,
      evidenceSpanId: decision.evidenceSpans[0]?.id ?? "missing",
    },
  });
  const review = await reviews.openPolicyReview({
    commentId: hnItemId(commentId),
    contentDecisionId: contentDecisionId(decision.id),
    policy: {
      required: true,
      reasons: ["UNPROMOTED_MODEL_DECISION"],
      priority: "LOW",
      priorityScore: 25,
    },
  });
  await reviews.approve({
    taskId: review.task.id,
    expectedVersion: 1,
    actorId: "integration-owner",
    commandKey: "approve-content-for-export",
    reason: "Grounded Discovery approved for local publication",
  });
  await expect(
    database.client.discovery.findUniqueOrThrow({
      where: { id: discovery.id },
    }),
  ).resolves.toMatchObject({ status: "APPROVED" });
  return { discoveryId: discovery.id, sourceId: source.id };
};

const requestExportReview = (rawDiscoveryId: string, suffix = "1") =>
  service.requestReview({
    discoveryId: rawDiscoveryId,
    actorId: "integration-owner",
    commandKey: `request-export-${suffix}`,
    reason: "Request explicit FindThatProject export review",
  });

const approveExportReview = (taskId: string, suffix = "1") =>
  service.approveReview({
    taskId,
    expectedVersion: 1,
    actorId: "integration-owner",
    commandKey: `approve-export-${suffix}`,
    reason: "Manually verified URL, subject, summary, evidence, and provenance",
  });

describe("FindThatProject export outbox", () => {
  it("opens and approves one export atomically and replays identical commands", async () => {
    const seeded = await seedEligibleDiscovery();
    const task = await requestExportReview(seeded.discoveryId);
    await expect(requestExportReview(seeded.discoveryId)).resolves.toEqual(
      task,
    );

    const approved = await approveExportReview(task.id);
    const replayed = await approveExportReview(task.id);

    expect(replayed).toEqual(approved);
    expect(approved.revision).toMatchObject({
      revision: 1,
      action: "UPSERT",
      deliveryState: "PENDING",
      reviewTaskId: task.id,
    });
    expect(approved.revision.payload).toMatchObject({
      kind: "DISCOVERY",
      subject: { name: "UsefulTool", type: "TOOL" },
      provenance: { telegram_message_ids: [32_944] },
    });
    await expect(database.client.exportOutbox.count()).resolves.toBe(1);
    await expect(database.client.manualOverrideEvent.count()).resolves.toBe(4);
  });

  it("fails closed when eligibility changes after the reviewer saw the snapshot", async () => {
    const seeded = await seedEligibleDiscovery();
    const task = await requestExportReview(seeded.discoveryId);
    await database.client.discoverySource.update({
      where: { id: seeded.sourceId },
      data: { descriptionClaim: "Changed after review opened" },
    });

    await expect(approveExportReview(task.id)).rejects.toMatchObject({
      code: "SNAPSHOT_CHANGED",
    });
    await expect(database.client.exportOutbox.count()).resolves.toBe(0);
    await expect(
      database.client.reviewTask.findUniqueOrThrow({ where: { id: task.id } }),
    ).resolves.toMatchObject({ state: "OPEN", version: 1 });
  });

  it("allows only one concurrent approval to append the first revision", async () => {
    const seeded = await seedEligibleDiscovery();
    const task = await requestExportReview(seeded.discoveryId);
    const outcomes = await Promise.allSettled([
      approveExportReview(task.id, "concurrent-a"),
      approveExportReview(task.id, "concurrent-b"),
    ]);

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1);
    await expect(database.client.exportOutbox.count()).resolves.toBe(1);
    await expect(
      database.client.reviewTask.findUniqueOrThrow({ where: { id: task.id } }),
    ).resolves.toMatchObject({ state: "APPROVED", version: 2 });
  });

  it("supports correction, acknowledgement isolation, retraction, and replay", async () => {
    const seeded = await seedEligibleDiscovery();
    const firstTask = await requestExportReview(seeded.discoveryId);
    const first = await approveExportReview(firstTask.id);
    const firstAck = await service.acknowledge({
      exportId: first.revision.exportId,
      revision: 1,
      payloadHash: first.revision.payloadHash,
      idempotencyKey: "ack-export-1",
    });
    expect(firstAck.replayed).toBe(false);
    await expect(
      service.acknowledge({
        exportId: first.revision.exportId,
        revision: 1,
        payloadHash: first.revision.payloadHash,
        idempotencyKey: "ack-export-1",
      }),
    ).resolves.toMatchObject({ replayed: true });

    await database.client.discoverySource.update({
      where: { id: seeded.sourceId },
      data: {
        descriptionClaim:
          "Corrected personal full-text and semantic search index",
      },
    });
    const secondTask = await requestExportReview(seeded.discoveryId, "2");
    const second = await approveExportReview(secondTask.id, "2");
    expect(second.revision).toMatchObject({
      exportId: first.revision.exportId,
      revision: 2,
      action: "UPSERT",
      deliveryState: "PENDING",
    });
    const page = await service.getOutbox({ cursor: null, limit: 100 });
    expect(page.items.map((item) => item.revision)).toEqual([2]);
    expect(isFindThatProjectOutboxV1(page)).toBe(true);

    const retracted = await repository.retract(
      discoveryId(seeded.discoveryId),
      "DISCOVERY_REJECTED",
    );
    const replayedRetraction = await repository.retract(
      discoveryId(seeded.discoveryId),
      "DISCOVERY_REJECTED",
    );
    expect(retracted).toMatchObject({
      kind: "RETRACTED",
      revision: { revision: 3, action: "RETRACT" },
      replayed: false,
    });
    expect(replayedRetraction).toMatchObject({ replayed: true });
    await expect(database.client.exportOutbox.count()).resolves.toBe(3);
    await expect(
      database.client.exportOutbox.delete({
        where: { id: first.revision.id },
      }),
    ).rejects.toThrow(/export history is append-only/u);
  });

  it("rejects unsafe candidates and stale acknowledgement hashes", async () => {
    const seeded = await seedEligibleDiscovery();
    await database.client.discovery.update({
      where: { id: seeded.discoveryId },
      data: { status: "REJECTED" },
    });
    await expect(requestExportReview(seeded.discoveryId)).rejects.toMatchObject(
      {
        code: "INELIGIBLE",
        details: {
          reasons: expect.arrayContaining(["DISCOVERY_NOT_APPROVED"]),
        },
      },
    );

    await database.client.discovery.update({
      where: { id: seeded.discoveryId },
      data: { status: "APPROVED" },
    });
    const task = await requestExportReview(seeded.discoveryId, "safe");
    const approved = await approveExportReview(task.id, "safe");
    await expect(
      service.acknowledge({
        exportId: approved.revision.exportId,
        revision: approved.revision.revision,
        payloadHash: "0".repeat(64),
        idempotencyKey: "wrong-hash",
      }),
    ).rejects.toBeInstanceOf(FindThatProjectExportError);
    await expect(database.client.exportAcknowledgement.count()).resolves.toBe(
      0,
    );
  });
});
