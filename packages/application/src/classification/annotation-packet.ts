import { createHash } from "node:crypto";

import type { EvaluationPrimaryClass } from "./evaluation-metrics.js";

export const EVALUATION_ANNOTATION_PACKET_SCHEMA_VERSION =
  "annotation-packet.v1";
export const EVALUATION_ANNOTATION_PASS_SCHEMA_VERSION = "annotation-pass.v2";
export const EVALUATION_ADJUDICATION_PACKET_SCHEMA_VERSION =
  "annotation-adjudication-packet.v1";
export const MINIMUM_ANNOTATION_COHENS_KAPPA = 0.75;

export type EvaluationAnnotatorId = "A" | "B";
export type EvaluationMaterialRelevance =
  "MATERIAL" | "NOT_MATERIAL" | "UNCERTAIN";
export interface EvaluationAnnotationSourceDocument {
  readonly commentId: number;
  readonly rootId: number;
  readonly comment: {
    readonly documentId: string;
    readonly plainText: string;
  };
  readonly root: {
    readonly documentId: string;
    readonly title: string;
    readonly plainText: string;
  };
  readonly urlCandidates: readonly {
    readonly id: string;
    readonly documentId: string;
    readonly originField: string;
    readonly url: string;
  }[];
}

export interface EvaluationAnnotationPacketRow {
  readonly schemaVersion: typeof EVALUATION_ANNOTATION_PACKET_SCHEMA_VERSION;
  readonly cycleId: string;
  readonly annotatorId: EvaluationAnnotatorId;
  readonly commentId: number;
  readonly comment: EvaluationAnnotationSourceDocument["comment"];
  readonly root: EvaluationAnnotationSourceDocument["root"];
  readonly urlCandidates: EvaluationAnnotationSourceDocument["urlCandidates"];
}

export interface EvaluationAnnotationPassSummary {
  readonly rows: number;
  readonly uniqueCommentIds: number;
  readonly materialRelevance: Readonly<
    Record<EvaluationMaterialRelevance, number>
  >;
  readonly primaryClass: Readonly<Record<EvaluationPrimaryClass, number>>;
  readonly reviewRows: number;
}

interface EvidenceSpan {
  readonly origin: "COMMENT" | "ROOT_STORY";
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface AnnotationDiscovery {
  readonly subjectType: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly evidenceOrigin: "COMMENT" | "ROOT_STORY" | "BOTH";
  readonly evidenceSpans: readonly EvidenceSpan[];
  readonly urlCandidateIds: readonly string[];
  readonly rootOnly: boolean;
}

interface AnnotationExpertNote {
  readonly noteType: string;
  readonly title: string;
  readonly summary: string;
  readonly evidenceOrigin: "COMMENT" | "ROOT_STORY" | "BOTH";
  readonly evidenceSpans: readonly EvidenceSpan[];
  readonly relatedSubjectNames: readonly string[];
  readonly qualifiers: readonly string[];
}

export interface EvaluationAnnotationPassRow {
  readonly schemaVersion: typeof EVALUATION_ANNOTATION_PASS_SCHEMA_VERSION;
  readonly cycleId: string;
  readonly commentId: number;
  readonly materialRelevance: EvaluationMaterialRelevance;
  readonly primaryClass: EvaluationPrimaryClass;
  readonly discoveries: readonly AnnotationDiscovery[];
  readonly expertNote: AnnotationExpertNote | null;
  readonly reviewFlags: readonly string[];
  readonly rejectionReason: string | null;
  readonly annotator: {
    readonly id: EvaluationAnnotatorId;
    readonly method: string;
  };
}

export interface EvaluationAnnotationDecisionDisagreement {
  readonly commentId: number;
  readonly materialRelevance: {
    readonly annotatorA: EvaluationMaterialRelevance;
    readonly annotatorB: EvaluationMaterialRelevance;
  };
  readonly primaryClass: {
    readonly annotatorA: EvaluationPrimaryClass;
    readonly annotatorB: EvaluationPrimaryClass;
  };
  readonly annotatorA: EvaluationAnnotationPassRow;
  readonly annotatorB: EvaluationAnnotationPassRow;
}

export interface EvaluationAnnotationComparison {
  readonly rows: number;
  readonly exactDecisionAgreementRows: number;
  readonly primaryClassKappa: number;
  readonly materialRelevanceKappa: number;
  readonly passed: boolean;
  readonly disagreements: readonly EvaluationAnnotationDecisionDisagreement[];
}

const PRIMARY_CLASSES = new Set<EvaluationPrimaryClass>([
  "DISCOVERY",
  "EXPERT_NOTE",
  "REJECTED",
]);
const MATERIAL_RELEVANCE = new Set<EvaluationMaterialRelevance>([
  "MATERIAL",
  "NOT_MATERIAL",
  "UNCERTAIN",
]);
const SUBJECT_TYPES = new Set([
  "PROJECT",
  "TOOL",
  "LIBRARY",
  "SERVICE",
  "PRODUCT",
  "FEATURE",
  "PLUGIN",
  "AGENT_SKILL",
  "GUIDE",
  "RESOURCE",
]);
const NOTE_TYPES = new Set([
  "TECHNICAL_EXPLANATION",
  "CORRECTION",
  "PRODUCT_EXPERIENCE",
  "IMPLEMENTATION_CAVEAT",
  "SECURITY",
  "OPERATIONS",
  "COMPARISON",
  "GUIDE",
]);
const REVIEW_FLAGS = new Set([
  "MISSING_CANONICAL_URL",
  "AMBIGUOUS_CANONICAL_URL",
  "ROOT_ONLY_DISCOVERY",
  "LEGAL_RECOMMENDATION",
  "MEDICAL_RECOMMENDATION",
  "SECURITY_RECOMMENDATION",
  "DESTRUCTIVE_OR_EVASION_ADVICE",
  "LOW_CONFIDENCE",
  "PROMPT_INJECTION",
  "UNAVAILABLE_CONTENT",
  "TELEGRAM_HN_DIVERGENCE",
  "CONFLICTING_EVIDENCE_ORIGIN",
  "INVALID_EVIDENCE_SPAN",
  "UNSUPPORTED_URL",
  "AMBIGUOUS_CLASSIFICATION",
]);
const REJECTION_REASONS = new Set([
  "NON_TECHNICAL",
  "JOKE_OR_ONE_LINER",
  "GENERIC_OPINION",
  "PERSONAL_STORY",
  "INCIDENTAL_MENTION",
  "NEWS_WITHOUT_REUSABLE_DETAIL",
  "UNAVAILABLE_CONTENT",
  "LOW_INFORMATION",
]);
const RAW_URL = /https?:\/\//iu;
const CYCLE_ID = /^v[1-9][0-9]*$/u;

const fail = (message: string): never => {
  throw new TypeError(message);
};

const object = (value: unknown, location: string): Record<string, unknown> => {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return fail(`${location} must be an object`);
  }
  return value as Record<string, unknown>;
};

const exactKeys = (
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  location: string,
): void => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("\u0000") !== wanted.join("\u0000")) {
    fail(`${location} has unexpected or missing fields`);
  }
};

const integer = (value: unknown, location: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    return fail(`${location} must be a positive safe integer`);
  }
  return value as number;
};

const boundedText = (
  value: unknown,
  location: string,
  maximum: number,
  allowRawUrl = false,
): string => {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > maximum
  ) {
    return fail(`${location} must contain 1 to ${maximum} characters`);
  }
  if (!allowRawUrl && RAW_URL.test(value)) {
    fail(`${location} must use opaque URL candidate IDs, not raw URLs`);
  }
  return value;
};

const enumValue = <T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  location: string,
): T => {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    return fail(`${location} is not an allowed value`);
  }
  return value as T;
};

const array = (
  value: unknown,
  location: string,
  maximum: number,
): unknown[] => {
  if (!Array.isArray(value) || value.length > maximum) {
    return fail(`${location} must be an array with at most ${maximum} entries`);
  }
  return value;
};

const stringArray = (
  value: unknown,
  location: string,
  maximumItems: number,
  maximumLength: number,
  allowed?: ReadonlySet<string>,
  pattern?: RegExp,
): string[] => {
  const values = array(value, location, maximumItems).map((entry, index) => {
    const result = boundedText(entry, `${location}[${index}]`, maximumLength);
    if (allowed !== undefined && !allowed.has(result)) {
      fail(`${location}[${index}] is not an allowed value`);
    }
    if (pattern !== undefined && !pattern.test(result)) {
      fail(`${location}[${index}] has an invalid format`);
    }
    return result;
  });
  if (new Set(values).size !== values.length) {
    fail(`${location} must not contain duplicates`);
  }
  return values;
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const assertCycleId = (cycleId: string): void => {
  if (!CYCLE_ID.test(cycleId)) {
    fail("cycleId must match v<positive integer>");
  }
};

const assertSourceSet = (
  documents: readonly EvaluationAnnotationSourceDocument[],
  expectedCommentIds: readonly number[],
): void => {
  for (const [index, document] of documents.entries()) {
    const location = `source document ${index + 1}`;
    if (
      !Number.isSafeInteger(document.commentId) ||
      document.commentId <= 0 ||
      !Number.isSafeInteger(document.rootId) ||
      document.rootId <= 0
    ) {
      fail(`${location} must contain positive comment and root IDs`);
    }
    if (
      document.comment.documentId !== `comment:${document.commentId}` ||
      typeof document.comment.plainText !== "string" ||
      document.root.documentId !== `root:${document.rootId}` ||
      typeof document.root.title !== "string" ||
      typeof document.root.plainText !== "string" ||
      !Array.isArray(document.urlCandidates)
    ) {
      fail(`${location} has an invalid bounded source shape`);
    }
    const candidateIds = new Set<string>();
    for (const [
      candidateIndex,
      candidate,
    ] of document.urlCandidates.entries()) {
      if (
        !/^url:[0-9]+$/u.test(candidate.id) ||
        candidateIds.has(candidate.id) ||
        (candidate.documentId !== document.comment.documentId &&
          candidate.documentId !== document.root.documentId) ||
        (candidate.originField !== "href" &&
          candidate.originField !== "story_url")
      ) {
        fail(`${location} URL candidate ${candidateIndex + 1} is invalid`);
      }
      const parsed = (() => {
        try {
          return new URL(candidate.url);
        } catch {
          return fail(
            `${location} URL candidate ${candidateIndex + 1} is invalid`,
          );
        }
      })();
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        fail(`${location} URL candidate ${candidateIndex + 1} is invalid`);
      }
      candidateIds.add(candidate.id);
    }
  }
  const actualIds = documents.map((document) => document.commentId).sort();
  const expectedIds = [...expectedCommentIds].sort();
  if (
    new Set(actualIds).size !== actualIds.length ||
    actualIds.join(",") !== expectedIds.join(",")
  ) {
    fail("Annotation source IDs must exactly match the frozen cycle source");
  }
};

const hashedPacketOrder = (
  cycleId: string,
  annotatorId: EvaluationAnnotatorId,
  documents: readonly EvaluationAnnotationSourceDocument[],
): EvaluationAnnotationSourceDocument[] =>
  [...documents].sort((left, right) => {
    const leftHash = sha256(
      `annotation-packet:${cycleId}:${annotatorId}:${left.commentId}`,
    );
    const rightHash = sha256(
      `annotation-packet:${cycleId}:${annotatorId}:${right.commentId}`,
    );
    return (
      leftHash.localeCompare(rightHash) || left.commentId - right.commentId
    );
  });

const packetOrder = (
  cycleId: string,
  annotatorId: EvaluationAnnotatorId,
  documents: readonly EvaluationAnnotationSourceDocument[],
): EvaluationAnnotationSourceDocument[] => {
  const ordered = hashedPacketOrder(cycleId, annotatorId, documents);
  if (annotatorId === "A" || ordered.length < 2) {
    return ordered;
  }
  const aOrder = hashedPacketOrder(cycleId, "A", documents);
  if (
    ordered.some(
      (document, index) => document.commentId !== aOrder[index]?.commentId,
    )
  ) {
    return ordered;
  }
  const first = ordered[0] as EvaluationAnnotationSourceDocument;
  const second = ordered[1] as EvaluationAnnotationSourceDocument;
  return [second, first, ...ordered.slice(2)];
};

export const prepareEvaluationAnnotationPacket = (input: {
  readonly cycleId: string;
  readonly annotatorId: EvaluationAnnotatorId;
  readonly documents: readonly EvaluationAnnotationSourceDocument[];
  readonly expectedCommentIds: readonly number[];
}): EvaluationAnnotationPacketRow[] => {
  assertCycleId(input.cycleId);
  assertSourceSet(input.documents, input.expectedCommentIds);
  return packetOrder(input.cycleId, input.annotatorId, input.documents).map(
    (document) => ({
      schemaVersion: EVALUATION_ANNOTATION_PACKET_SCHEMA_VERSION,
      cycleId: input.cycleId,
      annotatorId: input.annotatorId,
      commentId: document.commentId,
      comment: document.comment,
      root: document.root,
      urlCandidates: document.urlCandidates,
    }),
  );
};

export const serializeEvaluationAnnotationPacket = (
  rows: readonly EvaluationAnnotationPacketRow[],
): string => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

const parseEvidenceSpan = (
  value: unknown,
  location: string,
  document: EvaluationAnnotationSourceDocument,
): EvidenceSpan => {
  const item = object(value, location);
  exactKeys(item, ["origin", "start", "end", "text"], location);
  const origin = enumValue(
    item["origin"],
    new Set(["COMMENT", "ROOT_STORY"] as const),
    `${location}.origin`,
  );
  const start = item["start"];
  const end = item["end"];
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    (start as number) < 0 ||
    (end as number) <= (start as number)
  ) {
    fail(`${location} has invalid offsets`);
  }
  const evidenceText = boundedText(
    item["text"],
    `${location}.text`,
    4096,
    true,
  );
  const sourceText =
    origin === "COMMENT" ? document.comment.plainText : document.root.plainText;
  if (
    (end as number) > sourceText.length ||
    sourceText.slice(start as number, end as number) !== evidenceText
  ) {
    fail(`${location} does not reproduce the frozen source`);
  }
  return {
    origin,
    start: start as number,
    end: end as number,
    text: evidenceText,
  };
};

const assertUniqueSpans = (
  spans: readonly EvidenceSpan[],
  location: string,
): void => {
  const keys = spans.map(
    (span) =>
      `${span.origin}\u0000${span.start}\u0000${span.end}\u0000${span.text}`,
  );
  if (new Set(keys).size !== keys.length) {
    fail(`${location} must not contain duplicate evidence spans`);
  }
};

const evidenceOrigin = (
  spans: readonly EvidenceSpan[],
  location: string,
): "COMMENT" | "ROOT_STORY" | "BOTH" => {
  if (spans.length === 0) {
    return fail(`${location} must contain at least one evidence span`);
  }
  const origins = new Set(spans.map((span) => span.origin));
  return origins.size === 2
    ? "BOTH"
    : origins.has("COMMENT")
      ? "COMMENT"
      : "ROOT_STORY";
};

const parseDiscovery = (
  value: unknown,
  location: string,
  document: EvaluationAnnotationSourceDocument,
): AnnotationDiscovery => {
  const item = object(value, location);
  exactKeys(
    item,
    [
      "subjectType",
      "name",
      "aliases",
      "description",
      "evidenceOrigin",
      "evidenceSpans",
      "urlCandidateIds",
      "rootOnly",
    ],
    location,
  );
  const name = boundedText(item["name"], `${location}.name`, 160);
  const aliases = stringArray(item["aliases"], `${location}.aliases`, 10, 160);
  const spans = array(
    item["evidenceSpans"],
    `${location}.evidenceSpans`,
    12,
  ).map((span, index) =>
    parseEvidenceSpan(span, `${location}.evidenceSpans[${index}]`, document),
  );
  assertUniqueSpans(spans, `${location}.evidenceSpans`);
  const actualOrigin = evidenceOrigin(spans, `${location}.evidenceSpans`);
  const declaredOrigin = enumValue(
    item["evidenceOrigin"],
    new Set(["COMMENT", "ROOT_STORY", "BOTH"] as const),
    `${location}.evidenceOrigin`,
  );
  if (declaredOrigin !== actualOrigin) {
    fail(`${location}.evidenceOrigin differs from its spans`);
  }
  const rootOnly =
    typeof item["rootOnly"] === "boolean"
      ? item["rootOnly"]
      : fail(`${location}.rootOnly must be a boolean`);
  if (rootOnly !== (actualOrigin === "ROOT_STORY")) {
    fail(`${location}.rootOnly differs from its evidence origin`);
  }
  const supportedNames = [name, ...aliases].map((entry) =>
    entry.toLocaleLowerCase(),
  );
  if (
    !spans.some((span) => {
      const normalized = span.text.toLocaleLowerCase();
      return supportedNames.some((supported) => normalized.includes(supported));
    })
  ) {
    fail(`${location}.name is not reproduced by supporting evidence`);
  }
  const urlCandidateIds = stringArray(
    item["urlCandidateIds"],
    `${location}.urlCandidateIds`,
    12,
    32,
    undefined,
    /^url:[0-9]+$/u,
  );
  const knownCandidateIds = new Set(
    document.urlCandidates.map((candidate) => candidate.id),
  );
  if (urlCandidateIds.some((id) => !knownCandidateIds.has(id))) {
    fail(`${location}.urlCandidateIds references an unknown candidate`);
  }
  return {
    subjectType: enumValue(
      item["subjectType"],
      SUBJECT_TYPES,
      `${location}.subjectType`,
    ),
    name,
    aliases,
    description: boundedText(
      item["description"],
      `${location}.description`,
      1000,
    ),
    evidenceOrigin: declaredOrigin,
    evidenceSpans: spans,
    urlCandidateIds,
    rootOnly,
  };
};

const parseExpertNote = (
  value: unknown,
  location: string,
  document: EvaluationAnnotationSourceDocument,
): AnnotationExpertNote => {
  const item = object(value, location);
  exactKeys(
    item,
    [
      "noteType",
      "title",
      "summary",
      "evidenceOrigin",
      "evidenceSpans",
      "relatedSubjectNames",
      "qualifiers",
    ],
    location,
  );
  const spans = array(
    item["evidenceSpans"],
    `${location}.evidenceSpans`,
    16,
  ).map((span, index) =>
    parseEvidenceSpan(span, `${location}.evidenceSpans[${index}]`, document),
  );
  assertUniqueSpans(spans, `${location}.evidenceSpans`);
  const actualOrigin = evidenceOrigin(spans, `${location}.evidenceSpans`);
  const declaredOrigin = enumValue(
    item["evidenceOrigin"],
    new Set(["COMMENT", "ROOT_STORY", "BOTH"] as const),
    `${location}.evidenceOrigin`,
  );
  if (declaredOrigin !== actualOrigin) {
    fail(`${location}.evidenceOrigin differs from its spans`);
  }
  return {
    noteType: enumValue(item["noteType"], NOTE_TYPES, `${location}.noteType`),
    title: boundedText(item["title"], `${location}.title`, 200),
    summary: boundedText(item["summary"], `${location}.summary`, 2000),
    evidenceOrigin: declaredOrigin,
    evidenceSpans: spans,
    relatedSubjectNames: stringArray(
      item["relatedSubjectNames"],
      `${location}.relatedSubjectNames`,
      12,
      160,
    ),
    qualifiers: stringArray(
      item["qualifiers"],
      `${location}.qualifiers`,
      12,
      300,
    ),
  };
};

const parsePassRow = (
  value: unknown,
  index: number,
  input: {
    readonly cycleId: string;
    readonly annotatorId: EvaluationAnnotatorId;
    readonly sourceById: ReadonlyMap<
      number,
      EvaluationAnnotationSourceDocument
    >;
  },
): EvaluationAnnotationPassRow => {
  const location = `row ${index + 1}`;
  const item = object(value, location);
  exactKeys(
    item,
    [
      "schemaVersion",
      "cycleId",
      "commentId",
      "materialRelevance",
      "primaryClass",
      "discoveries",
      "expertNote",
      "reviewFlags",
      "rejectionReason",
      "annotator",
    ],
    location,
  );
  if (item["schemaVersion"] !== EVALUATION_ANNOTATION_PASS_SCHEMA_VERSION) {
    fail(`${location}.schemaVersion is unsupported`);
  }
  if (item["cycleId"] !== input.cycleId) {
    fail(`${location}.cycleId does not match ${input.cycleId}`);
  }
  const commentId = integer(item["commentId"], `${location}.commentId`);
  const document =
    input.sourceById.get(commentId) ??
    fail(`${location}.commentId is not in the frozen source`);
  const materialRelevance = enumValue(
    item["materialRelevance"],
    MATERIAL_RELEVANCE,
    `${location}.materialRelevance`,
  );
  const primaryClass = enumValue(
    item["primaryClass"],
    PRIMARY_CLASSES,
    `${location}.primaryClass`,
  );
  const discoveries = array(
    item["discoveries"],
    `${location}.discoveries`,
    5,
  ).map((discovery, discoveryIndex) =>
    parseDiscovery(
      discovery,
      `${location}.discoveries[${discoveryIndex}]`,
      document,
    ),
  );
  const expertNote =
    item["expertNote"] === null
      ? null
      : parseExpertNote(item["expertNote"], `${location}.expertNote`, document);
  const reviewFlags = stringArray(
    item["reviewFlags"],
    `${location}.reviewFlags`,
    12,
    64,
    REVIEW_FLAGS,
  );
  const rejectionReason =
    item["rejectionReason"] === null
      ? null
      : enumValue(
          item["rejectionReason"],
          REJECTION_REASONS,
          `${location}.rejectionReason`,
        );
  const annotator = object(item["annotator"], `${location}.annotator`);
  exactKeys(annotator, ["id", "method"], `${location}.annotator`);
  if (annotator["id"] !== input.annotatorId) {
    fail(`${location}.annotator.id must be ${input.annotatorId}`);
  }
  const method = boundedText(
    annotator["method"],
    `${location}.annotator.method`,
    120,
  );
  if (method !== "independent-bounded-review") {
    fail(`${location}.annotator.method is unsupported`);
  }

  if (primaryClass === "DISCOVERY") {
    if (discoveries.length === 0 || rejectionReason !== null) {
      fail(`${location} DISCOVERY content is inconsistent`);
    }
  } else if (primaryClass === "EXPERT_NOTE") {
    if (
      discoveries.length !== 0 ||
      expertNote === null ||
      rejectionReason !== null
    ) {
      fail(`${location} EXPERT_NOTE content is inconsistent`);
    }
  } else if (
    discoveries.length !== 0 ||
    expertNote !== null ||
    rejectionReason === null
  ) {
    fail(`${location} REJECTED content is inconsistent`);
  }
  if (
    (materialRelevance === "MATERIAL" && primaryClass === "REJECTED") ||
    (materialRelevance === "NOT_MATERIAL" && primaryClass !== "REJECTED")
  ) {
    fail(`${location}.materialRelevance conflicts with primaryClass`);
  }
  if (
    materialRelevance === "UNCERTAIN" &&
    !reviewFlags.includes("AMBIGUOUS_CLASSIFICATION")
  ) {
    fail(
      `${location} uncertain material relevance requires AMBIGUOUS_CLASSIFICATION`,
    );
  }
  if (
    discoveries.some((discovery) => discovery.rootOnly) &&
    !reviewFlags.includes("ROOT_ONLY_DISCOVERY")
  ) {
    fail(`${location} root-only discoveries require ROOT_ONLY_DISCOVERY`);
  }
  if (
    discoveries.some((discovery) => discovery.urlCandidateIds.length === 0) &&
    !reviewFlags.includes("MISSING_CANONICAL_URL")
  ) {
    fail(`${location} discoveries without a URL require MISSING_CANONICAL_URL`);
  }

  return {
    schemaVersion: EVALUATION_ANNOTATION_PASS_SCHEMA_VERSION,
    cycleId: input.cycleId,
    commentId,
    materialRelevance,
    primaryClass,
    discoveries,
    expertNote,
    reviewFlags,
    rejectionReason,
    annotator: { id: input.annotatorId, method },
  };
};

export const parseEvaluationAnnotationPass = (input: {
  readonly cycleId: string;
  readonly annotatorId: EvaluationAnnotatorId;
  readonly documents: readonly EvaluationAnnotationSourceDocument[];
  readonly expectedCommentIds: readonly number[];
  readonly rows: readonly unknown[];
}): EvaluationAnnotationPassRow[] => {
  assertCycleId(input.cycleId);
  assertSourceSet(input.documents, input.expectedCommentIds);
  const sourceById = new Map(
    input.documents.map((document) => [document.commentId, document]),
  );
  const rows = input.rows.map((row, index) =>
    parsePassRow(row, index, {
      cycleId: input.cycleId,
      annotatorId: input.annotatorId,
      sourceById,
    }),
  );
  const rowIds = rows.map((row) => row.commentId).sort();
  const expectedIds = [...input.expectedCommentIds].sort();
  if (
    new Set(rowIds).size !== rowIds.length ||
    rowIds.join(",") !== expectedIds.join(",")
  ) {
    fail("Annotation pass must contain every frozen comment exactly once");
  }
  return rows;
};

export const validateEvaluationAnnotationPass = (input: {
  readonly cycleId: string;
  readonly annotatorId: EvaluationAnnotatorId;
  readonly documents: readonly EvaluationAnnotationSourceDocument[];
  readonly expectedCommentIds: readonly number[];
  readonly rows: readonly unknown[];
}): EvaluationAnnotationPassSummary => {
  const rows = parseEvaluationAnnotationPass(input);
  return {
    rows: rows.length,
    uniqueCommentIds: new Set(rows.map((row) => row.commentId)).size,
    materialRelevance: Object.fromEntries(
      [...MATERIAL_RELEVANCE].map((value) => [
        value,
        rows.filter((row) => row.materialRelevance === value).length,
      ]),
    ) as Record<EvaluationMaterialRelevance, number>,
    primaryClass: Object.fromEntries(
      [...PRIMARY_CLASSES].map((value) => [
        value,
        rows.filter((row) => row.primaryClass === value).length,
      ]),
    ) as Record<EvaluationPrimaryClass, number>,
    reviewRows: rows.filter((row) => row.reviewFlags.length > 0).length,
  };
};

const cohensKappa = <T extends string>(
  left: readonly T[],
  right: readonly T[],
  labels: readonly T[],
): number => {
  if (left.length === 0 || left.length !== right.length) {
    return fail("Cohen's kappa requires two non-empty, aligned label sets");
  }
  const observedAgreement =
    left.filter((value, index) => value === right[index]).length / left.length;
  const expectedAgreement = labels.reduce((total, label) => {
    const leftRate =
      left.filter((value) => value === label).length / left.length;
    const rightRate =
      right.filter((value) => value === label).length / right.length;
    return total + leftRate * rightRate;
  }, 0);
  if (expectedAgreement === 1) {
    return observedAgreement === 1 ? 1 : 0;
  }
  return (observedAgreement - expectedAgreement) / (1 - expectedAgreement);
};

export const compareEvaluationAnnotationPasses = (input: {
  readonly annotatorA: readonly EvaluationAnnotationPassRow[];
  readonly annotatorB: readonly EvaluationAnnotationPassRow[];
}): EvaluationAnnotationComparison => {
  const bById = new Map(input.annotatorB.map((row) => [row.commentId, row]));
  const aIds = new Set(input.annotatorA.map((row) => row.commentId));
  if (
    input.annotatorA.length === 0 ||
    input.annotatorA.length !== input.annotatorB.length ||
    aIds.size !== input.annotatorA.length ||
    bById.size !== input.annotatorB.length
  ) {
    fail("Annotation passes must contain the same unique comment IDs");
  }
  const aligned = input.annotatorA.map((annotatorA) => {
    const annotatorB =
      bById.get(annotatorA.commentId) ??
      fail(`Annotator B is missing comment ${annotatorA.commentId}`);
    if (
      annotatorA.cycleId !== annotatorB.cycleId ||
      annotatorA.annotator.id !== "A" ||
      annotatorB.annotator.id !== "B"
    ) {
      fail(`Annotation pass identity mismatch for ${annotatorA.commentId}`);
    }
    return { annotatorA, annotatorB };
  });
  const primaryClassKappa = cohensKappa(
    aligned.map(({ annotatorA }) => annotatorA.primaryClass),
    aligned.map(({ annotatorB }) => annotatorB.primaryClass),
    [...PRIMARY_CLASSES],
  );
  const materialRelevanceKappa = cohensKappa(
    aligned.map(({ annotatorA }) => annotatorA.materialRelevance),
    aligned.map(({ annotatorB }) => annotatorB.materialRelevance),
    [...MATERIAL_RELEVANCE],
  );
  const disagreements = aligned
    .filter(
      ({ annotatorA, annotatorB }) =>
        annotatorA.primaryClass !== annotatorB.primaryClass ||
        annotatorA.materialRelevance !== annotatorB.materialRelevance,
    )
    .map(({ annotatorA, annotatorB }) => ({
      commentId: annotatorA.commentId,
      materialRelevance: {
        annotatorA: annotatorA.materialRelevance,
        annotatorB: annotatorB.materialRelevance,
      },
      primaryClass: {
        annotatorA: annotatorA.primaryClass,
        annotatorB: annotatorB.primaryClass,
      },
      annotatorA,
      annotatorB,
    }));
  return {
    rows: aligned.length,
    exactDecisionAgreementRows: aligned.length - disagreements.length,
    primaryClassKappa,
    materialRelevanceKappa,
    passed:
      primaryClassKappa >= MINIMUM_ANNOTATION_COHENS_KAPPA &&
      materialRelevanceKappa >= MINIMUM_ANNOTATION_COHENS_KAPPA,
    disagreements,
  };
};

export const serializeEvaluationAdjudicationPacket = (
  comparison: EvaluationAnnotationComparison,
  documents: readonly EvaluationAnnotationSourceDocument[],
): string => {
  if (comparison.disagreements.length === 0) {
    return "";
  }
  const sourceById = new Map(
    documents.map((document) => [document.commentId, document]),
  );
  if (sourceById.size !== documents.length) {
    return fail("Adjudication source comment IDs must be unique");
  }
  return `${comparison.disagreements
    .map((disagreement) => {
      const source =
        sourceById.get(disagreement.commentId) ??
        fail(`Missing adjudication source for ${disagreement.commentId}`);
      return JSON.stringify({
        schemaVersion: EVALUATION_ADJUDICATION_PACKET_SCHEMA_VERSION,
        cycleId: disagreement.annotatorA.cycleId,
        commentId: disagreement.commentId,
        source: {
          comment: source.comment,
          root: source.root,
          urlCandidates: source.urlCandidates,
        },
        materialRelevance: disagreement.materialRelevance,
        primaryClass: disagreement.primaryClass,
        annotatorA: disagreement.annotatorA,
        annotatorB: disagreement.annotatorB,
      });
    })
    .join("\n")}\n`;
};
