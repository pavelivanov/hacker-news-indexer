import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  compareEvaluationAnnotationPasses,
  MINIMUM_ANNOTATION_COHENS_KAPPA,
  parseEvaluationAnnotationPass,
  prepareEvaluationAnnotationPacket,
  serializeEvaluationAdjudicationPacket,
  serializeEvaluationAnnotationPacket,
  validateEvaluationAnnotationPass,
  type EvaluationAnnotationSourceDocument,
} from "@hn-knowledge/application";

const documents: readonly EvaluationAnnotationSourceDocument[] = [
  {
    commentId: 101,
    rootId: 201,
    comment: {
      documentId: "comment:101",
      plainText: "Toolbox is a useful library for bounded work.",
    },
    root: {
      documentId: "root:201",
      title: "Toolbox release",
      plainText: "Toolbox release\n\nProject details.",
    },
    urlCandidates: [
      {
        id: "url:0",
        documentId: "comment:101",
        originField: "href",
        url: "https://example.test/toolbox",
      },
    ],
  },
  {
    commentId: 102,
    rootId: 202,
    comment: {
      documentId: "comment:102",
      plainText: "Caching reduces repeated work.",
    },
    root: {
      documentId: "root:202",
      title: "Caching",
      plainText: "Caching\n\nA root explanation.",
    },
    urlCandidates: [],
  },
  {
    commentId: 103,
    rootId: 203,
    comment: {
      documentId: "comment:103",
      plainText: "Neat.",
    },
    root: {
      documentId: "root:203",
      title: "A project",
      plainText: "A project",
    },
    urlCandidates: [],
  },
];
const expectedCommentIds = documents.map((document) => document.commentId);

const validPassRows = (): unknown[] => [
  {
    schemaVersion: "annotation-pass.v2",
    cycleId: "v2",
    commentId: 101,
    materialRelevance: "MATERIAL",
    primaryClass: "DISCOVERY",
    discoveries: [
      {
        subjectType: "LIBRARY",
        name: "Toolbox",
        aliases: [],
        description: "A library for bounded work.",
        evidenceOrigin: "COMMENT",
        evidenceSpans: [
          {
            origin: "COMMENT",
            start: 0,
            end: 45,
            text: "Toolbox is a useful library for bounded work.",
          },
        ],
        urlCandidateIds: ["url:0"],
        rootOnly: false,
      },
    ],
    expertNote: null,
    reviewFlags: [],
    rejectionReason: null,
    annotator: { id: "A", method: "independent-bounded-review" },
  },
  {
    schemaVersion: "annotation-pass.v2",
    cycleId: "v2",
    commentId: 102,
    materialRelevance: "MATERIAL",
    primaryClass: "EXPERT_NOTE",
    discoveries: [],
    expertNote: {
      noteType: "TECHNICAL_EXPLANATION",
      title: "Caching avoids repeated work",
      summary: "Caching can avoid repeating the same work.",
      evidenceOrigin: "COMMENT",
      evidenceSpans: [
        {
          origin: "COMMENT",
          start: 0,
          end: 30,
          text: "Caching reduces repeated work.",
        },
      ],
      relatedSubjectNames: ["caching"],
      qualifiers: [],
    },
    reviewFlags: [],
    rejectionReason: null,
    annotator: { id: "A", method: "independent-bounded-review" },
  },
  {
    schemaVersion: "annotation-pass.v2",
    cycleId: "v2",
    commentId: 103,
    materialRelevance: "NOT_MATERIAL",
    primaryClass: "REJECTED",
    discoveries: [],
    expertNote: null,
    reviewFlags: [],
    rejectionReason: "LOW_INFORMATION",
    annotator: { id: "A", method: "independent-bounded-review" },
  },
];

const validPassRowsForB = (): unknown[] => {
  const rows = structuredClone(validPassRows());
  for (const value of rows) {
    const row = value as Record<string, unknown>;
    const annotator = row["annotator"] as Record<string, unknown>;
    annotator["id"] = "B";
  }
  return rows;
};

describe("evaluation annotation packets", () => {
  it("publishes the separate materiality and primary-class schema", async () => {
    const schema = JSON.parse(
      await readFile("evaluation/annotation-pass-schema-v2.json", "utf8"),
    ) as {
      readonly properties: {
        readonly schemaVersion: { readonly const: string };
        readonly materialRelevance: { readonly enum: readonly string[] };
        readonly primaryClass: { readonly enum: readonly string[] };
      };
      readonly $defs: {
        readonly annotator: {
          readonly properties: { readonly method: { readonly const: string } };
        };
      };
    };

    expect(schema.properties).toMatchObject({
      schemaVersion: { const: "annotation-pass.v2" },
      materialRelevance: {
        enum: ["MATERIAL", "NOT_MATERIAL", "UNCERTAIN"],
      },
      primaryClass: {
        enum: ["DISCOVERY", "EXPERT_NOTE", "REJECTED"],
      },
    });
    expect(schema.$defs.annotator.properties.method.const).toBe(
      "independent-bounded-review",
    );
  });

  it("creates deterministic, separately ordered blind packets", () => {
    const annotatorA = prepareEvaluationAnnotationPacket({
      cycleId: "v2",
      annotatorId: "A",
      documents,
      expectedCommentIds,
    });
    const repeatedA = prepareEvaluationAnnotationPacket({
      cycleId: "v2",
      annotatorId: "A",
      documents,
      expectedCommentIds,
    });
    const annotatorB = prepareEvaluationAnnotationPacket({
      cycleId: "v2",
      annotatorId: "B",
      documents,
      expectedCommentIds,
    });

    expect(annotatorA).toEqual(repeatedA);
    expect(annotatorA.map((row) => row.commentId)).not.toEqual(
      annotatorB.map((row) => row.commentId),
    );
    expect(new Set(annotatorA.map((row) => row.commentId))).toEqual(
      new Set(expectedCommentIds),
    );
    const serialized = serializeEvaluationAnnotationPacket(annotatorA);
    expect(serialized).not.toContain('"holdout"');
    expect(serialized).not.toContain('"prediction"');
    expect(serialized).not.toContain('"rootId"');
  });

  it("validates complete passes with separate material relevance", () => {
    const summary = validateEvaluationAnnotationPass({
      cycleId: "v2",
      annotatorId: "A",
      documents,
      expectedCommentIds,
      rows: validPassRows(),
    });

    expect(summary).toEqual({
      rows: 3,
      uniqueCommentIds: 3,
      materialRelevance: {
        MATERIAL: 2,
        NOT_MATERIAL: 1,
        UNCERTAIN: 0,
      },
      primaryClass: { DISCOVERY: 1, EXPERT_NOTE: 1, REJECTED: 1 },
      reviewRows: 0,
    });
  });

  it("compares aligned independent passes with separate kappa gates", () => {
    const annotatorA = parseEvaluationAnnotationPass({
      cycleId: "v2",
      annotatorId: "A",
      documents,
      expectedCommentIds,
      rows: validPassRows(),
    });
    const annotatorB = parseEvaluationAnnotationPass({
      cycleId: "v2",
      annotatorId: "B",
      documents,
      expectedCommentIds,
      rows: validPassRowsForB(),
    });
    const comparison = compareEvaluationAnnotationPasses({
      annotatorA,
      annotatorB,
    });

    expect(comparison).toMatchObject({
      rows: 3,
      exactDecisionAgreementRows: 3,
      primaryClassKappa: 1,
      materialRelevanceKappa: 1,
      passed: true,
      disagreements: [],
    });
    expect(serializeEvaluationAdjudicationPacket(comparison, documents)).toBe(
      "",
    );
  });

  it("fails either kappa gate and serializes only decision disagreements", () => {
    const bRows = validPassRowsForB();
    const rejected = bRows[2] as Record<string, unknown>;
    rejected["materialRelevance"] = "UNCERTAIN";
    rejected["reviewFlags"] = ["AMBIGUOUS_CLASSIFICATION"];
    const annotatorA = parseEvaluationAnnotationPass({
      cycleId: "v2",
      annotatorId: "A",
      documents,
      expectedCommentIds,
      rows: validPassRows(),
    });
    const annotatorB = parseEvaluationAnnotationPass({
      cycleId: "v2",
      annotatorId: "B",
      documents,
      expectedCommentIds,
      rows: bRows,
    });
    const comparison = compareEvaluationAnnotationPasses({
      annotatorA,
      annotatorB,
    });
    const packet = serializeEvaluationAdjudicationPacket(comparison, documents);

    expect(comparison.primaryClassKappa).toBe(1);
    expect(comparison.materialRelevanceKappa).toBeLessThan(
      MINIMUM_ANNOTATION_COHENS_KAPPA,
    );
    expect(comparison).toMatchObject({
      exactDecisionAgreementRows: 2,
      passed: false,
    });
    expect(comparison.disagreements).toHaveLength(1);
    expect(packet.trim().split("\n")).toHaveLength(1);
    expect(packet).toContain(
      '"schemaVersion":"annotation-adjudication-packet.v1"',
    );
    expect(packet).toContain('"source":{"comment"');
    expect(packet).not.toContain('"holdout"');
  });

  it("rejects evidence that does not reproduce the frozen source", () => {
    const rows = structuredClone(validPassRows());
    const first = rows[0] as Record<string, unknown>;
    const discoveries = first["discoveries"] as Record<string, unknown>[];
    const spans = discoveries[0]?.["evidenceSpans"] as Record<
      string,
      unknown
    >[];
    if (spans[0] !== undefined) {
      spans[0]["text"] = "Different text";
    }

    expect(() =>
      validateEvaluationAnnotationPass({
        cycleId: "v2",
        annotatorId: "A",
        documents,
        expectedCommentIds,
        rows,
      }),
    ).toThrow(/does not reproduce the frozen source/u);
  });

  it("rejects invented URLs and inconsistent materiality", () => {
    const invented = structuredClone(validPassRows());
    const first = invented[0] as Record<string, unknown>;
    const discoveries = first["discoveries"] as Record<string, unknown>[];
    if (discoveries[0] !== undefined) {
      discoveries[0]["urlCandidateIds"] = ["url:9"];
    }
    expect(() =>
      validateEvaluationAnnotationPass({
        cycleId: "v2",
        annotatorId: "A",
        documents,
        expectedCommentIds,
        rows: invented,
      }),
    ).toThrow(/unknown candidate/u);

    const rawUrl = structuredClone(validPassRows());
    const rawUrlFirst = rawUrl[0] as Record<string, unknown>;
    const rawUrlDiscoveries = rawUrlFirst["discoveries"] as Record<
      string,
      unknown
    >[];
    if (rawUrlDiscoveries[0] !== undefined) {
      rawUrlDiscoveries[0]["description"] =
        "See https://invented.example for details.";
    }
    expect(() =>
      validateEvaluationAnnotationPass({
        cycleId: "v2",
        annotatorId: "A",
        documents,
        expectedCommentIds,
        rows: rawUrl,
      }),
    ).toThrow(/opaque URL candidate IDs/u);

    const inconsistent = structuredClone(validPassRows());
    const rejected = inconsistent[2] as Record<string, unknown>;
    rejected["materialRelevance"] = "MATERIAL";
    expect(() =>
      validateEvaluationAnnotationPass({
        cycleId: "v2",
        annotatorId: "A",
        documents,
        expectedCommentIds,
        rows: inconsistent,
      }),
    ).toThrow(/conflicts with primaryClass/u);
  });

  it("requires uncertain rows to be explicitly reviewable", () => {
    const rows = structuredClone(validPassRows());
    const rejected = rows[2] as Record<string, unknown>;
    rejected["materialRelevance"] = "UNCERTAIN";

    expect(() =>
      validateEvaluationAnnotationPass({
        cycleId: "v2",
        annotatorId: "A",
        documents,
        expectedCommentIds,
        rows,
      }),
    ).toThrow(/requires AMBIGUOUS_CLASSIFICATION/u);
  });

  it("routes root-only and unlinked discoveries to review", () => {
    const rootOnlyRows = structuredClone(validPassRows());
    const first = rootOnlyRows[0] as Record<string, unknown>;
    const discoveries = first["discoveries"] as Record<string, unknown>[];
    const discovery = discoveries[0];
    if (discovery !== undefined) {
      discovery["evidenceOrigin"] = "ROOT_STORY";
      discovery["evidenceSpans"] = [
        {
          origin: "ROOT_STORY",
          start: 0,
          end: 7,
          text: "Toolbox",
        },
      ];
      discovery["rootOnly"] = true;
    }
    expect(() =>
      validateEvaluationAnnotationPass({
        cycleId: "v2",
        annotatorId: "A",
        documents,
        expectedCommentIds,
        rows: rootOnlyRows,
      }),
    ).toThrow(/require ROOT_ONLY_DISCOVERY/u);

    const missingUrlRows = structuredClone(validPassRows());
    const missingUrlFirst = missingUrlRows[0] as Record<string, unknown>;
    const missingUrlDiscoveries = missingUrlFirst["discoveries"] as Record<
      string,
      unknown
    >[];
    if (missingUrlDiscoveries[0] !== undefined) {
      missingUrlDiscoveries[0]["urlCandidateIds"] = [];
    }
    expect(() =>
      validateEvaluationAnnotationPass({
        cycleId: "v2",
        annotatorId: "A",
        documents,
        expectedCommentIds,
        rows: missingUrlRows,
      }),
    ).toThrow(/require MISSING_CANONICAL_URL/u);
  });

  it("requires every frozen ID exactly once and the expected annotator", () => {
    expect(() =>
      validateEvaluationAnnotationPass({
        cycleId: "v2",
        annotatorId: "A",
        documents,
        expectedCommentIds,
        rows: validPassRows().slice(0, 2),
      }),
    ).toThrow(/every frozen comment exactly once/u);

    const rows = structuredClone(validPassRows());
    const first = rows[0] as Record<string, unknown>;
    const annotator = first["annotator"] as Record<string, unknown>;
    annotator["id"] = "B";
    expect(() =>
      validateEvaluationAnnotationPass({
        cycleId: "v2",
        annotatorId: "A",
        documents,
        expectedCommentIds,
        rows,
      }),
    ).toThrow(/annotator.id must be A/u);
  });
});
