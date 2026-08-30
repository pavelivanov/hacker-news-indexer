import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { format } from "prettier";

import {
  FixtureClassifier,
  OpenAiClassifier,
  OPENAI_REASONING_EFFORTS,
  type OpenAiReasoningEffort,
} from "../packages/adapters/src/index.ts";
import {
  buildClassifierInput,
  calculateClassificationMetrics,
  calculateExtractionMetrics,
  assertEvaluationCycleArtifactsMatch,
  assertEvaluationDevelopmentMayRun,
  assertEvaluationHoldoutMayOpen,
  assertEvaluationHypothesisMatches,
  assertEvaluationRowsMatchCycle,
  CLASSIFICATION_EVALUATION_REPORT_VERSION,
  CLASSIFICATION_DECISION_ROUTER_VERSION,
  CLASSIFICATION_PROMPT_VERSION,
  CLASSIFICATION_SYSTEM_PROMPT,
  ClassificationExecutionError,
  claimEvaluationHoldout,
  createClassifyComment,
  EVALUATION_PREDICTIONS,
  EVALUATION_PRIMARY_CLASSES,
  matchEvaluationDiscoveries,
  parseEvaluationCycleManifest,
  parseEvaluationHypothesis,
  parseEvaluationHypothesisReference,
  recordEvaluationHoldoutResult,
  serializeEvaluationCycleManifest,
  validateEvaluationCycleSet,
  type EvaluationCycleManifest,
  type EvaluationHoldoutCandidateInput,
  type EvaluationHypothesisReference,
  type EvaluationConfusionMatrix,
  type EvaluationPrediction,
  type EvaluationPrimaryClass,
} from "../packages/application/src/index.ts";
import type { ClassificationV1 } from "../packages/contracts/src/index.ts";
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

type PrimaryClass = EvaluationPrimaryClass;
type PrimaryPrediction = EvaluationPrediction;
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
  readonly annotation: {
    readonly adjudication: {
      readonly disagreement: boolean;
      readonly rationale: string;
    };
  };
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
const corpusArgument = argument("--corpus");
const sourceArgument = argument("--source");
const cycleIdArgument = argument("--cycle");
const hypothesisArgument = argument("--hypothesis");
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
const liveProvider = provider !== "fixture";
if (liveProvider && mode === "shadow") {
  throw new Error(
    "Live shadow mode is disabled; use the gated holdout mode after development passes",
  );
}
if (liveProvider && cycleIdArgument === null) {
  throw new Error("Live evaluation blocked: --cycle is required");
}
if (!liveProvider && cycleIdArgument !== null) {
  throw new Error("Fixture evaluation does not accept --cycle");
}
if (liveProvider && (corpusArgument !== null || sourceArgument !== null)) {
  throw new Error(
    "Live evaluation derives --corpus and --source from the frozen cycle",
  );
}
if ((!liveProvider || mode !== "benchmark") && hypothesisArgument !== null) {
  throw new Error(
    "--hypothesis is accepted only for live development evaluation",
  );
}

let liveCycle: EvaluationCycleManifest | null = null;
let evaluationCycles: EvaluationCycleManifest[] = [];
const cycleManifestTexts = new Map<string, string>();
if (liveProvider) {
  const cycleDirectory = path.join(root, "evaluation/cycles");
  const cycleNames = (await readdir(cycleDirectory)).filter((name) =>
    /^v[1-9][0-9]*\.json$/u.test(name),
  );
  for (const name of cycleNames) {
    const text = await readFile(path.join(cycleDirectory, name), "utf8");
    const manifest = parseEvaluationCycleManifest(JSON.parse(text) as unknown);
    cycleManifestTexts.set(manifest.cycleId, text);
    evaluationCycles.push(manifest);
  }
  validateEvaluationCycleSet(evaluationCycles);
  liveCycle =
    evaluationCycles.find((entry) => entry.cycleId === cycleIdArgument) ?? null;
  if (liveCycle === null) {
    throw new Error(
      `Live evaluation blocked: unknown evaluation cycle ${cycleIdArgument}`,
    );
  }
  if (mode === "benchmark") {
    assertEvaluationDevelopmentMayRun(liveCycle);
    if (hypothesisArgument === null) {
      throw new Error(
        "Live development evaluation blocked: --hypothesis is required",
      );
    }
  } else if (
    liveCycle.status === "HOLDOUT_CLAIMED" ||
    liveCycle.status === "OPENED_FAILED" ||
    liveCycle.status === "OPENED_PASSED" ||
    liveCycle.holdoutOpening !== null
  ) {
    throw new Error(`${liveCycle.cycleId} holdout has already been opened`);
  } else if (
    liveCycle.status !== "CANDIDATE_SELECTED" ||
    liveCycle.candidate === null
  ) {
    throw new Error(
      `${liveCycle.cycleId} holdout has no frozen passing candidate`,
    );
  }
}

const persistLiveCycleTransition = async (
  updated: EvaluationCycleManifest,
  transition: string,
): Promise<void> => {
  if (liveCycle === null || updated.cycleId !== liveCycle.cycleId) {
    throw new Error("Live cycle transition does not match the active cycle");
  }
  const expectedText = cycleManifestTexts.get(liveCycle.cycleId);
  if (expectedText === undefined) {
    throw new Error("Live cycle transition is missing its original manifest");
  }
  const updatedCycles = evaluationCycles.map((candidate) =>
    candidate.cycleId === updated.cycleId ? updated : candidate,
  );
  validateEvaluationCycleSet(updatedCycles);
  const manifestPath = path.join(
    root,
    "evaluation/cycles",
    `${updated.cycleId}.json`,
  );
  const temporaryPath = path.join(
    root,
    "evaluation/cycles",
    `.${updated.cycleId}.json.${transition}-${process.pid}`,
  );
  let renamed = false;
  try {
    const updatedText = serializeEvaluationCycleManifest(updated);
    await writeFile(temporaryPath, updatedText, { flag: "wx" });
    if ((await readFile(manifestPath, "utf8")) !== expectedText) {
      throw new Error(
        `${updated.cycleId} manifest changed during ${transition}`,
      );
    }
    await rename(temporaryPath, manifestPath);
    renamed = true;
    cycleManifestTexts.set(updated.cycleId, updatedText);
    evaluationCycles = updatedCycles;
    liveCycle = updated;
  } finally {
    if (!renamed) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
};

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
const corpus =
  liveCycle?.annotations.gold?.path ??
  corpusArgument ??
  "evaluation/gold-v1.jsonl";
const corpusPath = path.resolve(
  root,
  corpus === "seed-v1" ? "evaluation/gold-v1.jsonl" : corpus,
);
const sourcePath =
  liveCycle === null
    ? path.resolve(sourceArgument ?? "/tmp/hn-evaluation-source.json")
    : path.resolve(root, liveCycle.source.path);
const [goldText, sourceText, adversarialText] = await Promise.all([
  readFile(corpusPath, "utf8"),
  readFile(sourcePath, "utf8"),
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
if (liveCycle !== null) {
  assertEvaluationCycleArtifactsMatch(liveCycle, {
    corpusSha256: sha256(goldText),
    sourceSha256: sha256(sourceText),
  });
  assertEvaluationRowsMatchCycle(
    liveCycle,
    mode as "benchmark" | "holdout",
    evaluatedRows.map((row) => row.commentId),
  );
}
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
const promptHash = sha256(CLASSIFICATION_SYSTEM_PROMPT);
let evaluationHypothesis: EvaluationHypothesisReference | null = null;
const loadEvaluationHypothesis = async (
  reference: EvaluationHypothesisReference,
): Promise<void> => {
  if (liveCycle === null) {
    throw new Error("Evaluation hypothesis requires a live cycle");
  }
  const hypothesisText = await readFile(
    path.resolve(root, reference.path),
    "utf8",
  );
  if (sha256(hypothesisText) !== reference.sha256) {
    throw new Error("Evaluation hypothesis digest has changed");
  }
  const hypothesis = parseEvaluationHypothesis(
    JSON.parse(hypothesisText) as unknown,
  );
  assertEvaluationHypothesisMatches(hypothesis, {
    cycleId: liveCycle.cycleId,
    mode: "benchmark",
    provider,
    modelId: classifier.modelId,
    modelConfigId: classifier.modelConfigId,
    reasoningEffort,
    promptVersion: CLASSIFICATION_PROMPT_VERSION,
    promptHash,
    decisionRouterVersion: CLASSIFICATION_DECISION_ROUTER_VERSION,
  });
};
if (liveCycle !== null && mode === "benchmark") {
  const hypothesisPath = path.resolve(root, hypothesisArgument as string);
  const hypothesisRelativePath = path
    .relative(root, hypothesisPath)
    .split(path.sep)
    .join("/");
  parseEvaluationHypothesisReference({
    path: hypothesisRelativePath,
    sha256: "0".repeat(64),
  });
  const hypothesisText = await readFile(hypothesisPath, "utf8");
  evaluationHypothesis = parseEvaluationHypothesisReference({
    path: hypothesisRelativePath,
    sha256: sha256(hypothesisText),
  });
  await loadEvaluationHypothesis(evaluationHypothesis);
}
const liveReportName = (reportMode: string): string => {
  if (liveCycle === null) {
    throw new Error("Live report requires an evaluation cycle");
  }
  const slug = `${provider}-${classifier.modelId}-${reasoningEffort}`
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "");
  return `${reportMode}-${liveCycle.cycleId}-${slug}-v${CLASSIFICATION_EVALUATION_REPORT_VERSION}.json`;
};
const liveOutputPath =
  liveCycle === null
    ? null
    : path.join(root, "evaluation/reports", liveReportName(mode));
let holdoutRuntimeInput: EvaluationHoldoutCandidateInput | null = null;
if (liveCycle !== null && mode === "holdout") {
  holdoutRuntimeInput = {
    corpusSha256: sha256(goldText),
    sourceSha256: sha256(sourceText),
    provider,
    modelId: classifier.modelId,
    modelConfigId: classifier.modelConfigId,
    promptVersion: CLASSIFICATION_PROMPT_VERSION,
    promptHash,
  };
  assertEvaluationHoldoutMayOpen(liveCycle, holdoutRuntimeInput);
  const candidate = liveCycle.candidate;
  if (candidate === null) {
    throw new Error("Holdout blocked: frozen candidate is missing");
  }
  const benchmarkPath = path.resolve(root, candidate.developmentReport.path);
  let benchmarkText: string;
  let benchmark: unknown;
  try {
    benchmarkText = await readFile(benchmarkPath, "utf8");
    benchmark = JSON.parse(benchmarkText) as unknown;
  } catch (error) {
    throw new Error("Holdout blocked: matching development report is missing", {
      cause: error,
    });
  }
  if (sha256(benchmarkText) !== candidate.developmentReport.sha256) {
    throw new Error(
      "Holdout blocked: frozen development report digest has changed",
    );
  }
  if (
    benchmark === null ||
    typeof benchmark !== "object" ||
    Array.isArray(benchmark) ||
    (benchmark as Record<string, unknown>)["reportVersion"] !==
      CLASSIFICATION_EVALUATION_REPORT_VERSION ||
    (benchmark as Record<string, unknown>)["cycleId"] !== liveCycle.cycleId ||
    (benchmark as Record<string, unknown>)["mode"] !== "benchmark" ||
    (benchmark as Record<string, unknown>)["split"] !== "development" ||
    (benchmark as Record<string, unknown>)["rows"] !==
      liveCycle.split.developmentCommentIds.length ||
    (benchmark as Record<string, unknown>)["activatedDecisions"] !== 0 ||
    (benchmark as Record<string, unknown>)["corpusSha256"] !==
      sha256(goldText) ||
    (benchmark as Record<string, unknown>)["sourceSha256"] !==
      sha256(sourceText) ||
    (benchmark as Record<string, unknown>)["provider"] !== provider ||
    (benchmark as Record<string, unknown>)["modelId"] !== classifier.modelId ||
    (benchmark as Record<string, unknown>)["modelConfigId"] !==
      classifier.modelConfigId ||
    (benchmark as Record<string, unknown>)["promptVersion"] !==
      CLASSIFICATION_PROMPT_VERSION ||
    (benchmark as Record<string, unknown>)["decisionRouterVersion"] !==
      CLASSIFICATION_DECISION_ROUTER_VERSION ||
    (benchmark as Record<string, unknown>)["promptHash"] !== promptHash ||
    (benchmark as Record<string, unknown>)["passed"] !== true
  ) {
    throw new Error(
      "Holdout blocked: matching development configuration did not pass",
    );
  }
  evaluationHypothesis = parseEvaluationHypothesisReference(
    (benchmark as Record<string, unknown>)["hypothesis"],
  );
  await loadEvaluationHypothesis(evaluationHypothesis);
}
const liveReservationPath =
  liveOutputPath === null ? null : `${liveOutputPath}.attempt`;
if (liveOutputPath !== null) {
  await mkdir(path.dirname(liveOutputPath), { recursive: true });
  if (existsSync(liveOutputPath)) {
    throw new Error(
      `Live evaluation blocked: report already exists for ${liveCycle?.cycleId}`,
    );
  }
  try {
    await writeFile(
      liveReservationPath as string,
      `${JSON.stringify(
        {
          schemaVersion: "evaluation-attempt.v1",
          cycleId: liveCycle?.cycleId,
          mode,
          report: path.relative(root, liveOutputPath),
          hypothesis: evaluationHypothesis,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  } catch (error) {
    throw new Error(
      `Live evaluation blocked: attempt already exists for ${liveCycle?.cycleId}`,
      { cause: error },
    );
  }
}
if (liveCycle !== null && mode === "holdout") {
  if (holdoutRuntimeInput === null) {
    throw new Error("Holdout runtime configuration is missing");
  }
  await persistLiveCycleTransition(
    claimEvaluationHoldout(liveCycle, holdoutRuntimeInput),
    "claim-holdout",
  );
}
const repository = new MemoryRepository();
const predictions = new Map<number, PrimaryPrediction>();
const outputs = new Map<number, ClassificationV1>();
const failureByCommentId = new Map<number, string>();
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
      null,
    )({
      commentId: hnItemId(row.commentId),
      boundedInput: input,
      persistRetryableFailure: provider !== "fixture",
    });
    if (result.kind === "REVIEW") {
      predictions.set(row.commentId, "INVALID");
      failureByCommentId.set(row.commentId, result.errorCode);
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
    outputs.set(row.commentId, result.output);
    return null;
  } catch (error) {
    const code =
      error instanceof ClassificationExecutionError
        ? error.code
        : "UNEXPECTED_EVALUATION_ERROR";
    predictions.set(row.commentId, "INVALID");
    failureByCommentId.set(row.commentId, code);
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
      null,
    )({
      commentId: hnItemId(testCase.id),
      boundedInput: testCase.input,
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

const labels = EVALUATION_PRIMARY_CLASSES;
const predictionLabels = EVALUATION_PREDICTIONS;
const CONSENSUS_RATIONALE =
  "Independent annotators agreed; evidence and class invariants were mechanically validated.";
const goldStatusFor = (
  row: GoldRow,
): "CONSENSUS" | "DISAGREEMENT_ADJUDICATED" | "CONSENSUS_OVERRIDDEN" =>
  row.annotation.adjudication.disagreement
    ? "DISAGREEMENT_ADJUDICATED"
    : row.annotation.adjudication.rationale === CONSENSUS_RATIONALE
      ? "CONSENSUS"
      : "CONSENSUS_OVERRIDDEN";
const matrixFor = (rows: readonly GoldRow[]): EvaluationConfusionMatrix => {
  const result = Object.fromEntries(
    labels.map((expected) => [
      expected,
      Object.fromEntries(predictionLabels.map((predicted) => [predicted, 0])),
    ]),
  ) as EvaluationConfusionMatrix;
  for (const row of rows) {
    const predicted = predictions.get(row.commentId);
    if (predicted === undefined) {
      throw new Error(`Missing prediction ${row.commentId}`);
    }
    result[row.primaryClass][predicted] += 1;
  }
  return result;
};
const matrix = matrixFor(evaluatedRows);
const classificationMetrics = calculateClassificationMetrics(matrix);
const classMetrics = classificationMetrics.classMetrics;
const stableGoldRows = evaluatedRows.filter(
  (row) => goldStatusFor(row) === "CONSENSUS",
);
const stableGoldMatrix = matrixFor(stableGoldRows);
const stableGoldClassificationMetrics =
  calculateClassificationMetrics(stableGoldMatrix);
const extractionRows = evaluatedRows.map((row) => {
  const output = outputs.get(row.commentId);
  return {
    row,
    extraction: {
      expectedDiscoveries: row.discoveries,
      predictedDiscoveries:
        output?.discoveries.map((discovery) => ({
          subjectType: discovery.subject_type,
          name: discovery.name,
          aliases: discovery.aliases,
          evidenceOrigin: discovery.evidence_origin,
          urlCandidateIds: discovery.url_candidate_ids,
        })) ?? [],
      expectedExpertNoteOrigin: row.expertNote?.evidenceOrigin ?? null,
      predictedExpertNoteOrigin: output?.expert_note?.evidence_origin ?? null,
    },
  };
});
const extractionByCommentId = new Map(
  extractionRows.map((entry) => [entry.row.commentId, entry.extraction]),
);
const extractionMetrics = calculateExtractionMetrics(
  extractionRows.map((entry) => entry.extraction),
);
const stableGoldExtractionMetrics = calculateExtractionMetrics(
  extractionRows
    .filter((entry) => goldStatusFor(entry.row) === "CONSENSUS")
    .map((entry) => entry.extraction),
);
const latencies = repository.runInputs
  .filter((run) => run.latencyMs !== null)
  .map((run) => run.latencyMs as number)
  .sort((left, right) => left - right);
const percentile = (fraction: number): number =>
  latencies[
    Math.min(latencies.length - 1, Math.floor(latencies.length * fraction))
  ] ?? 0;
const macroF1 = classificationMetrics.macroF1;
interface UsageTotals {
  readonly runs: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly uncachedInputTokens: number | null;
  readonly outputTokens: number;
  readonly inputTokenBreakdownComplete: boolean;
  readonly outputTokenUsageComplete: boolean;
  readonly tokenUsageComplete: boolean;
}

const aggregateUsage = (
  runs: readonly RecordClassificationRunInput[],
): UsageTotals => {
  const inputTokens = runs.reduce(
    (total, run) => total + (run.inputTokens ?? 0),
    0,
  );
  const cachedInputTokens = runs.reduce(
    (total, run) => total + (run.cachedInputTokens ?? 0),
    0,
  );
  const cacheWriteInputTokens = runs.reduce(
    (total, run) => total + (run.cacheWriteInputTokens ?? 0),
    0,
  );
  const inputTokenBreakdownComplete = runs.every(
    (run) =>
      run.inputTokens !== null &&
      run.cachedInputTokens !== null &&
      run.cacheWriteInputTokens !== null &&
      run.cachedInputTokens + run.cacheWriteInputTokens <= run.inputTokens,
  );
  const outputTokenUsageComplete = runs.every(
    (run) => run.outputTokens !== null,
  );
  const tokenUsageComplete =
    inputTokenBreakdownComplete && outputTokenUsageComplete;
  return {
    runs: runs.length,
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    uncachedInputTokens: inputTokenBreakdownComplete
      ? inputTokens - cachedInputTokens - cacheWriteInputTokens
      : null,
    outputTokens: runs.reduce(
      (total, run) => total + (run.outputTokens ?? 0),
      0,
    ),
    inputTokenBreakdownComplete,
    outputTokenUsageComplete,
    tokenUsageComplete,
  };
};

const mainUsage = aggregateUsage(repository.runInputs);
const adversarialUsage = aggregateUsage(adversarialRepository.runInputs);
const totalUsage = aggregateUsage([
  ...repository.runInputs,
  ...adversarialRepository.runInputs,
]);
const openAiPricing: Readonly<
  Record<
    string,
    {
      readonly inputUsdPerMillionTokens: number;
      readonly cachedInputUsdPerMillionTokens: number;
      readonly cacheWriteInputUsdPerMillionTokens: number;
      readonly outputUsdPerMillionTokens: number;
      readonly observedAt: string;
      readonly source: string;
    }
  >
> = {
  "gpt-5.6-luna": {
    inputUsdPerMillionTokens: 0.2,
    cachedInputUsdPerMillionTokens: 0.02,
    cacheWriteInputUsdPerMillionTokens: 0.25,
    outputUsdPerMillionTokens: 1.2,
    observedAt: "2026-08-24",
    source: "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
  },
  "gpt-5.6-terra": {
    inputUsdPerMillionTokens: 2,
    cachedInputUsdPerMillionTokens: 0.2,
    cacheWriteInputUsdPerMillionTokens: 2.5,
    outputUsdPerMillionTokens: 12,
    observedAt: "2026-08-25",
    source: "https://developers.openai.com/api/docs/models/gpt-5.6-terra",
  },
  "gpt-5.6-sol": {
    inputUsdPerMillionTokens: 4,
    cachedInputUsdPerMillionTokens: 0.4,
    cacheWriteInputUsdPerMillionTokens: 5,
    outputUsdPerMillionTokens: 20,
    observedAt: "2026-08-25",
    source: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
  },
  "gpt-5.4-mini-2026-03-17": {
    inputUsdPerMillionTokens: 0.75,
    cachedInputUsdPerMillionTokens: 0.075,
    cacheWriteInputUsdPerMillionTokens: 0.9375,
    outputUsdPerMillionTokens: 4.5,
    observedAt: "2026-08-24",
    source: "https://developers.openai.com/api/docs/models/gpt-5.4-mini",
  },
};
const pricing =
  provider === "openai" ? (openAiPricing[classifier.modelId] ?? null) : null;
const estimatedAllInputUncachedUsd =
  pricing === null || !totalUsage.tokenUsageComplete
    ? null
    : (totalUsage.inputTokens * pricing.inputUsdPerMillionTokens +
        totalUsage.outputTokens * pricing.outputUsdPerMillionTokens) /
      1_000_000;
const estimatedUpperBoundUsd =
  pricing === null || !totalUsage.tokenUsageComplete
    ? null
    : (totalUsage.inputTokens *
        Math.max(
          pricing.inputUsdPerMillionTokens,
          pricing.cachedInputUsdPerMillionTokens,
          pricing.cacheWriteInputUsdPerMillionTokens,
        ) +
        totalUsage.outputTokens * pricing.outputUsdPerMillionTokens) /
      1_000_000;
const estimatedUsd =
  pricing === null ||
  !totalUsage.tokenUsageComplete ||
  totalUsage.uncachedInputTokens === null
    ? null
    : (totalUsage.uncachedInputTokens * pricing.inputUsdPerMillionTokens +
        totalUsage.cachedInputTokens * pricing.cachedInputUsdPerMillionTokens +
        totalUsage.cacheWriteInputTokens *
          pricing.cacheWriteInputUsdPerMillionTokens +
        totalUsage.outputTokens * pricing.outputUsdPerMillionTokens) /
      1_000_000;
const failureTotal = (codes: readonly string[]): number =>
  codes.reduce((total, code) => total + (failureCounts.get(code) ?? 0), 0);
const structuredOutputFailures = failureTotal([
  "JSON_INVALID",
  "SCHEMA_INVALID",
]);
const spanValidationFailures = failureTotal([
  "EVIDENCE_SPAN_UNKNOWN",
  "EVIDENCE_ORIGIN_MISMATCH",
]);
const evidenceOriginFailures = failureTotal(["EVIDENCE_ORIGIN_MISMATCH"]);
const inventedUrlCount = failureTotal([
  "MODEL_URL_STRING",
  "URL_CANDIDATE_UNKNOWN",
]);
const schemaValidRate = 1 - structuredOutputFailures / evaluatedRows.length;
const applicationValidRate = repository.decisions.length / evaluatedRows.length;
const spanValidation = 1 - spanValidationFailures / evaluatedRows.length;
const evidenceOriginAccuracy =
  1 - evidenceOriginFailures / evaluatedRows.length;
const goldById = new Map(evaluatedRows.map((row) => [row.commentId, row]));
const automaticOutputs = [...outputs.entries()].filter(
  ([, output]) =>
    labels.includes(output.primary_decision as PrimaryClass) &&
    !output.review.required,
);
const automaticCorrect = automaticOutputs.filter(([commentId, output]) => {
  const expected = goldById.get(commentId)?.primaryClass;
  return expected !== undefined && output.primary_decision === expected;
}).length;
const automaticCoverage = automaticOutputs.length / evaluatedRows.length;
const automaticAccuracy =
  automaticOutputs.length === 0
    ? 0
    : automaticCorrect / automaticOutputs.length;
let reviewTruePositive = 0;
let reviewFalsePositive = 0;
let reviewFalseNegative = 0;
let reviewTrueNegative = 0;
for (const row of evaluatedRows) {
  const expectedReview = row.reviewFlags.length > 0;
  const output = outputs.get(row.commentId);
  const predictedReview =
    output === undefined ||
    output.primary_decision === "REVIEW" ||
    output.review.required;
  if (expectedReview && predictedReview) {
    reviewTruePositive += 1;
  } else if (!expectedReview && predictedReview) {
    reviewFalsePositive += 1;
  } else if (expectedReview) {
    reviewFalseNegative += 1;
  } else {
    reviewTrueNegative += 1;
  }
}
const reviewPrecision =
  reviewTruePositive + reviewFalsePositive === 0
    ? 0
    : reviewTruePositive / (reviewTruePositive + reviewFalsePositive);
const reviewRecall =
  reviewTruePositive + reviewFalseNegative === 0
    ? 1
    : reviewTruePositive / (reviewTruePositive + reviewFalseNegative);
const reviewRouting = {
  truePositive: reviewTruePositive,
  falsePositive: reviewFalsePositive,
  falseNegative: reviewFalseNegative,
  trueNegative: reviewTrueNegative,
  precision: reviewPrecision,
  recall: reviewRecall,
  f1:
    reviewPrecision + reviewRecall === 0
      ? 0
      : (2 * reviewPrecision * reviewRecall) / (reviewPrecision + reviewRecall),
};
const cases = evaluatedRows.map((row) => {
  const output = outputs.get(row.commentId);
  const extraction = extractionByCommentId.get(row.commentId);
  if (extraction === undefined) {
    throw new Error(`Missing extraction diagnostics for ${row.commentId}`);
  }
  const discoveryComparison = matchEvaluationDiscoveries(
    extraction.expectedDiscoveries,
    extraction.predictedDiscoveries,
  );
  return {
    commentId: row.commentId,
    expected: row.primaryClass,
    predicted: predictions.get(row.commentId),
    failureCode: failureByCommentId.get(row.commentId) ?? null,
    reviewRequired: output?.review.required ?? false,
    reviewReasons: output?.review.reasons ?? [],
    expectedReviewFlags: row.reviewFlags,
    expectedDiscoveryCount: row.discoveries.length,
    predictedDiscoveryCount: output?.discoveries.length ?? 0,
    discoveryDiagnostics: {
      matches: discoveryComparison.matches.map(({ expected, predicted }) => {
        const expectedIds = new Set(expected.urlCandidateIds);
        const predictedIds = new Set(predicted.urlCandidateIds);
        return {
          expectedName: expected.name,
          predictedName: predicted.name,
          expectedSubjectType: expected.subjectType,
          predictedSubjectType: predicted.subjectType,
          expectedUrlCandidateIds: expected.urlCandidateIds,
          predictedUrlCandidateIds: predicted.urlCandidateIds,
          correctUrlCandidateIds: predicted.urlCandidateIds.filter((id) =>
            expectedIds.has(id),
          ),
          missingUrlCandidateIds: expected.urlCandidateIds.filter(
            (id) => !predictedIds.has(id),
          ),
          unexpectedUrlCandidateIds: predicted.urlCandidateIds.filter(
            (id) => !expectedIds.has(id),
          ),
        };
      }),
      unmatchedExpected: discoveryComparison.unmatchedExpected.map(
        (discovery) => ({
          name: discovery.name,
          subjectType: discovery.subjectType,
          urlCandidateIds: discovery.urlCandidateIds,
        }),
      ),
      unmatchedPredicted: discoveryComparison.unmatchedPredicted.map(
        (discovery) => ({
          name: discovery.name,
          subjectType: discovery.subjectType,
          urlCandidateIds: discovery.urlCandidateIds,
        }),
      ),
    },
    expectedExpertNote: row.expertNote !== null,
    predictedExpertNote: output?.expert_note !== null && output !== undefined,
    goldStatus: goldStatusFor(row),
  };
});
const latencyP95 = percentile(0.95);
const stableGoldClassMetrics = stableGoldClassificationMetrics.classMetrics;
const acceptance = {
  stableGoldMacroF1: stableGoldClassificationMetrics.macroF1 >= 0.85,
  classificationCoverage: classificationMetrics.classificationCoverage >= 0.8,
  stableGoldDiscoveryPrecision:
    stableGoldClassMetrics.DISCOVERY.precision >= 0.93,
  stableGoldExpertNotePrecision:
    stableGoldClassMetrics.EXPERT_NOTE.precision >= 0.88,
  stableGoldUrlGroundingPrecision:
    stableGoldExtractionMetrics.urlGroundingPrecision === 1,
  inventedUrlCount: inventedUrlCount === 0,
  evidenceOriginAccuracy: evidenceOriginAccuracy >= 0.97,
  spanValidation: spanValidation === 1,
  schemaValidRate: schemaValidRate >= 0.995,
  applicationValidRate: applicationValidRate >= 0.95,
  adversarialToolAndNetworkActions: true,
  latencyP95: latencyP95 < 60_000,
};
const report = {
  reportVersion: CLASSIFICATION_EVALUATION_REPORT_VERSION,
  ...(liveCycle === null
    ? {}
    : {
        cycleId: liveCycle.cycleId,
        source: path.relative(root, sourcePath),
        sourceSha256: sha256(sourceText),
      }),
  mode,
  corpus: path.relative(root, corpusPath),
  corpusSha256: sha256(goldText),
  provider,
  modelId: classifier.modelId,
  modelConfigId: classifier.modelConfigId,
  promptVersion: repository.runInputs[0]?.promptVersion,
  promptHash: repository.runInputs[0]?.promptHash,
  schemaVersion: repository.runInputs[0]?.schemaVersion,
  decisionRouterVersion: CLASSIFICATION_DECISION_ROUTER_VERSION,
  hypothesis: evaluationHypothesis,
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
  overallClassMetrics: classificationMetrics.overallClassMetrics,
  overallMacroF1: classificationMetrics.overallMacroF1,
  classifiedRows: classificationMetrics.classifiedRows,
  abstainedRows: classificationMetrics.abstainedRows,
  classificationCoverage: classificationMetrics.classificationCoverage,
  classifiedAccuracy: classificationMetrics.classifiedAccuracy,
  automaticRows: automaticOutputs.length,
  automaticCoverage,
  automaticAccuracy,
  stableGold: {
    rows: stableGoldRows.length,
    confusionMatrix: stableGoldMatrix,
    ...stableGoldClassificationMetrics,
    extraction: stableGoldExtractionMetrics,
  },
  discoveryPrecision: classMetrics.DISCOVERY.precision,
  expertNotePrecision: classMetrics.EXPERT_NOTE.precision,
  extraction: extractionMetrics,
  urlGroundingPrecision: extractionMetrics.urlGroundingPrecision,
  urlGroundingRecall: extractionMetrics.urlGroundingRecall,
  inventedUrlCount,
  evidenceOriginAccuracy,
  goldEvidenceOriginAgreement: extractionMetrics.goldEvidenceOriginAgreement,
  goldEvidenceOriginCoverage: extractionMetrics.goldEvidenceOriginCoverage,
  spanValidation,
  schemaValidRate,
  applicationValidRate,
  reviewRate: 1 - automaticCoverage,
  reviewRouting,
  latencyMs: { p50: percentile(0.5), p95: latencyP95 },
  latencySampleCount: latencies.length,
  usage: {
    accountingVersion: 2,
    ...totalUsage,
    main: mainUsage,
    adversarial: adversarialUsage,
    pricing,
    estimatedUsd,
    estimatedAllInputUncachedUsd,
    estimatedUpperBoundUsd,
    estimatedUpperBoundAssumesHighestPublishedInputRate: true,
    estimateIncludesAdversarialCalls: true,
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
  cases,
  acceptance,
  passed: Object.values(acceptance).every(Boolean),
};

const reportName = (() => {
  if (provider === "fixture") {
    return mode === "shadow"
      ? `shadow-fixture-v${CLASSIFICATION_EVALUATION_REPORT_VERSION}.json`
      : mode === "holdout"
        ? `holdout-fixture-v${CLASSIFICATION_EVALUATION_REPORT_VERSION}.json`
        : `benchmark-fixture-v${CLASSIFICATION_EVALUATION_REPORT_VERSION}.json`;
  }
  return liveReportName(mode);
})();
const reportPath = path.join(root, "evaluation/reports", reportName);
await mkdir(path.dirname(reportPath), { recursive: true });
const reportText = await format(JSON.stringify(report), { parser: "json" });
if (liveCycle === null) {
  await writeFile(reportPath, reportText, "utf8");
} else {
  if (liveReservationPath === null || reportPath !== liveOutputPath) {
    throw new Error("Live report reservation is invalid");
  }
  await writeFile(reportPath, reportText, { encoding: "utf8", flag: "wx" });
  if (mode === "holdout") {
    if (holdoutRuntimeInput === null) {
      throw new Error("Holdout runtime configuration is missing");
    }
    await persistLiveCycleTransition(
      recordEvaluationHoldoutResult(liveCycle, {
        ...holdoutRuntimeInput,
        cycleId: liveCycle.cycleId,
        mode: report.mode,
        split: report.split,
        rows: report.rows,
        terminalRuns: report.terminalRuns,
        activatedDecisions: report.activatedDecisions,
        passed: report.passed,
        report: {
          path: path.relative(root, reportPath),
          sha256: sha256(reportText),
        },
      }),
      "record-holdout",
    );
  }
  await unlink(liveReservationPath);
}
console.log(
  JSON.stringify(
    {
      reportPath: path.relative(root, reportPath),
      ...(liveCycle === null ? {} : { cycleStatus: liveCycle.status }),
      rows: report.rows,
      terminalRuns: report.terminalRuns,
      macroF1: report.macroF1,
      overallMacroF1: report.overallMacroF1,
      stableGoldMacroF1: report.stableGold.macroF1,
      classificationCoverage: report.classificationCoverage,
      automaticCoverage: report.automaticCoverage,
      discoveryPrecision: report.discoveryPrecision,
      expertNotePrecision: report.expertNotePrecision,
      stableGoldDiscoveryPrecision:
        report.stableGold.classMetrics.DISCOVERY.precision,
      stableGoldExpertNotePrecision:
        report.stableGold.classMetrics.EXPERT_NOTE.precision,
      evidenceOriginAccuracy: report.evidenceOriginAccuracy,
      goldEvidenceOriginAgreement: report.goldEvidenceOriginAgreement,
      schemaValidRate: report.schemaValidRate,
      applicationValidRate: report.applicationValidRate,
      inventedUrlCount: report.inventedUrlCount,
      adversarialActions:
        report.adversarial.toolActions + report.adversarial.networkActions,
      estimatedUsd: report.usage.estimatedUsd,
      estimatedUpperBoundUsd: report.usage.estimatedUpperBoundUsd,
      passed: report.passed,
    },
    null,
    2,
  ),
);
