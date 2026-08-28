import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  EVALUATION_CONSENSUS_ADJUDICATOR,
  EVALUATION_CONSENSUS_RATIONALE,
  finalizeEvaluationAnnotations,
  serializeEvaluationGoldV2,
  type EvaluationAnnotationPassRow,
} from "@hn-knowledge/application";

const span = (commentId: number) => ({
  origin: "COMMENT" as const,
  start: 0,
  end: 8,
  text: `Item${commentId}`.slice(0, 8),
});

const row = (
  commentId: number,
  annotatorId: "A" | "B",
  primaryClass: "DISCOVERY" | "EXPERT_NOTE" | "REJECTED",
): EvaluationAnnotationPassRow => ({
  schemaVersion: "annotation-pass.v2",
  cycleId: "v2",
  commentId,
  materialRelevance: primaryClass === "REJECTED" ? "NOT_MATERIAL" : "MATERIAL",
  primaryClass,
  discoveries:
    primaryClass === "DISCOVERY"
      ? [
          {
            subjectType: "TOOL",
            name: `Item${commentId}`,
            aliases: [],
            description: "A bounded technical item.",
            evidenceOrigin: "COMMENT",
            evidenceSpans: [span(commentId)],
            urlCandidateIds: ["url:0"],
            rootOnly: false,
          },
        ]
      : [],
  expertNote:
    primaryClass === "EXPERT_NOTE"
      ? {
          noteType: "TECHNICAL_EXPLANATION",
          title: `Item ${commentId} explanation`,
          summary: "A bounded technical explanation.",
          evidenceOrigin: "COMMENT",
          evidenceSpans: [span(commentId)],
          relatedSubjectNames: [`Item${commentId}`],
          qualifiers: [],
        }
      : null,
  reviewFlags: [],
  rejectionReason: primaryClass === "REJECTED" ? "LOW_INFORMATION" : null,
  annotator: {
    id: annotatorId,
    method: "independent-bounded-review",
  },
});

const passes = (): {
  annotatorA: EvaluationAnnotationPassRow[];
  annotatorB: EvaluationAnnotationPassRow[];
} => {
  const primaryClasses = [
    ...Array.from({ length: 10 }, () => "DISCOVERY" as const),
    ...Array.from({ length: 10 }, () => "EXPERT_NOTE" as const),
    ...Array.from({ length: 10 }, () => "REJECTED" as const),
  ];
  const annotatorA = primaryClasses.map((primaryClass, index) =>
    row(1001 + index, "A", primaryClass),
  );
  const annotatorB = primaryClasses.map((primaryClass, index) =>
    row(1001 + index, "B", primaryClass),
  );
  annotatorB[0] = row(1001, "B", "EXPERT_NOTE");
  const materialDisagreement = annotatorB[20];
  if (materialDisagreement === undefined) {
    throw new Error("Expected a material-disagreement fixture row");
  }
  annotatorB[20] = {
    ...materialDisagreement,
    materialRelevance: "UNCERTAIN",
    reviewFlags: ["AMBIGUOUS_CLASSIFICATION"],
  };
  return { annotatorA, annotatorB };
};

const responses = (): unknown[] => [
  {
    schemaVersion: "annotation-adjudication.v2",
    cycleId: "v2",
    commentId: 1001,
    preferredPass: "B",
    rationale:
      "The second proposal better represents the bounded technical explanation.",
    adjudicator: {
      id: "owner-review",
      method: "bounded-disagreement-review",
    },
  },
  {
    schemaVersion: "annotation-adjudication.v2",
    cycleId: "v2",
    commentId: 1021,
    preferredPass: "A",
    rationale:
      "The available evidence supports a definite non-material decision here.",
    adjudicator: {
      id: "owner-review",
      method: "bounded-disagreement-review",
    },
  },
];

const finalize = (adjudicationRows: readonly unknown[] = responses()) => {
  const { annotatorA, annotatorB } = passes();
  return finalizeEvaluationAnnotations({
    cycleId: "v2",
    annotatorA,
    annotatorB,
    rootIdsByCommentId: new Map(
      annotatorA.map((entry) => [entry.commentId, entry.commentId + 1000]),
    ),
    holdoutCommentIds: [1002, 1021],
    adjudicationRows,
  });
};

describe("evaluation annotation adjudication", () => {
  it("publishes strict response and gold schemas", async () => {
    const [responseSchema, goldSchema] = await Promise.all([
      readFile(
        "evaluation/annotation-adjudication-schema-v2.json",
        "utf8",
      ).then((value) => JSON.parse(value) as Record<string, unknown>),
      readFile("evaluation/annotation-schema-v2.json", "utf8").then(
        (value) => JSON.parse(value) as Record<string, unknown>,
      ),
    ]);

    expect(responseSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        schemaVersion: { const: "annotation-adjudication.v2" },
        preferredPass: { enum: ["A", "B"] },
      },
    });
    expect(goldSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        schemaVersion: { const: "gold.v2" },
        materialRelevance: {
          enum: ["MATERIAL", "NOT_MATERIAL", "UNCERTAIN"],
        },
      },
    });
  });

  it("selects only complete A or B proposals and freezes grounded gold", () => {
    const result = finalize();

    expect(result.comparison.passed).toBe(true);
    expect(result.comparison.disagreements).toHaveLength(2);
    expect(result.adjudications).toHaveLength(2);
    expect(result.gold).toHaveLength(30);
    const primaryDecision = result.gold[0];
    if (primaryDecision === undefined) {
      throw new Error("Expected a finalized primary-decision row");
    }
    expect(primaryDecision).toMatchObject({
      schemaVersion: "gold.v2",
      cycleId: "v2",
      commentId: 1001,
      materialRelevance: "MATERIAL",
      primaryClass: "EXPERT_NOTE",
      holdout: false,
      annotation: {
        adjudication: {
          adjudicator: "owner-review",
          preferredPass: "B",
          materialRelevanceDisagreement: false,
          primaryClassDisagreement: true,
        },
      },
    });
    expect(primaryDecision.discoveries).toEqual([]);
    expect(primaryDecision.expertNote).not.toBeNull();
    const evidenceSpan = primaryDecision.evidenceSpans[0];
    if (evidenceSpan === undefined) {
      throw new Error("Expected finalized evidence");
    }
    expect(evidenceSpan).toMatchObject({
      id: "span:comment:0",
      documentId: "comment:1001",
      textSha256: createHash("sha256").update(evidenceSpan.text).digest("hex"),
    });
    const materialDecision = result.gold.find(
      (entry) => entry.commentId === 1021,
    );
    expect(materialDecision).toMatchObject({
      materialRelevance: "NOT_MATERIAL",
      primaryClass: "REJECTED",
      holdout: true,
      annotation: {
        adjudication: {
          preferredPass: "A",
          materialRelevanceDisagreement: true,
          primaryClassDisagreement: false,
        },
      },
    });
    expect(
      serializeEvaluationGoldV2(result.gold).trim().split("\n"),
    ).toHaveLength(30);
  });

  it("uses a deterministic policy only when both decisions agree", () => {
    const consensus = finalize().gold.find((entry) => entry.commentId === 1002);

    expect(consensus?.annotation.adjudication).toEqual({
      adjudicator: EVALUATION_CONSENSUS_ADJUDICATOR,
      preferredPass: "A",
      materialRelevanceDisagreement: false,
      primaryClassDisagreement: false,
      rationale: EVALUATION_CONSENSUS_RATIONALE,
    });
    expect(consensus?.holdout).toBe(true);
  });

  it("requires one bounded rationale for every disagreement", () => {
    expect(() => finalize(responses().slice(0, 1))).toThrow(
      /resolve every disagreement exactly once/u,
    );

    const duplicate = [...responses(), responses()[0]];
    expect(() => finalize(duplicate)).toThrow(/duplicate comment IDs/u);

    const invalid = structuredClone(responses());
    const first = invalid[0] as Record<string, unknown>;
    first["preferredPass"] = "OVERRIDE";
    expect(() => finalize(invalid)).toThrow(/must be A or B/u);

    const short = structuredClone(responses());
    const shortFirst = short[0] as Record<string, unknown>;
    shortFirst["rationale"] = "Prefer B";
    expect(() => finalize(short)).toThrow(/20 to 1000/u);
  });

  it("refuses finalization when either agreement gate fails", () => {
    const { annotatorA, annotatorB } = passes();
    const failedB = annotatorB.map((entry, index) =>
      index < 10 ? row(entry.commentId, "B", "REJECTED") : entry,
    );

    expect(() =>
      finalizeEvaluationAnnotations({
        cycleId: "v2",
        annotatorA,
        annotatorB: failedB,
        rootIdsByCommentId: new Map(
          annotatorA.map((entry) => [entry.commentId, entry.commentId + 1000]),
        ),
        holdoutCommentIds: [1002],
        adjudicationRows: [],
      }),
    ).toThrow(/agreement gates must pass/u);
  });

  it("refuses annotation passes from another cycle", () => {
    const { annotatorA, annotatorB } = passes();
    const wrongCycleA = annotatorA.map((entry) => ({
      ...entry,
      cycleId: "v3",
    }));
    const wrongCycleB = annotatorB.map((entry) => ({
      ...entry,
      cycleId: "v3",
    }));

    expect(() =>
      finalizeEvaluationAnnotations({
        cycleId: "v2",
        annotatorA: wrongCycleA,
        annotatorB: wrongCycleB,
        rootIdsByCommentId: new Map(
          annotatorA.map((entry) => [entry.commentId, entry.commentId + 1000]),
        ),
        holdoutCommentIds: [1002],
        adjudicationRows: responses(),
      }),
    ).toThrow(/must belong to v2/u);
  });
});
