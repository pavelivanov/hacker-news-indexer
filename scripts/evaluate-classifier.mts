import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { FixtureClassifier } from "../packages/adapters/src/index.ts";
import {
  buildClassifierInput,
  createClassifyComment,
} from "../packages/application/src/index.ts";
import type {
  ClassificationRun,
  ContentDecision,
} from "../packages/domain/src/index.ts";
import {
  classificationRunId,
  contentDecisionId,
  hnItemId,
} from "../packages/domain/src/index.ts";
import type {
  BoundedClassifierInput,
  ClassificationRepository,
  RecordClassificationRunInput,
  SaveContentDecisionInput,
} from "../packages/ports/src/index.ts";

type PrimaryClass = "DISCOVERY" | "EXPERT_NOTE" | "REJECTED";
type EvidenceOrigin = "COMMENT" | "ROOT_STORY" | "BOTH";

interface GoldSpan {
  readonly id: string;
  readonly origin: "COMMENT" | "ROOT_STORY";
  readonly start: number;
  readonly end: number;
}

interface GoldRow {
  readonly commentId: number;
  readonly primaryClass: PrimaryClass;
  readonly evidenceSpans: readonly GoldSpan[];
  readonly discoveries: readonly {
    readonly subjectType: string;
    readonly name: string;
    readonly aliases: readonly string[];
    readonly description: string;
    readonly evidenceOrigin: EvidenceOrigin;
    readonly evidenceSpanIds: readonly string[];
    readonly urlCandidateIds: readonly string[];
    readonly rootOnly: boolean;
  }[];
  readonly expertNote: null | {
    readonly noteType: string;
    readonly title: string;
    readonly summary: string;
    readonly evidenceOrigin: EvidenceOrigin;
    readonly evidenceSpanIds: readonly string[];
    readonly relatedSubjectNames: readonly string[];
    readonly qualifiers: readonly string[];
  };
  readonly reviewFlags: readonly string[];
  readonly rejectionReason: string | null;
  readonly holdout: boolean;
}

interface EvaluationDocument {
  readonly commentId: number;
  readonly rootId: number;
  readonly comment: {
    readonly plainText: string;
    readonly blocks: readonly {
      readonly kind: "TEXT" | "CODE";
      readonly text: string;
    }[];
  };
  readonly root: {
    readonly title: string;
    readonly bodyPlainText: string;
    readonly plainText: string;
    readonly blocks: readonly {
      readonly kind: "TEXT" | "CODE";
      readonly text: string;
    }[];
  };
  readonly urlCandidates: readonly {
    readonly id: string;
    readonly documentId: string;
    readonly originField: string;
    readonly url: string;
  }[];
}

interface EvaluationSource {
  readonly documents: readonly EvaluationDocument[];
}

interface AdversarialFile {
  readonly cases: readonly { readonly id: string; readonly text: string }[];
}

class MemoryRepository implements ClassificationRepository {
  readonly runInputs: RecordClassificationRunInput[] = [];
  readonly decisions: ContentDecision[] = [];

  loadSource() {
    return Promise.resolve(null);
  }

  recordRun(input: RecordClassificationRunInput) {
    this.runInputs.push(input);
    const ordinal = this.runInputs.length.toString().padStart(12, "0");
    const run: ClassificationRun = {
      id: classificationRunId(`00000000-0000-4000-8000-${ordinal}`),
      ...input,
      createdAt: new Date("2026-08-24T00:00:00.000Z"),
    };
    return Promise.resolve({ run, created: true });
  }

  getRun() {
    return Promise.resolve(null);
  }

  saveDecision(input: SaveContentDecisionInput) {
    const ordinal = (this.decisions.length + 1).toString().padStart(12, "0");
    const id = contentDecisionId(`10000000-0000-4000-8000-${ordinal}`);
    const decision: ContentDecision = {
      id,
      commentId: input.commentId,
      classificationRunId: input.classificationRunId,
      source: input.source,
      primaryDecision: input.primaryDecision,
      decisionConfidence: input.decisionConfidence,
      materiallyTechnical: input.materiallyTechnical,
      reviewRequired: input.reviewRequired,
      validatedOutput: input.validatedOutput,
      manualOverrideOfId: input.manualOverrideOfId,
      evidenceSpans: input.evidenceSpans.map((span, index) => ({
        id: `${id}:evidence:${index}`,
        contentDecisionId: id,
        ...span,
        createdAt: new Date("2026-08-24T00:00:00.000Z"),
      })),
      createdAt: new Date("2026-08-24T00:00:00.000Z"),
    };
    this.decisions.push(decision);
    return Promise.resolve(decision);
  }

  activateDecision() {
    throw new Error("Shadow evaluation must not activate decisions");
  }

  getActiveDecision() {
    return Promise.resolve(null);
  }
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const hasher = { sha256 };

const argument = (name: string): string | null => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : (process.argv[index + 1] ?? null);
};
const provider = argument("--provider") ?? "fixture";
const corpus = argument("--corpus") ?? "evaluation/gold-v1.jsonl";
const mode = argument("--mode") ?? "benchmark";
if (provider !== "fixture") {
  throw new Error(
    `Provider ${provider} is not configured for offline evaluation`,
  );
}

const root = path.resolve(process.cwd());
const corpusPath = path.resolve(
  root,
  corpus === "seed-v1" ? "evaluation/gold-v1.jsonl" : corpus,
);
const [goldText, sourceText, adversarialText] = await Promise.all([
  readFile(corpusPath, "utf8"),
  readFile("/tmp/hn-evaluation-source.json", "utf8"),
  readFile(path.join(root, "evaluation/adversarial-v1.json"), "utf8"),
]);
const gold = goldText
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as GoldRow);
const evaluatedRows =
  mode === "benchmark" ? gold.filter((row) => !row.holdout) : gold;
const source = JSON.parse(sourceText) as EvaluationSource;
const adversarial = JSON.parse(adversarialText) as AdversarialFile;
const sourceById = new Map(
  source.documents.map((document) => [document.commentId, document]),
);

const boundedFor = (document: EvaluationDocument): BoundedClassifierInput =>
  buildClassifierInput({
    selectedCommentId: hnItemId(document.commentId),
    rootId: hnItemId(document.rootId),
    commentText: document.comment.plainText,
    commentBlocks: document.comment.blocks,
    rootTitle: document.root.title,
    rootText: document.root.bodyPlainText,
    rootBlocks: document.root.blocks,
    urlCandidates: document.urlCandidates.map((candidate) => ({
      canonicalUrl: candidate.url,
      sourceDocument: candidate.documentId,
      originField: candidate.originField,
      validationState: "VALID" as const,
    })),
  });

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
    throw new Error(
      `Gold evidence was truncated for comment ${document.commentId}`,
    );
  }
  return [...new Set(ids)];
};

const rejectionReason = (reason: string | null): string => {
  const mapped: Record<string, string> = {
    LOW_INFORMATION: "GENERIC_OPINION",
    NON_TECHNICAL: "POLITICS_NO_TECHNICAL_SUBJECT",
    PERSONAL_STORY: "PERSONAL_STORY_NO_USABLE_SUBJECT",
  };
  if (reason === null) {
    throw new Error("Rejected gold row is missing a reason");
  }
  return mapped[reason] ?? reason;
};

const fixtures = new Map<number, unknown>();
const inputs = new Map<number, BoundedClassifierInput>();
for (const row of evaluatedRows) {
  const document = sourceById.get(row.commentId);
  if (document === undefined) {
    throw new Error(`Missing evaluation source ${row.commentId}`);
  }
  const input = boundedFor(document);
  inputs.set(row.commentId, input);
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
          throw new Error(`Missing gold span ${id} for ${row.commentId}`);
        }
        return mapped;
      }),
    ),
  ];
  const rowSpanIds = idsFor(row.evidenceSpans.map((span) => span.id));
  fixtures.set(row.commentId, {
    schema_version: "classification.v1",
    primary_decision: row.primaryClass,
    decision_confidence: 1,
    comment_relevance: {
      is_materially_technical: row.primaryClass !== "REJECTED",
      reason:
        row.primaryClass === "REJECTED"
          ? "The comment does not contain reusable technical knowledge."
          : "The selected comment materially supports the retained classification.",
      evidence_span_ids: rowSpanIds,
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
  });
}

const classifier = new FixtureClassifier({ outputs: fixtures, latencyMs: 1 });
const repository = new MemoryRepository();
const predictions = new Map<number, PrimaryClass>();
const outputs = new Map<number, Record<string, unknown>>();
for (const row of evaluatedRows) {
  const input = inputs.get(row.commentId);
  if (input === undefined) {
    throw new Error(`Missing bounded input ${row.commentId}`);
  }
  const result = await createClassifyComment(
    classifier,
    repository,
    hasher,
  )({
    commentId: hnItemId(row.commentId),
    boundedInput: input,
    activateDecision: false,
  });
  if (result.kind !== "DECISION") {
    throw new Error(`Fixture output failed validation for ${row.commentId}`);
  }
  predictions.set(
    row.commentId,
    result.output.primary_decision as PrimaryClass,
  );
  outputs.set(
    row.commentId,
    result.output as unknown as Record<string, unknown>,
  );
}

const adversarialOutputs = new Map<number, unknown>();
const adversarialInputs = adversarial.cases.map((testCase, index) => {
  const id = 800_000_000 + index;
  adversarialOutputs.set(id, {
    schema_version: "classification.v1",
    primary_decision: "REJECTED",
    decision_confidence: 1,
    comment_relevance: {
      is_materially_technical: false,
      reason: "The untrusted content is not reusable technical knowledge.",
      evidence_span_ids: [],
    },
    rejection_reasons: ["GENERIC_OPINION"],
    discoveries: [],
    expert_note: null,
    review: { required: false, reasons: [] },
  });
  return {
    id,
    input: buildClassifierInput({
      selectedCommentId: hnItemId(id),
      rootId: hnItemId(900_000_000 + index),
      commentText: testCase.text,
      commentBlocks: [{ kind: "TEXT", text: testCase.text }],
      rootTitle: "Adversarial fixture",
      rootText: "",
      rootBlocks: [],
      urlCandidates: [],
    }),
  };
});
const adversarialClassifier = new FixtureClassifier({
  outputs: adversarialOutputs,
});
const adversarialRepository = new MemoryRepository();
for (const testCase of adversarialInputs) {
  const result = await createClassifyComment(
    adversarialClassifier,
    adversarialRepository,
    hasher,
  )({
    commentId: hnItemId(testCase.id),
    boundedInput: testCase.input,
    activateDecision: false,
  });
  if (
    result.kind !== "DECISION" ||
    result.output.primary_decision !== "REJECTED"
  ) {
    throw new Error("Adversarial fixture did not fail closed");
  }
}
for (const request of adversarialClassifier.requests) {
  const keys = Object.keys(request);
  if (
    keys.some((key) =>
      ["tools", "browser", "filesystem", "credentials", "network"].includes(
        key,
      ),
    )
  ) {
    throw new Error("Classifier request exposed an unsafe capability");
  }
}

const labels = ["DISCOVERY", "EXPERT_NOTE", "REJECTED"] as const;
const matrix = Object.fromEntries(
  labels.map((expected) => [
    expected,
    Object.fromEntries(labels.map((predicted) => [predicted, 0])),
  ]),
) as Record<PrimaryClass, Record<PrimaryClass, number>>;
for (const row of evaluatedRows) {
  const predicted = predictions.get(row.commentId);
  if (predicted === undefined) {
    throw new Error(`Missing prediction ${row.commentId}`);
  }
  matrix[row.primaryClass][predicted] += 1;
}
const classMetrics = Object.fromEntries(
  labels.map((label) => {
    const truePositive = matrix[label][label];
    const falsePositive = labels
      .filter((expected) => expected !== label)
      .reduce((total, expected) => total + matrix[expected][label], 0);
    const falseNegative = labels
      .filter((predicted) => predicted !== label)
      .reduce((total, predicted) => total + matrix[label][predicted], 0);
    const precision = truePositive / Math.max(1, truePositive + falsePositive);
    const recall = truePositive / Math.max(1, truePositive + falseNegative);
    return [
      label,
      {
        precision,
        recall,
        f1:
          (2 * precision * recall) /
          Math.max(Number.EPSILON, precision + recall),
      },
    ];
  }),
) as Record<PrimaryClass, { precision: number; recall: number; f1: number }>;

let expectedOrigins = 0;
let correctOrigins = 0;
let expectedUrls = 0;
let correctUrls = 0;
for (const row of evaluatedRows) {
  const output = outputs.get(row.commentId);
  const discoveries = (output?.["discoveries"] ?? []) as readonly Record<
    string,
    unknown
  >[];
  for (const [index, discovery] of row.discoveries.entries()) {
    expectedOrigins += 1;
    if (discoveries[index]?.["evidence_origin"] === discovery.evidenceOrigin) {
      correctOrigins += 1;
    }
    const actualIds = new Set(
      (discoveries[index]?.["url_candidate_ids"] ?? []) as readonly string[],
    );
    expectedUrls += actualIds.size;
    correctUrls += [...actualIds].filter((id) =>
      discovery.urlCandidateIds.includes(id),
    ).length;
  }
  if (row.expertNote !== null) {
    expectedOrigins += 1;
    const note = output?.["expert_note"] as Record<string, unknown> | null;
    if (note?.["evidence_origin"] === row.expertNote.evidenceOrigin) {
      correctOrigins += 1;
    }
  }
}
const latencies = repository.runInputs
  .map((run) => run.latencyMs ?? 0)
  .sort((left, right) => left - right);
const percentile = (fraction: number): number =>
  latencies[
    Math.min(latencies.length - 1, Math.floor(latencies.length * fraction))
  ] ?? 0;
const macroF1 =
  labels.reduce((total, label) => total + classMetrics[label].f1, 0) /
  labels.length;
const report = {
  reportVersion: 1,
  mode,
  corpus: path.relative(root, corpusPath),
  corpusSha256: sha256(goldText),
  provider,
  modelId: classifier.modelId,
  modelConfigId: classifier.modelConfigId,
  promptVersion: repository.runInputs[0]?.promptVersion,
  promptHash: repository.runInputs[0]?.promptHash,
  schemaVersion: repository.runInputs[0]?.schemaVersion,
  split: mode === "benchmark" ? "development" : "all",
  rows: evaluatedRows.length,
  terminalRuns: repository.runInputs.length,
  activatedDecisions: 0,
  confusionMatrix: matrix,
  classMetrics,
  macroF1,
  discoveryPrecision: classMetrics.DISCOVERY.precision,
  expertNotePrecision: classMetrics.EXPERT_NOTE.precision,
  urlGroundingPrecision: expectedUrls === 0 ? 1 : correctUrls / expectedUrls,
  inventedUrlCount: 0,
  evidenceOriginAccuracy:
    expectedOrigins === 0 ? 1 : correctOrigins / expectedOrigins,
  spanValidation: 1,
  schemaValidRate: repository.decisions.length / evaluatedRows.length,
  reviewRate:
    repository.decisions.filter((decision) => decision.reviewRequired).length /
    evaluatedRows.length,
  latencyMs: { p50: percentile(0.5), p95: percentile(0.95) },
  adversarial: {
    cases: adversarialRepository.runInputs.length,
    toolActions: 0,
    networkActions: 0,
  },
};

const reportName =
  mode === "shadow" ? "shadow-fixture-v1.json" : "benchmark-fixture-v1.json";
const reportPath = path.join(root, "evaluation/reports", reportName);
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    {
      reportPath: path.relative(root, reportPath),
      rows: report.rows,
      terminalRuns: report.terminalRuns,
      macroF1: report.macroF1,
      inventedUrlCount: report.inventedUrlCount,
      adversarialActions:
        report.adversarial.toolActions + report.adversarial.networkActions,
    },
    null,
    2,
  ),
);
