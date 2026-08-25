import { createHash } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createMaterializeClassification,
  createReviewService,
  loadClassifierInput,
  normalizeHnCommentHtml,
  validateClassifierOutput,
} from "@hn-knowledge/application";
import type { ClassificationV1 } from "@hn-knowledge/contracts";
import {
  createClassificationRepository,
  createDatabase,
  createHnResolutionRepository,
  createReviewRepository,
  createSubjectMaterializationRepository,
  type Database,
} from "@hn-knowledge/db";
import {
  createSubjectIdentity,
  hnItemId,
  reviewTaskId,
  subjectId,
  urlCandidateId,
  type ContentDecision,
  type HnItemId,
} from "@hn-knowledge/domain";
import type { BoundedClassifierInput } from "@hn-knowledge/ports";

const databaseUrl =
  process.env["DATABASE_URL"] ??
  "postgresql://hn_knowledge:hn_knowledge@127.0.0.1:5432/hn_knowledge";
const database: Database = createDatabase({ connectionString: databaseUrl });
const classifications = createClassificationRepository(database.client);
const subjectRepository = createSubjectMaterializationRepository(
  database.client,
);
const resolutions = createHnResolutionRepository(database.client);
const hasher = {
  sha256: (value: string): string =>
    createHash("sha256").update(value).digest("hex"),
};
const reviewService = createReviewService(
  createReviewRepository(database.client),
  hasher,
);
const materialize = createMaterializeClassification(
  classifications,
  subjectRepository,
  hasher,
);
const materializeWithReviews = createMaterializeClassification(
  classifications,
  subjectRepository,
  hasher,
  reviewService,
);
const now = new Date("2026-08-25T14:00:00.000Z");

const clean = async (): Promise<void> => {
  await database.client.$executeRawUnsafe(
    'TRUNCATE TABLE "expert_note_evidence_spans", "expert_note_subjects", "expert_notes", "discovery_source_evidence_spans", "discovery_sources", "discoveries", "subject_mention_evidence_spans", "subject_mentions", "subject_aliases", "subjects", "manual_override_events", "review_tasks", "evidence_spans", "content_decisions", "classification_runs", "resolution_paths", "url_candidates", "selected_comments", "hn_items" CASCADE',
  );
};

beforeEach(clean);
afterEach(clean);
afterAll(async () => database.close());

interface PreparedComment {
  readonly commentId: HnItemId;
  readonly rootId: HnItemId;
  readonly canonicalHtml: string;
  readonly canonicalText: string;
  readonly urlCandidates: ReturnType<
    typeof normalizeHnCommentHtml
  >["urlCandidates"];
}

const prepareRoot = async (
  rootId: HnItemId,
  title: string,
  textHtml: string,
  url: string | null = null,
): Promise<void> => {
  const normalized = normalizeHnCommentHtml(
    textHtml,
    `hn:item:${rootId}`,
    hasher,
  );
  await database.client.hnItem.create({
    data: {
      id: BigInt(rootId),
      type: "story",
      parentId: null,
      author: "fixture",
      time: now,
      title,
      textHtml: normalized.canonicalHtml,
      textPlain: normalized.canonicalText,
      url,
      availability: "AVAILABLE",
      fetchedAt: now,
      responseHash: hasher.sha256(`root:${rootId}`),
    },
  });
};

const prepareComment = async (
  commentId: HnItemId,
  rootId: HnItemId,
  html: string,
): Promise<PreparedComment> => {
  const normalized = normalizeHnCommentHtml(
    html,
    `hn:item:${commentId}`,
    hasher,
  );
  await database.client.hnItem.create({
    data: {
      id: BigInt(commentId),
      type: "comment",
      parentId: BigInt(rootId),
      author: "fixture",
      time: now,
      title: null,
      textHtml: normalized.canonicalHtml,
      textPlain: normalized.canonicalText,
      url: null,
      availability: "AVAILABLE",
      fetchedAt: now,
      responseHash: hasher.sha256(`comment:${commentId}`),
      urlCandidates: {
        create: normalized.urlCandidates.map((candidate, sourceOrdinal) => ({
          rawUrl: candidate.rawUrl,
          canonicalUrl: candidate.canonicalUrl,
          sourceDocument: candidate.sourceDocument,
          originField: candidate.originField,
          scheme: candidate.scheme,
          host: candidate.host,
          validationState: candidate.validationState,
          contentHash: candidate.contentHash,
          sourceOrdinal,
          classifierEligible: true,
        })),
      },
      selectedComment: {
        create: {
          rootId: BigInt(rootId),
          canonicalHtml: normalized.canonicalHtml,
          canonicalText: normalized.canonicalText,
          contentHash: hasher.sha256(normalized.canonicalText),
          availability: "AVAILABLE",
          firstSeenAt: now,
          lastSeenAt: now,
          resolutionPath: {
            create: {
              ancestorIds: [BigInt(rootId)],
              displayedStoryId: BigInt(rootId),
              resolvedRootId: BigInt(rootId),
              resolverVersion: "fixture.v1",
              resolvedAt: now,
            },
          },
        },
      },
    },
  });
  return {
    commentId,
    rootId,
    canonicalHtml: normalized.canonicalHtml,
    canonicalText: normalized.canonicalText,
    urlCandidates: normalized.urlCandidates,
  };
};

const spanFor = (
  input: BoundedClassifierInput,
  origin: "COMMENT" | "ROOT_STORY",
  text: string,
) => {
  const span = input.documents
    .flatMap((document) => document.spans)
    .find(
      (value) =>
        value.origin === origin &&
        value.text.toLocaleLowerCase().includes(text.toLocaleLowerCase()),
    );
  if (span === undefined) {
    throw new Error(`Missing ${origin} fixture span for ${text}`);
  }
  return span;
};

const recordDecision = async (
  commentId: HnItemId,
  output: ClassificationV1,
): Promise<{
  readonly decision: ContentDecision;
  readonly input: BoundedClassifierInput;
}> => {
  const input = await loadClassifierInput(commentId, classifications, hasher);
  const validated = validateClassifierOutput(
    JSON.stringify(output),
    input,
    hasher,
  );
  if (!validated.ok) {
    throw new Error(`Invalid materialization fixture: ${validated.code}`);
  }
  const inputHash = hasher.sha256(JSON.stringify(input));
  const { run } = await classifications.recordRun({
    commentId,
    inputHash,
    promptVersion: "classification-prompt.materialization-fixture.v1",
    promptHash: hasher.sha256("materialization-fixture-prompt"),
    schemaVersion: "classification.v1",
    modelConfigId: `materialization-fixture-${commentId}`,
    provider: "fixture",
    modelId: "gold-replay-v1",
    outputHash: hasher.sha256(JSON.stringify(output)),
    providerOutput: output,
    latencyMs: 1,
    inputTokens: 1,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 1,
    status: "REVIEW",
    errorCode: null,
  });
  const decision = await classifications.saveDecision({
    commentId,
    classificationRunId: run.id,
    source: "MODEL",
    primaryDecision: output.primary_decision,
    decisionConfidence: output.decision_confidence,
    materiallyTechnical: output.comment_relevance.is_materially_technical,
    reviewRequired: true,
    validatedOutput: output,
    manualOverrideOfId: null,
    evidenceSpans: validated.evidenceSpans.map((span) => ({
      spanId: span.id,
      sourceDocument: span.documentId,
      origin: span.origin,
      start: span.start,
      end: span.end,
      textHash: span.textHash,
    })),
  });
  return { decision, input };
};

const discoveryOutput = (
  spanId: string,
  origin: "COMMENT" | "ROOT_STORY",
  name: string,
  urlCandidateIds: readonly string[],
): ClassificationV1 => ({
  schema_version: "classification.v1",
  primary_decision: "DISCOVERY",
  decision_confidence: 0.96,
  comment_relevance: {
    is_materially_technical: true,
    reason: "The comment contains reusable technical material.",
    evidence_span_ids: origin === "COMMENT" ? [spanId] : [],
  },
  rejection_reasons: [],
  discoveries: [
    {
      subject_type: "LIBRARY",
      name,
      aliases: [],
      description_claim: `${name} is discussed as a reusable library.`,
      evidence_origin: origin,
      evidence_span_ids: [spanId],
      url_candidate_ids: [...urlCandidateIds],
      url_grounding: urlCandidateIds.length === 0 ? "NONE" : "GROUNDED",
      root_story_only: origin === "ROOT_STORY",
      confidence: 0.95,
    },
  ],
  expert_note: null,
  review: { required: false, reasons: [] },
});

describe("classification materialization", () => {
  it("preserves repeated supplied URL occurrences in classifier order", async () => {
    const rootId = hnItemId(1_500);
    const commentId = hnItemId(1_501);
    await prepareRoot(
      rootId,
      "URL ordering root",
      '<p>Root body <a href="https://root.example/body">link</a>.</p>',
      "https://story.example/project",
    );
    const prepared = await prepareComment(
      commentId,
      rootId,
      '<p><a href="https://comment.example/repeated">one</a> and <a href="https://comment.example/repeated">two</a>.</p>',
    );

    const input = await loadClassifierInput(commentId, classifications, hasher);

    expect(
      input.urlCandidates.map(({ id, url, originField }) => ({
        id,
        url,
        originField,
      })),
    ).toEqual([
      {
        id: "url:0",
        url: "https://comment.example/repeated",
        originField: "href",
      },
      {
        id: "url:1",
        url: "https://comment.example/repeated",
        originField: "href",
      },
      {
        id: "url:2",
        url: "https://story.example/project",
        originField: "story_url",
      },
      {
        id: "url:3",
        url: "https://root.example/body",
        originField: "href",
      },
    ]);

    const updated = normalizeHnCommentHtml(
      '<p><a href="https://comment.example/replacement">replacement</a>.</p>',
      `hn:item:${commentId}`,
      hasher,
    );
    await resolutions.saveResolution(
      {
        selectedCommentId: commentId,
        ancestorIds: [rootId],
        displayedStoryId: rootId,
        resolvedRootId: rootId,
        resolverVersion: "fixture.v2",
      },
      {
        id: commentId,
        rootId,
        canonicalHtml: updated.canonicalHtml,
        canonicalText: updated.canonicalText,
        contentHash: hasher.sha256(updated.canonicalText),
        availability: "AVAILABLE",
        firstSeenAt: now,
        lastSeenAt: new Date(now.getTime() + 1_000),
      },
      updated.urlCandidates,
    );
    const refreshed = await loadClassifierInput(
      commentId,
      classifications,
      hasher,
    );
    expect(refreshed.urlCandidates.map((candidate) => candidate.url)).toEqual([
      "https://comment.example/replacement",
      "https://story.example/project",
      "https://root.example/body",
    ]);
    await expect(
      database.client.urlCandidate.count({
        where: {
          hnItemId: BigInt(commentId),
          canonicalUrl: "https://comment.example/repeated",
          classifierEligible: false,
        },
      }),
    ).resolves.toBe(2);
    expect(prepared.urlCandidates).toHaveLength(2);
  });

  it("is idempotent, evidence-linked, URL-safe, and retains referenced candidates", async () => {
    const rootId = hnItemId(12_000);
    const commentId = hnItemId(12_001);
    await prepareRoot(rootId, "Terminal interfaces", "<p>Terminal tools</p>");
    const prepared = await prepareComment(
      commentId,
      rootId,
      '<p><a href="https://GitHub.com/ratatui/ratatui?utm_source=hn#readme">Ratatui</a> is useful for terminal applications.</p>',
    );
    const input = await loadClassifierInput(commentId, classifications, hasher);
    const span = spanFor(input, "COMMENT", "Ratatui");
    const candidate = input.urlCandidates.find((value) =>
      value.url.includes("ratatui/ratatui"),
    );
    if (candidate === undefined) {
      throw new Error("Missing Ratatui URL candidate");
    }
    const { decision } = await recordDecision(
      commentId,
      discoveryOutput(span.id, "COMMENT", "Ratatui", [candidate.id]),
    );

    const [first, replay] = await Promise.all([
      materialize(decision.id),
      materialize(decision.id),
    ]);

    expect(first).toMatchObject({
      subjects: 1,
      mentions: 1,
      discoveries: 1,
      discoverySources: 1,
      expertNotes: 0,
    });
    expect(replay).toEqual(first);
    const storedSubject = await database.client.subject.findFirstOrThrow({
      include: { canonicalUrlCandidate: true },
    });
    expect(storedSubject).toMatchObject({
      name: "Ratatui",
      normalizedName: "ratatui",
      identityBasis: "ECOSYSTEM_COORDINATE",
      ecosystemCoordinate: "github:ratatui/ratatui",
      lifecycleState: "ACTIVE",
    });
    expect(storedSubject.canonicalUrlCandidate?.canonicalUrl).toBe(
      "https://github.com/ratatui/ratatui",
    );
    await expect(database.client.subjectMentionEvidence.count()).resolves.toBe(
      1,
    );
    await expect(database.client.discoverySourceEvidence.count()).resolves.toBe(
      1,
    );
    const candidateCount = await database.client.urlCandidate.count();

    await resolutions.saveResolution(
      {
        selectedCommentId: commentId,
        ancestorIds: [rootId],
        displayedStoryId: rootId,
        resolvedRootId: rootId,
        resolverVersion: "fixture.v2",
      },
      {
        id: commentId,
        rootId,
        canonicalHtml: prepared.canonicalHtml,
        canonicalText: prepared.canonicalText,
        contentHash: hasher.sha256(prepared.canonicalText),
        availability: "AVAILABLE",
        firstSeenAt: now,
        lastSeenAt: new Date(now.getTime() + 1_000),
      },
      prepared.urlCandidates,
    );
    await expect(database.client.urlCandidate.count()).resolves.toBe(
      candidateCount,
    );
    await expect(materialize(decision.id)).resolves.toEqual(first);
    await expect(database.client.subject.count()).resolves.toBe(1);
  });

  it("collapses root-only repeats while retaining both decision sources", async () => {
    const rootId = hnItemId(12_100);
    const firstCommentId = hnItemId(12_101);
    const secondCommentId = hnItemId(12_102);
    await prepareRoot(
      rootId,
      "Ratatui release",
      "<p>Ratatui is a terminal interface library.</p>",
    );
    await prepareComment(
      firstCommentId,
      rootId,
      "<p>The first comment adds context.</p>",
    );
    await prepareComment(
      secondCommentId,
      rootId,
      "<p>The second comment adds context.</p>",
    );
    const firstInput = await loadClassifierInput(
      firstCommentId,
      classifications,
      hasher,
    );
    const secondInput = await loadClassifierInput(
      secondCommentId,
      classifications,
      hasher,
    );
    const firstSpan = spanFor(firstInput, "ROOT_STORY", "Ratatui");
    const secondSpan = spanFor(secondInput, "ROOT_STORY", "Ratatui");
    const first = await recordDecision(
      firstCommentId,
      discoveryOutput(firstSpan.id, "ROOT_STORY", "Ratatui", []),
    );
    const second = await recordDecision(
      secondCommentId,
      discoveryOutput(secondSpan.id, "ROOT_STORY", "Ratatui", []),
    );

    await materialize(first.decision.id);
    await materialize(second.decision.id);

    await expect(database.client.subject.count()).resolves.toBe(1);
    await expect(database.client.subjectMention.count()).resolves.toBe(2);
    await expect(database.client.discovery.count()).resolves.toBe(1);
    await expect(database.client.discoverySource.count()).resolves.toBe(2);
    const discovery = await database.client.discovery.findFirstOrThrow();
    expect(discovery).toMatchObject({
      resolvedRootId: BigInt(rootId),
      rootStoryOnly: true,
      status: "REVIEW_PENDING",
    });

    const thirdCommentId = hnItemId(12_103);
    const fourthCommentId = hnItemId(12_104);
    await prepareComment(
      thirdCommentId,
      rootId,
      "<p>Ratatui supports terminal applications.</p>",
    );
    await prepareComment(
      fourthCommentId,
      rootId,
      "<p>Ratatui has a flexible widget model.</p>",
    );
    for (const commentId of [thirdCommentId, fourthCommentId]) {
      const commentInput = await loadClassifierInput(
        commentId,
        classifications,
        hasher,
      );
      const commentSpan = spanFor(commentInput, "COMMENT", "Ratatui");
      const recorded = await recordDecision(
        commentId,
        discoveryOutput(commentSpan.id, "COMMENT", "Ratatui", []),
      );
      await materialize(recorded.decision.id);
    }
    await expect(database.client.subject.count()).resolves.toBe(1);
    await expect(database.client.discovery.count()).resolves.toBe(3);
    await expect(database.client.discoverySource.count()).resolves.toBe(4);
  });

  it("links an expert note to multiple subjects without mutating canonical fields", async () => {
    const rootId = hnItemId(12_200);
    const commentId = hnItemId(12_201);
    await prepareRoot(rootId, "Terminal stack", "<p>Terminal libraries</p>");
    await prepareComment(
      commentId,
      rootId,
      '<p><a href="https://github.com/ratatui/ratatui">Ratatui</a> and <a href="https://github.com/crossterm-rs/crossterm">Crossterm</a> work well together.</p>',
    );
    const input = await loadClassifierInput(commentId, classifications, hasher);
    const span = spanFor(input, "COMMENT", "Ratatui");
    const ratatuiUrl = input.urlCandidates.find((value) =>
      value.url.includes("ratatui/ratatui"),
    );
    const crosstermUrl = input.urlCandidates.find((value) =>
      value.url.includes("crossterm-rs/crossterm"),
    );
    if (ratatuiUrl === undefined || crosstermUrl === undefined) {
      throw new Error("Missing expert-note subject URLs");
    }
    const output: ClassificationV1 = {
      schema_version: "classification.v1",
      primary_decision: "REVIEW",
      decision_confidence: 0.9,
      comment_relevance: {
        is_materially_technical: true,
        reason: "The comment compares two reusable terminal libraries.",
        evidence_span_ids: [span.id],
      },
      rejection_reasons: [],
      discoveries: [
        {
          subject_type: "LIBRARY",
          name: "Ratatui",
          aliases: [],
          description_claim: "Ratatui participates in the terminal stack.",
          evidence_origin: "COMMENT",
          evidence_span_ids: [span.id],
          url_candidate_ids: [ratatuiUrl.id],
          url_grounding: "GROUNDED",
          root_story_only: false,
          confidence: 0.95,
        },
        {
          subject_type: "LIBRARY",
          name: "Crossterm",
          aliases: [],
          description_claim: "Crossterm participates in the terminal stack.",
          evidence_origin: "COMMENT",
          evidence_span_ids: [span.id],
          url_candidate_ids: [crosstermUrl.id],
          url_grounding: "GROUNDED",
          root_story_only: false,
          confidence: 0.94,
        },
      ],
      expert_note: {
        note_type: "COMPARISON",
        title: "A compatible terminal stack",
        summary: "The two libraries are reported to work well together.",
        evidence_origin: "COMMENT",
        evidence_span_ids: [span.id],
        related_subject_names: ["Ratatui", "Crossterm"],
        qualifiers: ["experience report"],
        confidence: 0.9,
      },
      review: { required: true, reasons: ["AMBIGUOUS_CLASSIFICATION"] },
    };
    const { decision } = await recordDecision(commentId, output);

    const result = await materialize(decision.id);
    await expect(materialize(decision.id)).resolves.toEqual(result);

    expect(result).toMatchObject({
      subjects: 2,
      mentions: 2,
      discoveries: 2,
      expertNotes: 1,
      unresolvedRelatedSubjectNames: [],
    });
    const note = await database.client.expertNote.findFirstOrThrow({
      include: { subjects: true, evidenceSpans: true },
    });
    expect(note.subjects).toHaveLength(2);
    expect(note.evidenceSpans).toHaveLength(1);
    expect(note.status).toBe("REVIEW_PENDING");
    const storedSubjects = await database.client.subject.findMany({
      orderBy: { name: "asc" },
      select: { name: true, normalizedName: true, lifecycleState: true },
    });
    expect(storedSubjects).toEqual([
      {
        name: "Crossterm",
        normalizedName: "crossterm",
        lifecycleState: "ACTIVE",
      },
      {
        name: "Ratatui",
        normalizedName: "ratatui",
        lifecycleState: "ACTIVE",
      },
    ]);
  });

  it("rolls back the transaction when evidence does not belong to the decision", async () => {
    const rootId = hnItemId(12_300);
    const commentId = hnItemId(12_301);
    await prepareRoot(rootId, "Terminal library", "<p>Terminal context</p>");
    await prepareComment(
      commentId,
      rootId,
      "<p>Ratatui supports terminal applications.</p>",
    );
    const input = await loadClassifierInput(commentId, classifications, hasher);
    const span = spanFor(input, "COMMENT", "Ratatui");
    const { decision } = await recordDecision(
      commentId,
      discoveryOutput(span.id, "COMMENT", "Ratatui", []),
    );
    const identity = createSubjectIdentity(
      {
        name: "Ratatui",
        aliases: [],
        subjectType: "LIBRARY",
        canonicalUrl: null,
        verifiedOfficialDomain: null,
        disambiguatingRootId: rootId,
        provenanceKey: `decision:${decision.id}:invalid-evidence`,
      },
      hasher,
    );

    await expect(
      subjectRepository.materialize({
        decisionId: decision.id,
        commentId,
        resolvedRootId: rootId,
        extractionVersion: "subject-materialization.v1",
        urlCandidates: [],
        subjects: [
          {
            localKey: "subject:0",
            identity,
            name: "Ratatui",
            aliases: [],
            canonicalUrlCandidate: null,
          },
        ],
        mentions: [
          {
            subjectLocalKey: "subject:0",
            existingSubjectId: null,
            sourceKind: "DISCOVERY",
            sourceOrdinal: 0,
            evidenceOrigin: "COMMENT",
            confidence: 0.95,
            evidenceSpanIds: ["span:999"],
          },
        ],
        discoveries: [],
        expertNote: null,
      }),
    ).rejects.toThrow(/Evidence span does not belong/u);
    await expect(database.client.subject.count()).resolves.toBe(0);
    await expect(database.client.subjectMention.count()).resolves.toBe(0);
  });

  it("merges a reviewed name-only subject without deleting provenance", async () => {
    const firstRootId = hnItemId(12_400);
    const firstCommentId = hnItemId(12_401);
    const secondRootId = hnItemId(12_410);
    const secondCommentId = hnItemId(12_411);
    await prepareRoot(firstRootId, "First terminal story", "<p>Context</p>");
    await prepareRoot(secondRootId, "Second terminal story", "<p>Context</p>");
    await prepareComment(
      firstCommentId,
      firstRootId,
      "<p>Ratatui supports terminal applications.</p>",
    );
    await prepareComment(
      secondCommentId,
      secondRootId,
      "<p>Ratatui provides terminal widgets.</p>",
    );
    const firstInput = await loadClassifierInput(
      firstCommentId,
      classifications,
      hasher,
    );
    const secondInput = await loadClassifierInput(
      secondCommentId,
      classifications,
      hasher,
    );
    const firstRecorded = await recordDecision(
      firstCommentId,
      discoveryOutput(
        spanFor(firstInput, "COMMENT", "Ratatui").id,
        "COMMENT",
        "Ratatui",
        [],
      ),
    );
    const secondRecorded = await recordDecision(
      secondCommentId,
      discoveryOutput(
        spanFor(secondInput, "COMMENT", "Ratatui").id,
        "COMMENT",
        "Ratatui",
        [],
      ),
    );
    await materialize(firstRecorded.decision.id);
    await materializeWithReviews(secondRecorded.decision.id);
    const target = await database.client.subject.findFirstOrThrow({
      where: { createdFromDecisionId: firstRecorded.decision.id },
    });
    const source = await database.client.subject.findFirstOrThrow({
      where: { createdFromDecisionId: secondRecorded.decision.id },
    });
    const storedTask = await database.client.reviewTask.findFirstOrThrow({
      where: {
        contentDecisionId: secondRecorded.decision.id,
        kind: "SUBJECT_MERGE",
      },
    });
    const opened = await reviewService.getTask(reviewTaskId(storedTask.id));
    if (opened === null) {
      throw new Error("Expected automatic name-only merge review task");
    }
    expect(opened.reasonCodes).toEqual(["NAME_ONLY_MERGE_SUGGESTION"]);
    const command = {
      taskId: opened.id,
      expectedVersion: 1,
      sourceSubjectId: subjectId(source.id),
      targetSubjectId: subjectId(target.id),
      actorId: "owner",
      commandKey: "merge-ratatui-subjects",
      reason: "The name-only suggestion was manually confirmed",
    };

    await expect(
      reviewService.mergeSubjects({
        ...command,
        targetSubjectId: subjectId(source.id),
        commandKey: "reject-self-merge-ratatui",
      }),
    ).rejects.toMatchObject({ code: "REVIEW_POLICY_INVALID" });
    await expect(
      database.client.reviewTask.findUniqueOrThrow({
        where: { id: opened.id },
      }),
    ).resolves.toMatchObject({ state: "OPEN", version: 1 });

    const mergedTask = await reviewService.mergeSubjects(command);
    await expect(reviewService.mergeSubjects(command)).resolves.toEqual(
      mergedTask,
    );

    expect(mergedTask).toMatchObject({
      kind: "SUBJECT_MERGE",
      state: "APPROVED",
      version: 2,
    });
    await expect(
      database.client.subject.findUniqueOrThrow({ where: { id: source.id } }),
    ).resolves.toMatchObject({
      lifecycleState: "MERGED",
      mergedIntoSubjectId: target.id,
    });
    await expect(
      database.client.subjectMention.count({ where: { subjectId: source.id } }),
    ).resolves.toBe(1);
    await expect(database.client.subject.count()).resolves.toBe(2);
    await expect(
      database.client.manualOverrideEvent.findUniqueOrThrow({
        where: { commandKey: command.commandKey },
      }),
    ).resolves.toMatchObject({
      affectedSubjectId: source.id,
      relatedSubjectId: target.id,
      previousUrlCandidateId: null,
      newUrlCandidateId: null,
    });
  });

  it("resolves a canonical URL only from the reviewed HN context", async () => {
    const rootId = hnItemId(12_500);
    const commentId = hnItemId(12_501);
    await prepareRoot(
      rootId,
      "Rust parsing",
      "<p>Rust libraries</p>",
      "https://crates.io/crates/serde",
    );
    await prepareComment(
      commentId,
      rootId,
      '<p><a href="https://crates.io/crates/serde">Serde</a> supports structured data.</p>',
    );
    const input = await loadClassifierInput(commentId, classifications, hasher);
    const span = spanFor(input, "COMMENT", "Serde");
    const recorded = await recordDecision(
      commentId,
      discoveryOutput(span.id, "COMMENT", "Serde", []),
    );
    await materializeWithReviews(recorded.decision.id);
    const subject = await database.client.subject.findFirstOrThrow({
      where: { createdFromDecisionId: recorded.decision.id },
    });
    const candidate = await database.client.urlCandidate.findFirstOrThrow({
      where: {
        hnItemId: BigInt(rootId),
        canonicalUrl: "https://crates.io/crates/serde",
        sourceDocument: `hn:item:${rootId}`,
        originField: "story_url",
      },
    });
    const storedTask = await database.client.reviewTask.findFirstOrThrow({
      where: {
        contentDecisionId: recorded.decision.id,
        kind: "URL_RESOLUTION",
      },
    });
    const opened = await reviewService.getTask(reviewTaskId(storedTask.id));
    if (opened === null) {
      throw new Error("Expected automatic URL resolution review task");
    }
    expect(opened.reasonCodes).toEqual(["MISSING_CANONICAL_URL"]);
    const command = {
      taskId: opened.id,
      expectedVersion: 1,
      subjectId: subjectId(subject.id),
      urlCandidateId: urlCandidateId(candidate.id),
      actorId: "owner",
      commandKey: "resolve-serde-url",
      reason: "The supplied crate URL is canonical",
    };

    const resolvedTask = await reviewService.resolveSubjectUrl(command);
    await expect(reviewService.resolveSubjectUrl(command)).resolves.toEqual(
      resolvedTask,
    );

    expect(resolvedTask).toMatchObject({
      kind: "URL_RESOLUTION",
      state: "APPROVED",
      version: 2,
    });
    await expect(
      database.client.subject.findUniqueOrThrow({ where: { id: subject.id } }),
    ).resolves.toMatchObject({
      identityBasis: "ECOSYSTEM_COORDINATE",
      ecosystemCoordinate: "crates:serde",
      canonicalUrlCandidateId: candidate.id,
    });
    await expect(
      database.client.manualOverrideEvent.findUniqueOrThrow({
        where: { commandKey: command.commandKey },
      }),
    ).resolves.toMatchObject({
      affectedSubjectId: subject.id,
      relatedSubjectId: null,
      previousUrlCandidateId: null,
      newUrlCandidateId: candidate.id,
    });

    const unrelatedItemId = hnItemId(12_599);
    await database.client.hnItem.create({
      data: {
        id: BigInt(unrelatedItemId),
        type: "story",
        parentId: null,
        author: "fixture",
        time: now,
        title: "Unrelated",
        textHtml: null,
        textPlain: null,
        url: "https://example.com/serde",
        availability: "AVAILABLE",
        fetchedAt: now,
        responseHash: hasher.sha256("unrelated"),
        urlCandidates: {
          create: {
            rawUrl: "https://example.com/serde",
            canonicalUrl: "https://example.com/serde",
            sourceDocument: `hn:item:${unrelatedItemId}`,
            originField: "story_url",
            scheme: "https",
            host: "example.com",
            validationState: "VALID",
            contentHash: hasher.sha256("unrelated-url"),
          },
        },
      },
    });
    const unrelated = await database.client.urlCandidate.findFirstOrThrow({
      where: { hnItemId: BigInt(unrelatedItemId) },
    });
    const reopened = await reviewService.reopen({
      taskId: resolvedTask.id,
      expectedVersion: 2,
      actorId: "owner",
      commandKey: "reopen-serde-url",
      reason: "Verify candidate membership enforcement",
    });
    await expect(
      reviewService.resolveSubjectUrl({
        taskId: reopened.id,
        expectedVersion: 1,
        subjectId: subjectId(subject.id),
        urlCandidateId: urlCandidateId(unrelated.id),
        actorId: "owner",
        commandKey: "reject-unrelated-serde-url",
        reason: "This URL is not from the reviewed HN context",
      }),
    ).rejects.toMatchObject({ code: "REVIEW_POLICY_INVALID" });
    await expect(
      database.client.reviewTask.findUniqueOrThrow({
        where: { id: reopened.id },
      }),
    ).resolves.toMatchObject({ state: "OPEN", version: 1 });
  });
});
