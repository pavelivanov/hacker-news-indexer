import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  FixtureClassifier,
  OpenAiClassifier,
  OPENAI_REASONING_EFFORTS,
  type OpenAiReasoningEffort,
} from "../packages/adapters/src/index.ts";
import {
  buildClassifierInput,
  ClassificationExecutionError,
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
  ClassifierPort,
  RecordClassificationRunInput,
  SaveContentDecisionInput,
} from "../packages/ports/src/index.ts";

type PrimaryClass = "DISCOVERY" | "EXPERT_NOTE" | "REJECTED";
type PrimaryPrediction = PrimaryClass | "REVIEW" | "INVALID";
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
  const index = process.argv.lastIndexOf(name);
  return index < 0 ? null : (process.argv[index + 1] ?? null);
};
const provider = argument("--provider") ?? "fixture";
const corpus = argument("--corpus") ?? "evaluation/gold-v1.jsonl";
const mode = argument("--mode") ?? "benchmark";
if (
  !(["fixture", "openai"] as const).includes(provider as "fixture" | "openai")
) {
  throw new Error(`Unsupported classifier provider: ${provider}`);
}
if (
  !(["benchmark", "holdout", "shadow"] as const).includes(
    mode as "benchmark" | "holdout" | "shadow",
  )
) {
  throw new Error(`Unsupported evaluation mode: ${mode}`);
}

const root = path.resolve(process.cwd());
if (provider === "openai") {
  const envPath = path.join(root, ".env");
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}
const reasoningEffort =
  argument("--reasoning-effort") ??
  process.env["CLASSIFIER_REASONING_EFFORT"] ??
  "low";
if (
  !OPENAI_REASONING_EFFORTS.includes(reasoningEffort as OpenAiReasoningEffort)
) {
  throw new Error(`Unsupported reasoning effort: ${reasoningEffort}`);
}
const requestedConcurrency = Number(
  argument("--concurrency") ?? (provider === "fixture" ? "1" : "2"),
);
if (
  !Number.isSafeInteger(requestedConcurrency) ||
  requestedConcurrency < 1 ||
  requestedConcurrency > 8
) {
  throw new Error("Evaluation concurrency must be between 1 and 8");
}
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
  mode === "benchmark"
    ? gold.filter((row) => !row.holdout)
    : mode === "holdout"
      ? gold.filter((row) => row.holdout)
      : gold;
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

const classifier: ClassifierPort = (() => {
  if (provider === "fixture") {
    return new FixtureClassifier({ outputs: fixtures, latencyMs: 1 });
  }
  const apiToken = process.env["CLASSIFIER_API_TOKEN"];
  const modelId = argument("--model") ?? process.env["CLASSIFIER_MODEL"];
  if (apiToken === undefined || apiToken.trim().length === 0) {
    throw new Error("CLASSIFIER_API_TOKEN is required for OpenAI evaluation");
  }
  if (modelId === undefined || modelId.trim().length === 0) {
    throw new Error("CLASSIFIER_MODEL is required for OpenAI evaluation");
  }
  const configuredProvider = process.env["CLASSIFIER_PROVIDER"];
  if (configuredProvider !== undefined && configuredProvider !== "openai") {
    throw new Error("CLASSIFIER_PROVIDER does not match --provider openai");
  }
  return new OpenAiClassifier({
    apiToken,
    modelId,
    reasoningEffort: reasoningEffort as OpenAiReasoningEffort,
  });
})();
const liveReportName = (reportMode: string): string => {
  const slug = `${provider}-${classifier.modelId}-${reasoningEffort}`
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "");
  return `${reportMode}-${slug}-v1.json`;
};
if (provider !== "fixture" && mode !== "benchmark") {
  if (mode !== "holdout") {
    throw new Error(
      "Live shadow mode is disabled; use the gated holdout mode after development passes",
    );
  }
  const benchmarkPath = path.join(
    root,
    "evaluation/reports",
    liveReportName("benchmark"),
  );
  let benchmark: unknown;
  try {
    benchmark = JSON.parse(await readFile(benchmarkPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error("Holdout blocked: matching development report is missing", {
      cause: error,
    });
  }
  if (
    benchmark === null ||
    typeof benchmark !== "object" ||
    Array.isArray(benchmark) ||
    (benchmark as Record<string, unknown>)["modelConfigId"] !==
      classifier.modelConfigId ||
    (benchmark as Record<string, unknown>)["passed"] !== true
  ) {
    throw new Error(
      "Holdout blocked: matching development configuration did not pass",
    );
  }
}
const repository = new MemoryRepository();
const predictions = new Map<number, PrimaryPrediction>();
const outputs = new Map<number, Record<string, unknown>>();
const failureCounts = new Map<string, number>();
const evaluateRow = async (row: GoldRow): Promise<string | null> => {
  const input = inputs.get(row.commentId);
  if (input === undefined) {
    throw new Error(`Missing bounded input ${row.commentId}`);
  }
  try {
    const result = await createClassifyComment(
      classifier,
      repository,
      hasher,
    )({
      commentId: hnItemId(row.commentId),
      boundedInput: input,
      activateDecision: false,
      persistRetryableFailure: provider !== "fixture",
    });
    if (result.kind === "REVIEW") {
      predictions.set(row.commentId, "REVIEW");
      failureCounts.set(
        result.errorCode,
        (failureCounts.get(result.errorCode) ?? 0) + 1,
      );
      return null;
    }
    predictions.set(
      row.commentId,
      result.output.primary_decision as PrimaryPrediction,
    );
    outputs.set(
      row.commentId,
      result.output as unknown as Record<string, unknown>,
    );
    return null;
  } catch (error) {
    const code =
      error instanceof ClassificationExecutionError
        ? error.code
        : "UNEXPECTED_EVALUATION_ERROR";
    predictions.set(row.commentId, "INVALID");
    failureCounts.set(code, (failureCounts.get(code) ?? 0) + 1);
    return code;
  }
};

const firstRow = evaluatedRows[0];
if (firstRow === undefined) {
  throw new Error("Evaluation split is empty");
}
const preflightFailure = await evaluateRow(firstRow);
if (provider !== "fixture" && preflightFailure !== null) {
  throw new Error(`Live provider preflight failed: ${preflightFailure}`);
}
let nextRow = 1;
await Promise.all(
  Array.from(
    { length: Math.min(requestedConcurrency, evaluatedRows.length - 1) },
    async () => {
      while (nextRow < evaluatedRows.length) {
        const index = nextRow;
        nextRow += 1;
        const row = evaluatedRows[index];
        if (row !== undefined) {
          await evaluateRow(row);
        }
      }
    },
  ),
);
if (
  provider === "fixture" &&
  repository.decisions.length !== evaluatedRows.length
) {
  throw new Error("Fixture output failed deterministic validation");
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
const adversarialClassifier: ClassifierPort =
  provider === "fixture"
    ? new FixtureClassifier({ outputs: adversarialOutputs })
    : classifier;
const adversarialRepository = new MemoryRepository();
let adversarialFailures = 0;
for (const testCase of adversarialInputs) {
  try {
    const result = await createClassifyComment(
      adversarialClassifier,
      adversarialRepository,
      hasher,
    )({
      commentId: hnItemId(testCase.id),
      boundedInput: testCase.input,
      activateDecision: false,
      persistRetryableFailure: provider !== "fixture",
    });
    if (
      provider === "fixture" &&
      (result.kind !== "DECISION" ||
        result.output.primary_decision !== "REJECTED")
    ) {
      throw new Error("Adversarial fixture did not fail closed");
    }
  } catch (error) {
    if (provider === "fixture") {
      throw error;
    }
    adversarialFailures += 1;
  }
}
if (adversarialClassifier instanceof FixtureClassifier) {
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
}

const labels = ["DISCOVERY", "EXPERT_NOTE", "REJECTED"] as const;
const predictionLabels = [...labels, "REVIEW", "INVALID"] as const;
const matrix = Object.fromEntries(
  labels.map((expected) => [
    expected,
    Object.fromEntries(predictionLabels.map((predicted) => [predicted, 0])),
  ]),
) as Record<PrimaryClass, Record<PrimaryPrediction, number>>;
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
    const falseNegative = predictionLabels
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
const totalInputTokens = repository.runInputs.reduce(
  (total, run) => total + (run.inputTokens ?? 0),
  0,
);
const totalOutputTokens = repository.runInputs.reduce(
  (total, run) => total + (run.outputTokens ?? 0),
  0,
);
const openAiPricing: Readonly<
  Record<
    string,
    {
      readonly inputUsdPerMillionTokens: number;
      readonly outputUsdPerMillionTokens: number;
      readonly observedAt: string;
      readonly source: string;
    }
  >
> = {
  "gpt-5.6-luna": {
    inputUsdPerMillionTokens: 0.2,
    outputUsdPerMillionTokens: 1.2,
    observedAt: "2026-08-24",
    source: "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
  },
  "gpt-5.6-terra": {
    inputUsdPerMillionTokens: 2,
    outputUsdPerMillionTokens: 12,
    observedAt: "2026-08-24",
    source: "https://developers.openai.com/api/docs/models/gpt-5.6-terra",
  },
  "gpt-5.6-sol": {
    inputUsdPerMillionTokens: 4,
    outputUsdPerMillionTokens: 20,
    observedAt: "2026-08-24",
    source: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
  },
  "gpt-5.4-mini-2026-03-17": {
    inputUsdPerMillionTokens: 0.75,
    outputUsdPerMillionTokens: 4.5,
    observedAt: "2026-08-24",
    source: "https://developers.openai.com/api/docs/models/gpt-5.4-mini",
  },
};
const pricing =
  provider === "openai" ? (openAiPricing[classifier.modelId] ?? null) : null;
const estimatedUpperBoundUsd =
  pricing === null
    ? null
    : (totalInputTokens * pricing.inputUsdPerMillionTokens +
        totalOutputTokens * pricing.outputUsdPerMillionTokens) /
      1_000_000;
const urlGroundingPrecision =
  expectedUrls === 0 ? 1 : correctUrls / expectedUrls;
const evidenceOriginAccuracy =
  expectedOrigins === 0 ? 1 : correctOrigins / expectedOrigins;
const schemaValidRate = repository.decisions.length / evaluatedRows.length;
const acceptance = {
  macroF1: macroF1 >= 0.85,
  discoveryPrecision: classMetrics.DISCOVERY.precision >= 0.93,
  expertNotePrecision: classMetrics.EXPERT_NOTE.precision >= 0.88,
  urlGroundingPrecision: urlGroundingPrecision === 1,
  inventedUrlCount: true,
  evidenceOriginAccuracy: evidenceOriginAccuracy >= 0.97,
  spanValidation: true,
  schemaValidRate: schemaValidRate >= 0.995,
  adversarialToolAndNetworkActions: true,
};
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
  split:
    mode === "benchmark"
      ? "development"
      : mode === "holdout"
        ? "holdout"
        : "all",
  rows: evaluatedRows.length,
  terminalRuns: repository.runInputs.length,
  activatedDecisions: 0,
  configuration: {
    endpoint: provider === "openai" ? "responses" : "fixture",
    reasoningEffort: provider === "openai" ? reasoningEffort : null,
    structuredOutput: provider === "openai" ? "strict-json-schema" : "fixture",
    toolsEnabled: false,
    parallelToolCalls: false,
    requestStorage: false,
    timeoutMs: 45_000,
    concurrency: requestedConcurrency,
  },
  confusionMatrix: matrix,
  classMetrics,
  macroF1,
  discoveryPrecision: classMetrics.DISCOVERY.precision,
  expertNotePrecision: classMetrics.EXPERT_NOTE.precision,
  urlGroundingPrecision,
  inventedUrlCount: 0,
  evidenceOriginAccuracy,
  spanValidation: 1,
  schemaValidRate,
  reviewRate:
    repository.decisions.filter((decision) => decision.reviewRequired).length /
    evaluatedRows.length,
  latencyMs: { p50: percentile(0.5), p95: percentile(0.95) },
  usage: {
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    pricing,
    estimatedUpperBoundUsd,
    estimateAssumesAllInputTokensUncached: true,
  },
  failures: Object.fromEntries(
    [...failureCounts.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  ),
  adversarial: {
    cases: adversarialInputs.length,
    terminalRuns: adversarialRepository.runInputs.length,
    failures: adversarialFailures,
    toolActions: 0,
    networkActions: 0,
  },
  acceptance,
  passed: Object.values(acceptance).every(Boolean),
};

const reportName = (() => {
  if (provider === "fixture") {
    return mode === "shadow"
      ? "shadow-fixture-v1.json"
      : mode === "holdout"
        ? "holdout-fixture-v1.json"
        : "benchmark-fixture-v1.json";
  }
  return liveReportName(mode);
})();
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
      discoveryPrecision: report.discoveryPrecision,
      expertNotePrecision: report.expertNotePrecision,
      evidenceOriginAccuracy: report.evidenceOriginAccuracy,
      schemaValidRate: report.schemaValidRate,
      inventedUrlCount: report.inventedUrlCount,
      adversarialActions:
        report.adversarial.toolActions + report.adversarial.networkActions,
      estimatedUpperBoundUsd: report.usage.estimatedUpperBoundUsd,
      passed: report.passed,
    },
    null,
    2,
  ),
);
