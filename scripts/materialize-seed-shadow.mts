import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { FixtureClassifier } from "../packages/adapters/src/index.ts";
import {
  createClassifyComment,
  createMaterializeClassification,
  createReviewService,
  loadClassifierInput,
} from "../packages/application/src/index.ts";
import {
  createClassificationRepository,
  createDatabase,
  createReviewRepository,
  createSubjectMaterializationRepository,
} from "../packages/db/src/index.ts";
import { hnItemId } from "../packages/domain/src/index.ts";
import type { BoundedClassifierInput } from "../packages/ports/src/index.ts";

interface GoldSpan {
  readonly id: string;
  readonly origin: "COMMENT" | "ROOT_STORY";
  readonly start: number;
  readonly end: number;
}

interface GoldRow {
  readonly commentId: number;
  readonly primaryClass: "DISCOVERY" | "EXPERT_NOTE" | "REJECTED";
  readonly evidenceSpans: readonly GoldSpan[];
  readonly discoveries: readonly {
    readonly subjectType: string;
    readonly name: string;
    readonly aliases: readonly string[];
    readonly description: string;
    readonly evidenceOrigin: "COMMENT" | "ROOT_STORY" | "BOTH";
    readonly evidenceSpanIds: readonly string[];
    readonly urlCandidateIds: readonly string[];
    readonly rootOnly: boolean;
  }[];
  readonly expertNote: null | {
    readonly noteType: string;
    readonly title: string;
    readonly summary: string;
    readonly evidenceOrigin: "COMMENT" | "ROOT_STORY" | "BOTH";
    readonly evidenceSpanIds: readonly string[];
    readonly relatedSubjectNames: readonly string[];
    readonly qualifiers: readonly string[];
  };
  readonly reviewFlags: readonly string[];
  readonly rejectionReason: string | null;
}

interface EvaluationDocument {
  readonly commentId: number;
  readonly rootId: number;
  readonly comment: { readonly plainText: string };
  readonly root: {
    readonly title: string;
    readonly bodyPlainText: string;
  };
  readonly urlCandidates: readonly { readonly url: string }[];
}

interface EvaluationSource {
  readonly documents: readonly EvaluationDocument[];
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const hasher = { sha256 };

const mappedSpanIds = (
  goldSpan: GoldSpan,
  document: EvaluationDocument,
  input: BoundedClassifierInput,
): readonly string[] => {
  const ranges: {
    readonly documentId: string;
    readonly start: number;
    readonly end: number;
  }[] = [];
  if (goldSpan.origin === "COMMENT") {
    ranges.push({
      documentId: `comment:${document.commentId}`,
      start: goldSpan.start,
      end: goldSpan.end,
    });
  } else {
    const separatorLength =
      document.root.title.length > 0 && document.root.bodyPlainText.length > 0
        ? 2
        : 0;
    const bodyStart = document.root.title.length + separatorLength;
    if (goldSpan.start < document.root.title.length) {
      ranges.push({
        documentId: `root-title:${document.rootId}`,
        start: goldSpan.start,
        end: Math.min(goldSpan.end, document.root.title.length),
      });
    }
    if (goldSpan.end > bodyStart) {
      ranges.push({
        documentId: `root-text:${document.rootId}`,
        start: Math.max(0, goldSpan.start - bodyStart),
        end: goldSpan.end - bodyStart,
      });
    }
  }
  const ids = ranges.flatMap((range) => {
    const inputDocument = input.documents.find(
      (candidate) => candidate.id === range.documentId,
    );
    return (
      inputDocument?.spans
        .filter(
          (span) =>
            span.sourceStart < range.end && span.sourceEnd > range.start,
        )
        .map((span) => span.id) ?? []
    );
  });
  if (ids.length === 0) {
    throw new Error(`SEED_GOLD_SPAN_TRUNCATED:${document.commentId}`);
  }
  return [...new Set(ids)];
};

const rejectionReason = (reason: string | null): string => {
  const mapped: Readonly<Record<string, string>> = {
    LOW_INFORMATION: "GENERIC_OPINION",
    NON_TECHNICAL: "POLITICS_NO_TECHNICAL_SUBJECT",
    PERSONAL_STORY: "PERSONAL_STORY_NO_USABLE_SUBJECT",
  };
  if (reason === null) {
    throw new Error("SEED_REJECTED_REASON_MISSING");
  }
  return mapped[reason] ?? reason;
};

const outputFor = (
  row: GoldRow,
  document: EvaluationDocument,
  input: BoundedClassifierInput,
) => {
  const spans = new Map(
    row.evidenceSpans.map((span) => [
      span.id,
      mappedSpanIds(span, document, input),
    ]),
  );
  const idsFor = (ids: readonly string[]): string[] => [
    ...new Set(
      ids.flatMap((id) => {
        const mapped = spans.get(id);
        if (mapped === undefined) {
          throw new Error(`SEED_GOLD_SPAN_MISSING:${row.commentId}`);
        }
        return mapped;
      }),
    ),
  ];
  return {
    schema_version: "classification.v1",
    primary_decision: row.primaryClass,
    decision_confidence: 1,
    comment_relevance: {
      is_materially_technical: row.primaryClass !== "REJECTED",
      reason:
        row.primaryClass === "REJECTED"
          ? "The comment does not contain reusable technical knowledge."
          : "The selected comment materially supports the retained classification.",
      evidence_span_ids: idsFor(row.evidenceSpans.map((span) => span.id)),
    },
    rejection_reasons:
      row.primaryClass === "REJECTED"
        ? [rejectionReason(row.rejectionReason)]
        : [],
    discoveries: row.discoveries.map((discovery) => ({
      subject_type: discovery.subjectType,
      name: discovery.name,
      aliases: discovery.aliases,
      description_claim: discovery.description,
      evidence_origin: discovery.evidenceOrigin,
      evidence_span_ids: idsFor(discovery.evidenceSpanIds),
      url_candidate_ids: discovery.urlCandidateIds,
      url_grounding: discovery.urlCandidateIds.length > 0 ? "GROUNDED" : "NONE",
      root_story_only: discovery.rootOnly,
      confidence: 1,
    })),
    expert_note:
      row.expertNote === null
        ? null
        : {
            note_type: row.expertNote.noteType,
            title: row.expertNote.title,
            summary: row.expertNote.summary,
            evidence_origin: row.expertNote.evidenceOrigin,
            evidence_span_ids: idsFor(row.expertNote.evidenceSpanIds),
            related_subject_names: row.expertNote.relatedSubjectNames,
            qualifiers: row.expertNote.qualifiers,
            confidence: 1,
          },
    review: {
      required: row.reviewFlags.length > 0,
      reasons: row.reviewFlags,
    },
  };
};

try {
  process.loadEnvFile(resolve(process.cwd(), ".env"));
} catch (error) {
  if (error === null || typeof error !== "object" || error.code !== "ENOENT") {
    throw error;
  }
}
const [goldText, sourceText] = await Promise.all([
  readFile(resolve(process.cwd(), "evaluation/gold-v1.jsonl"), "utf8"),
  readFile("/tmp/hn-evaluation-source.json", "utf8"),
]);
const gold = goldText
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as GoldRow);
const source = JSON.parse(sourceText) as EvaluationSource;
const sourceById = new Map(
  source.documents.map((document) => [document.commentId, document]),
);
if (gold.length !== 98 || source.documents.length !== 98) {
  throw new Error("SEED_SHADOW_CORPUS_SIZE_INVALID");
}

const database = createDatabase({
  connectionString:
    process.env["DATABASE_URL"] ??
    "postgresql://hn_knowledge:hn_knowledge@127.0.0.1:5432/hn_knowledge",
});
try {
  const classifications = createClassificationRepository(database.client);
  const subjectRepository = createSubjectMaterializationRepository(
    database.client,
  );
  const review = createReviewService(
    createReviewRepository(database.client),
    hasher,
  );
  const outputs = new Map<number, unknown>();
  const inputs = new Map<number, BoundedClassifierInput>();
  for (const row of gold) {
    const document = sourceById.get(row.commentId);
    if (document === undefined) {
      throw new Error(`SEED_SOURCE_MISSING:${row.commentId}`);
    }
    const input = await loadClassifierInput(
      hnItemId(row.commentId),
      classifications,
      hasher,
    );
    const expectedUrls = document.urlCandidates.map(
      (candidate) => new URL(candidate.url).href,
    );
    const actualUrls = input.urlCandidates.map((candidate) => candidate.url);
    if (JSON.stringify(expectedUrls) !== JSON.stringify(actualUrls)) {
      throw new Error(`SEED_URL_CANDIDATE_ORDER_DRIFT:${row.commentId}`);
    }
    inputs.set(row.commentId, input);
    outputs.set(row.commentId, outputFor(row, document, input));
  }
  const classifier = new FixtureClassifier({ outputs, latencyMs: 1 });
  const classify = createClassifyComment(
    classifier,
    classifications,
    hasher,
    review,
  );
  const materialize = createMaterializeClassification(
    classifications,
    subjectRepository,
    hasher,
    review,
  );
  for (const row of gold) {
    const input = inputs.get(row.commentId);
    if (input === undefined) {
      throw new Error(`SEED_INPUT_MISSING:${row.commentId}`);
    }
    const result = await classify({
      commentId: hnItemId(row.commentId),
      boundedInput: input,
    });
    if (result.kind !== "DECISION") {
      throw new Error(`SEED_FIXTURE_REQUIRES_REVIEW:${row.commentId}`);
    }
    await materialize(result.decision.id);
  }
  const counts = {
    decisions: await database.client.contentDecision.count(),
    reviewRequiredDecisions: await database.client.contentDecision.count({
      where: { reviewRequired: true },
    }),
    activatedDecisions: await database.client.selectedComment.count({
      where: { activeDecisionId: { not: null } },
    }),
    reviewTasks: await database.client.reviewTask.count(),
    openReviewTasks: await database.client.reviewTask.count({
      where: { state: "OPEN" },
    }),
    contentReviewTasks: await database.client.reviewTask.count({
      where: { kind: "CONTENT_DECISION" },
    }),
    subjects: await database.client.subject.count(),
    mentions: await database.client.subjectMention.count(),
    discoveries: await database.client.discovery.count(),
    reviewPendingDiscoveries: await database.client.discovery.count({
      where: { status: "REVIEW_PENDING" },
    }),
    discoverySources: await database.client.discoverySource.count(),
    expertNotes: await database.client.expertNote.count(),
    reviewPendingExpertNotes: await database.client.expertNote.count({
      where: { status: "REVIEW_PENDING" },
    }),
  };
  if (
    counts.decisions !== 98 ||
    counts.reviewRequiredDecisions !== counts.decisions ||
    counts.activatedDecisions !== 0 ||
    counts.contentReviewTasks !== counts.decisions ||
    counts.openReviewTasks !== counts.reviewTasks ||
    counts.reviewPendingDiscoveries !== counts.discoveries ||
    counts.reviewPendingExpertNotes !== counts.expertNotes
  ) {
    throw new Error("SEED_SHADOW_MATERIALIZATION_INCOMPLETE");
  }
  process.stdout.write(
    `${JSON.stringify({
      corpus: "seed-v1",
      mode: "mandatory-review-shadow",
      ...counts,
    })}\n`,
  );
} finally {
  await database.close();
}
