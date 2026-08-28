import { createHash } from "node:crypto";

import {
  compareEvaluationAnnotationPasses,
  type EvaluationAnnotationComparison,
  type EvaluationAnnotationEvidenceSpan,
  type EvaluationAnnotationPassRow,
  type EvaluationMaterialRelevance,
} from "./annotation-packet.js";
import type { EvaluationPrimaryClass } from "./evaluation-metrics.js";

export const EVALUATION_ADJUDICATION_RESPONSE_SCHEMA_VERSION =
  "annotation-adjudication.v2";
export const EVALUATION_GOLD_SCHEMA_VERSION = "gold.v2";
export const EVALUATION_ADJUDICATION_METHOD = "bounded-disagreement-review";
export const EVALUATION_CONSENSUS_ADJUDICATOR = "deterministic-consensus";
export const EVALUATION_CONSENSUS_RATIONALE =
  "Independent annotators agreed on material relevance and primary class; annotator A's grounded extraction was retained deterministically.";

export interface EvaluationAdjudicationResponse {
  readonly schemaVersion: typeof EVALUATION_ADJUDICATION_RESPONSE_SCHEMA_VERSION;
  readonly cycleId: string;
  readonly commentId: number;
  readonly preferredPass: "A" | "B";
  readonly rationale: string;
  readonly adjudicator: {
    readonly id: string;
    readonly method: typeof EVALUATION_ADJUDICATION_METHOD;
  };
}

export interface EvaluationGoldEvidenceSpan {
  readonly id: string;
  readonly documentId: string;
  readonly origin: "COMMENT" | "ROOT_STORY";
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly textSha256: string;
}

export interface EvaluationGoldRowV2 {
  readonly schemaVersion: typeof EVALUATION_GOLD_SCHEMA_VERSION;
  readonly cycleId: string;
  readonly commentId: number;
  readonly materialRelevance: EvaluationMaterialRelevance;
  readonly primaryClass: EvaluationPrimaryClass;
  readonly evidenceSpans: readonly EvaluationGoldEvidenceSpan[];
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
  readonly holdout: boolean;
  readonly annotation: {
    readonly annotatorA: {
      readonly id: "A";
      readonly materialRelevance: EvaluationMaterialRelevance;
      readonly primaryClass: EvaluationPrimaryClass;
    };
    readonly annotatorB: {
      readonly id: "B";
      readonly materialRelevance: EvaluationMaterialRelevance;
      readonly primaryClass: EvaluationPrimaryClass;
    };
    readonly adjudication: {
      readonly adjudicator: string;
      readonly preferredPass: "A" | "B";
      readonly materialRelevanceDisagreement: boolean;
      readonly primaryClassDisagreement: boolean;
      readonly rationale: string;
    };
  };
}

export interface EvaluationAnnotationFinalization {
  readonly comparison: EvaluationAnnotationComparison;
  readonly adjudications: readonly EvaluationAdjudicationResponse[];
  readonly gold: readonly EvaluationGoldRowV2[];
}

const RAW_URL = /https?:\/\//iu;
const ADJUDICATOR_ID = /^[a-z0-9][a-z0-9._-]{0,119}$/u;

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

const boundedText = (
  value: unknown,
  location: string,
  minimum: number,
  maximum: number,
): string => {
  if (
    typeof value !== "string" ||
    value.trim().length < minimum ||
    value.length > maximum
  ) {
    return fail(`${location} must contain ${minimum} to ${maximum} characters`);
  }
  if (RAW_URL.test(value)) {
    fail(`${location} must not contain raw URLs`);
  }
  return value;
};

const positiveInteger = (value: unknown, location: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    return fail(`${location} must be a positive safe integer`);
  }
  return value as number;
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const parseEvaluationAdjudicationResponses = (input: {
  readonly cycleId: string;
  readonly comparison: EvaluationAnnotationComparison;
  readonly rows: readonly unknown[];
}): EvaluationAdjudicationResponse[] => {
  if (!input.comparison.passed) {
    fail("Annotation agreement gates must pass before adjudication");
  }
  const expectedIds = new Set(
    input.comparison.disagreements.map((row) => row.commentId),
  );
  const adjudications = input.rows.map(
    (value, index): EvaluationAdjudicationResponse => {
      const location = `adjudication row ${index + 1}`;
      const item = object(value, location);
      exactKeys(
        item,
        [
          "schemaVersion",
          "cycleId",
          "commentId",
          "preferredPass",
          "rationale",
          "adjudicator",
        ],
        location,
      );
      if (
        item["schemaVersion"] !==
        EVALUATION_ADJUDICATION_RESPONSE_SCHEMA_VERSION
      ) {
        fail(`${location}.schemaVersion is unsupported`);
      }
      if (item["cycleId"] !== input.cycleId) {
        fail(`${location}.cycleId does not match ${input.cycleId}`);
      }
      const commentId = positiveInteger(
        item["commentId"],
        `${location}.commentId`,
      );
      if (!expectedIds.has(commentId)) {
        fail(`${location}.commentId is not a decision disagreement`);
      }
      const preferredPass =
        item["preferredPass"] === "A" || item["preferredPass"] === "B"
          ? item["preferredPass"]
          : fail(`${location}.preferredPass must be A or B`);
      const adjudicator = object(
        item["adjudicator"],
        `${location}.adjudicator`,
      );
      exactKeys(adjudicator, ["id", "method"], `${location}.adjudicator`);
      const adjudicatorId = boundedText(
        adjudicator["id"],
        `${location}.adjudicator.id`,
        1,
        120,
      );
      if (!ADJUDICATOR_ID.test(adjudicatorId)) {
        fail(`${location}.adjudicator.id has an invalid format`);
      }
      if (adjudicator["method"] !== EVALUATION_ADJUDICATION_METHOD) {
        fail(`${location}.adjudicator.method is unsupported`);
      }
      return {
        schemaVersion: EVALUATION_ADJUDICATION_RESPONSE_SCHEMA_VERSION,
        cycleId: input.cycleId,
        commentId,
        preferredPass,
        rationale: boundedText(
          item["rationale"],
          `${location}.rationale`,
          20,
          1000,
        ),
        adjudicator: {
          id: adjudicatorId,
          method: EVALUATION_ADJUDICATION_METHOD,
        },
      };
    },
  );
  const actualIds = adjudications.map((row) => row.commentId);
  if (new Set(actualIds).size !== actualIds.length) {
    fail("Adjudication responses must not contain duplicate comment IDs");
  }
  if (
    actualIds.length !== expectedIds.size ||
    actualIds.some((commentId) => !expectedIds.has(commentId))
  ) {
    fail("Adjudication responses must resolve every disagreement exactly once");
  }
  return adjudications.sort((left, right) => left.commentId - right.commentId);
};

const spanKey = (span: EvaluationAnnotationEvidenceSpan): string =>
  `${span.origin}\u0000${span.start}\u0000${span.end}\u0000${span.text}`;

const selectedGoldContent = (input: {
  readonly selected: EvaluationAnnotationPassRow;
  readonly rootId: number;
}): Pick<
  EvaluationGoldRowV2,
  | "evidenceSpans"
  | "discoveries"
  | "expertNote"
  | "reviewFlags"
  | "rejectionReason"
> => {
  const proposedSpans = [
    ...input.selected.discoveries.flatMap(
      (discovery) => discovery.evidenceSpans,
    ),
    ...(input.selected.expertNote?.evidenceSpans ?? []),
  ];
  const uniqueSpans = [
    ...new Map(proposedSpans.map((span) => [spanKey(span), span])).values(),
  ];
  if (uniqueSpans.length > 32) {
    fail(
      `Comment ${input.selected.commentId} exceeds 32 unique evidence spans`,
    );
  }
  const counters = { COMMENT: 0, ROOT_STORY: 0 };
  const spanIds = new Map<string, string>();
  const evidenceSpans = uniqueSpans.map((span) => {
    const label = span.origin === "COMMENT" ? "comment" : "root";
    const id = `span:${label}:${counters[span.origin]++}`;
    spanIds.set(spanKey(span), id);
    return {
      id,
      documentId:
        span.origin === "COMMENT"
          ? `comment:${input.selected.commentId}`
          : `root:${input.rootId}`,
      origin: span.origin,
      start: span.start,
      end: span.end,
      text: span.text,
      textSha256: sha256(span.text),
    };
  });
  const idsFor = (
    spans: readonly EvaluationAnnotationEvidenceSpan[],
  ): string[] =>
    spans.map((span) => {
      const id = spanIds.get(spanKey(span));
      return (
        id ?? fail(`Missing evidence span ID for ${input.selected.commentId}`)
      );
    });

  return {
    evidenceSpans,
    discoveries: input.selected.discoveries.map((discovery) => ({
      subjectType: discovery.subjectType,
      name: discovery.name,
      aliases: discovery.aliases,
      description: discovery.description,
      evidenceOrigin: discovery.evidenceOrigin,
      evidenceSpanIds: idsFor(discovery.evidenceSpans),
      urlCandidateIds: discovery.urlCandidateIds,
      rootOnly: discovery.rootOnly,
    })),
    expertNote:
      input.selected.expertNote === null
        ? null
        : {
            noteType: input.selected.expertNote.noteType,
            title: input.selected.expertNote.title,
            summary: input.selected.expertNote.summary,
            evidenceOrigin: input.selected.expertNote.evidenceOrigin,
            evidenceSpanIds: idsFor(input.selected.expertNote.evidenceSpans),
            relatedSubjectNames: input.selected.expertNote.relatedSubjectNames,
            qualifiers: input.selected.expertNote.qualifiers,
          },
    reviewFlags: input.selected.reviewFlags,
    rejectionReason: input.selected.rejectionReason,
  };
};

export const finalizeEvaluationAnnotations = (input: {
  readonly cycleId: string;
  readonly annotatorA: readonly EvaluationAnnotationPassRow[];
  readonly annotatorB: readonly EvaluationAnnotationPassRow[];
  readonly rootIdsByCommentId: ReadonlyMap<number, number>;
  readonly holdoutCommentIds: readonly number[];
  readonly adjudicationRows: readonly unknown[];
}): EvaluationAnnotationFinalization => {
  if (
    [...input.annotatorA, ...input.annotatorB].some(
      (row) => row.cycleId !== input.cycleId,
    )
  ) {
    fail(`Annotation passes must belong to ${input.cycleId}`);
  }
  const comparison = compareEvaluationAnnotationPasses({
    annotatorA: input.annotatorA,
    annotatorB: input.annotatorB,
  });
  if (!comparison.passed) {
    fail("Annotation agreement gates must pass before finalization");
  }
  const adjudications = parseEvaluationAdjudicationResponses({
    cycleId: input.cycleId,
    comparison,
    rows: input.adjudicationRows,
  });
  const adjudicationById = new Map(
    adjudications.map((row) => [row.commentId, row]),
  );
  const aById = new Map(input.annotatorA.map((row) => [row.commentId, row]));
  const bById = new Map(input.annotatorB.map((row) => [row.commentId, row]));
  const knownIds = new Set(aById.keys());
  const holdoutIds = new Set(input.holdoutCommentIds);
  if (
    holdoutIds.size !== input.holdoutCommentIds.length ||
    [...holdoutIds].some((commentId) => !knownIds.has(commentId))
  ) {
    fail("Holdout IDs must be unique members of the annotation passes");
  }

  const gold = [...knownIds]
    .sort((left, right) => left - right)
    .map((commentId): EvaluationGoldRowV2 => {
      const annotatorA = aById.get(commentId) as EvaluationAnnotationPassRow;
      const annotatorB = bById.get(commentId) as EvaluationAnnotationPassRow;
      const materialRelevanceDisagreement =
        annotatorA.materialRelevance !== annotatorB.materialRelevance;
      const primaryClassDisagreement =
        annotatorA.primaryClass !== annotatorB.primaryClass;
      const disagreed =
        materialRelevanceDisagreement || primaryClassDisagreement;
      const adjudication = adjudicationById.get(commentId);
      if (disagreed !== (adjudication !== undefined)) {
        fail(`Comment ${commentId} has inconsistent adjudication coverage`);
      }
      const preferredPass = adjudication?.preferredPass ?? "A";
      const selected = preferredPass === "A" ? annotatorA : annotatorB;
      const rootId =
        input.rootIdsByCommentId.get(commentId) ??
        fail(`Missing root ID for comment ${commentId}`);
      const content = selectedGoldContent({ selected, rootId });
      return {
        schemaVersion: EVALUATION_GOLD_SCHEMA_VERSION,
        cycleId: input.cycleId,
        commentId,
        materialRelevance: selected.materialRelevance,
        primaryClass: selected.primaryClass,
        ...content,
        holdout: holdoutIds.has(commentId),
        annotation: {
          annotatorA: {
            id: "A",
            materialRelevance: annotatorA.materialRelevance,
            primaryClass: annotatorA.primaryClass,
          },
          annotatorB: {
            id: "B",
            materialRelevance: annotatorB.materialRelevance,
            primaryClass: annotatorB.primaryClass,
          },
          adjudication: {
            adjudicator:
              adjudication?.adjudicator.id ?? EVALUATION_CONSENSUS_ADJUDICATOR,
            preferredPass,
            materialRelevanceDisagreement,
            primaryClassDisagreement,
            rationale:
              adjudication?.rationale ?? EVALUATION_CONSENSUS_RATIONALE,
          },
        },
      };
    });

  return { comparison, adjudications, gold };
};

export const serializeEvaluationGoldV2 = (
  rows: readonly EvaluationGoldRowV2[],
): string => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
