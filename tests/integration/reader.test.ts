import { createHash } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createKnowledgeReader,
  createReviewService,
  KnowledgeReaderError,
} from "@hn-knowledge/application";
import {
  isKnowledgeFeedV1,
  isReaderCommentV1,
  isReaderStoryV1,
  isReaderSubjectNotesV1,
  isReaderSubjectV1,
} from "@hn-knowledge/contracts";
import {
  createDatabase,
  createKnowledgeReaderRepository,
  createReviewRepository,
  type Database,
} from "@hn-knowledge/db";
import { contentDecisionId, hnItemId } from "@hn-knowledge/domain";

const databaseUrl =
  process.env["DATABASE_URL"] ??
  "postgresql://hn_knowledge:hn_knowledge@127.0.0.1:5432/hn_knowledge";
const database: Database = createDatabase({ connectionString: databaseUrl });
const reviewService = createReviewService(
  createReviewRepository(database.client),
  {
    sha256: (value) => createHash("sha256").update(value).digest("hex"),
  },
);
const publishedAt = new Date("2026-08-26T12:00:00.000Z");
const rootId = 78_000;
const discoveryCommentId = 78_001;
const noteCommentId = 78_002;

const clean = async (): Promise<void> => {
  await database.client.$executeRawUnsafe(
    'TRUNCATE TABLE "ingestion_runs", "selection_occurrences", "hn_items" CASCADE',
  );
};

beforeEach(clean);
afterEach(clean);
afterAll(async () => database.close());

const createSelectedComment = async (
  id: number,
  text: string,
  externalId: number,
): Promise<void> => {
  await database.client.hnItem.create({
    data: {
      id: BigInt(id),
      type: "comment",
      parentId: BigInt(rootId),
      author: `reader-${id}`,
      time: publishedAt,
      textHtml: `<p>${text}</p>`,
      textPlain: text,
      availability: "AVAILABLE",
      fetchedAt: publishedAt,
      responseHash: `item-${id}`,
    },
  });
  await database.client.selectedComment.create({
    data: {
      id: BigInt(id),
      rootId: BigInt(rootId),
      canonicalHtml: `<p>${text}</p>`,
      canonicalText: text,
      contentHash: `comment-${id}`,
      availability: "AVAILABLE",
      firstSeenAt: publishedAt,
      lastSeenAt: publishedAt,
      resolutionPath: {
        create: {
          ancestorIds: [BigInt(rootId)],
          displayedStoryId: BigInt(rootId),
          resolvedRootId: BigInt(rootId),
          resolverVersion: "reader-fixture.v1",
          resolvedAt: publishedAt,
        },
      },
    },
  });
  const occurrence = await database.client.selectionOccurrence.create({
    data: {
      source: "FIXTURE",
      sourceKey: "reader-test",
      externalId: BigInt(externalId),
      occurredAt: publishedAt,
      contentHash: `occurrence-${externalId}`,
      status: "RESOLVED",
    },
  });
  await database.client.hnReference.create({
    data: {
      occurrenceId: occurrence.id,
      hnItemId: BigInt(id),
      role: "SELECTED_COMMENT",
      entityOffset: 0,
      entityLength: 1,
      parseConfidence: 1,
    },
  });
};

const approveDecision = async (
  comment: number,
  decision: string,
): Promise<void> => {
  const opened = await reviewService.openPolicyReview({
    commentId: hnItemId(comment),
    contentDecisionId: contentDecisionId(decision),
    policy: {
      required: true,
      priority: "LOW",
      priorityScore: 1,
      reasons: ["UNPROMOTED_MODEL_DECISION"],
    },
  });
  await reviewService.approve({
    taskId: opened.task.id,
    expectedVersion: opened.task.version,
    actorId: "reader-test",
    commandKey: `reader-approve:${decision}`,
    reason: "Approved for reader integration test",
  });
};

const seedPublishedContent = async (): Promise<{
  readonly discoveryDecisionId: string;
  readonly subjectId: string;
}> => {
  await database.client.hnItem.create({
    data: {
      id: BigInt(rootId),
      type: "story",
      author: "reader-root",
      time: publishedAt,
      title: "Reader root story",
      textHtml:
        '<p>Root evidence <a href="https://example.com/?secret=1">link</a></p>',
      textPlain: "Root evidence link",
      url: "https://example.com/story?private=1#fragment",
      availability: "AVAILABLE",
      fetchedAt: publishedAt,
      responseHash: "root",
    },
  });
  await createSelectedComment(
    discoveryCommentId,
    "UsefulTool is a useful discovery.",
    1,
  );
  await createSelectedComment(
    noteCommentId,
    "UsefulTool needs a careful configuration.",
    2,
  );

  const discoveryRun = await database.client.classificationRun.create({
    data: {
      commentId: BigInt(discoveryCommentId),
      inputHash: "reader-discovery-input",
      promptVersion: "reader.v1",
      promptHash: "reader-discovery-prompt",
      schemaVersion: "classification.v1",
      modelConfigId: "reader-fixture",
      provider: "fixture",
      modelId: "fixture",
      outputHash: "reader-discovery-output",
      status: "SUCCEEDED",
      createdAt: publishedAt,
    },
  });
  const discoveryDecision = await database.client.contentDecision.create({
    data: {
      commentId: BigInt(discoveryCommentId),
      classificationRunId: discoveryRun.id,
      source: "MODEL",
      primaryDecision: "DISCOVERY",
      decisionConfidence: 0.95,
      materiallyTechnical: true,
      reviewRequired: true,
      validatedOutput: {},
      createdAt: publishedAt,
      evidenceSpans: {
        create: {
          spanId: "span:0",
          sourceDocument: `comment:${discoveryCommentId}`,
          origin: "COMMENT",
          startOffset: 0,
          endOffset: 10,
          textHash: "discovery-evidence",
          createdAt: publishedAt,
        },
      },
    },
    include: { evidenceSpans: true },
  });
  const canonicalUrl = await database.client.urlCandidate.create({
    data: {
      hnItemId: BigInt(rootId),
      rawUrl: "https://usefultool.example/docs?private=1",
      canonicalUrl: "https://usefultool.example/docs?private=1",
      sourceDocument: `hn:item:${rootId}`,
      originField: "story_url",
      scheme: "https",
      host: "usefultool.example",
      validationState: "VALID",
      contentHash: "subject-url",
    },
  });
  const subject = await database.client.subject.create({
    data: {
      type: "TOOL",
      name: "UsefulTool",
      normalizedName: "usefultool",
      dedupKey: "reader-usefultool",
      identityBasis: "CANONICAL_URL",
      canonicalUrlCandidateId: canonicalUrl.id,
      contextKey: "reader",
      createdFromDecisionId: discoveryDecision.id,
      createdAt: publishedAt,
      updatedAt: publishedAt,
      aliases: {
        create: {
          alias: "Useful Tool",
          normalizedAlias: "useful tool",
          contentDecisionId: discoveryDecision.id,
          createdAt: publishedAt,
        },
      },
    },
  });
  const discovery = await database.client.discovery.create({
    data: {
      subjectId: subject.id,
      identityKey: "reader-discovery",
      rootStoryOnly: false,
      extractionVersion: "reader.v1",
      status: "REVIEW_PENDING",
      createdAt: publishedAt,
      updatedAt: publishedAt,
    },
  });
  const discoverySource = await database.client.discoverySource.create({
    data: {
      discoveryId: discovery.id,
      selectedCommentId: BigInt(discoveryCommentId),
      contentDecisionId: discoveryDecision.id,
      sourceOrdinal: 0,
      descriptionClaim: "UsefulTool is a useful discovery.",
      evidenceOrigin: "COMMENT",
      confidence: 0.95,
      createdAt: publishedAt,
    },
  });
  await database.client.discoverySourceEvidence.create({
    data: {
      discoverySourceId: discoverySource.id,
      evidenceSpanId: discoveryDecision.evidenceSpans[0]?.id ?? "missing",
    },
  });
  await approveDecision(discoveryCommentId, discoveryDecision.id);

  const noteRun = await database.client.classificationRun.create({
    data: {
      commentId: BigInt(noteCommentId),
      inputHash: "reader-note-input",
      promptVersion: "reader.v1",
      promptHash: "reader-note-prompt",
      schemaVersion: "classification.v1",
      modelConfigId: "reader-fixture",
      provider: "fixture",
      modelId: "fixture",
      outputHash: "reader-note-output",
      status: "SUCCEEDED",
      createdAt: publishedAt,
    },
  });
  const noteDecision = await database.client.contentDecision.create({
    data: {
      commentId: BigInt(noteCommentId),
      classificationRunId: noteRun.id,
      source: "MODEL",
      primaryDecision: "EXPERT_NOTE",
      decisionConfidence: 0.9,
      materiallyTechnical: true,
      reviewRequired: true,
      validatedOutput: {},
      createdAt: publishedAt,
      evidenceSpans: {
        create: {
          spanId: "span:0",
          sourceDocument: `comment:${noteCommentId}`,
          origin: "COMMENT",
          startOffset: 0,
          endOffset: 10,
          textHash: "note-evidence",
          createdAt: publishedAt,
        },
      },
    },
    include: { evidenceSpans: true },
  });
  const note = await database.client.expertNote.create({
    data: {
      selectedCommentId: BigInt(noteCommentId),
      contentDecisionId: noteDecision.id,
      noteType: "IMPLEMENTATION_CAVEAT",
      title: "UsefulTool configuration caveat",
      summary: "UsefulTool needs a careful configuration.",
      relatedSubjectNames: ["UsefulTool"],
      evidenceOrigin: "COMMENT",
      confidence: 0.9,
      extractionVersion: "reader.v1",
      status: "REVIEW_PENDING",
      createdAt: publishedAt,
      updatedAt: publishedAt,
      subjects: { create: { subjectId: subject.id } },
    },
  });
  await database.client.expertNoteEvidence.create({
    data: {
      expertNoteId: note.id,
      evidenceSpanId: noteDecision.evidenceSpans[0]?.id ?? "missing",
    },
  });
  await approveDecision(noteCommentId, noteDecision.id);
  await database.client.selectedComment.update({
    where: { id: BigInt(discoveryCommentId) },
    data: { activeDecisionId: null },
  });
  return { discoveryDecisionId: discoveryDecision.id, subjectId: subject.id };
};

describe("knowledge reader repository", () => {
  it("excludes inactive decisions, then returns strict approved read models", async () => {
    const seeded = await seedPublishedContent();
    const reader = createKnowledgeReader(
      createKnowledgeReaderRepository(database.client),
      { cursorSecret: "reader-integration-secret", now: () => publishedAt },
    );

    const beforeApproval = await reader.getFeed({
      kind: "discovery",
      cursor: null,
    });
    expect(beforeApproval.items).toEqual([]);

    await database.client.selectedComment.update({
      where: { id: BigInt(discoveryCommentId) },
      data: { activeDecisionId: seeded.discoveryDecisionId },
    });
    const feed = await reader.getFeed({ kind: "discovery", cursor: null });
    const comment = await reader.getComment(discoveryCommentId);
    const story = await reader.getStory(rootId);
    const subject = await reader.getSubject(seeded.subjectId);
    const notes = await reader.getSubjectNotes({
      subjectId: seeded.subjectId,
      cursor: null,
    });

    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({
      status: "APPROVED",
      selected_comment_id: discoveryCommentId,
      resolved_root_id: rootId,
      source_occurrence_ids: [expect.any(String)],
    });
    expect(comment.items).toHaveLength(1);
    expect(story.items).toHaveLength(2);
    expect(story.url).toBe("https://example.com/story");
    expect(story.body_html).toContain('rel="noopener noreferrer nofollow"');
    expect(subject).not.toHaveProperty("description");
    expect(subject.canonical_url).toBe("https://usefultool.example/docs");
    expect(notes.items).toHaveLength(1);
    expect(isKnowledgeFeedV1(feed)).toBe(true);
    expect(isReaderCommentV1(comment)).toBe(true);
    expect(isReaderStoryV1(story)).toBe(true);
    expect(isReaderSubjectV1(subject)).toBe(true);
    expect(isReaderSubjectNotesV1(notes)).toBe(true);
  });

  it("retracts deleted comments from the feed and comment route", async () => {
    const seeded = await seedPublishedContent();
    await database.client.selectedComment.update({
      where: { id: BigInt(discoveryCommentId) },
      data: {
        activeDecisionId: seeded.discoveryDecisionId,
        availability: "DELETED",
        canonicalHtml: "",
        canonicalText: "",
      },
    });
    await database.client.hnItem.update({
      where: { id: BigInt(discoveryCommentId) },
      data: {
        availability: "DELETED",
        textHtml: null,
        textPlain: null,
      },
    });
    const reader = createKnowledgeReader(
      createKnowledgeReaderRepository(database.client),
      { cursorSecret: "reader-integration-secret" },
    );

    expect(
      (await reader.getFeed({ kind: "discovery", cursor: null })).items,
    ).toEqual([]);
    await expect(reader.getComment(discoveryCommentId)).rejects.toBeInstanceOf(
      KnowledgeReaderError,
    );
  });
});
