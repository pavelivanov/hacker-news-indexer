import { describe, expect, it } from "vitest";

import {
  calculateClassificationMetrics,
  calculateExtractionMetrics,
  type EvaluationConfusionMatrix,
} from "@hn-knowledge/application";

describe("evaluation metrics", () => {
  it("reports abstention separately from classified quality", () => {
    const matrix: EvaluationConfusionMatrix = {
      DISCOVERY: {
        DISCOVERY: 2,
        EXPERT_NOTE: 0,
        REJECTED: 0,
        REVIEW: 1,
        INVALID: 0,
      },
      EXPERT_NOTE: {
        DISCOVERY: 0,
        EXPERT_NOTE: 2,
        REJECTED: 0,
        REVIEW: 0,
        INVALID: 1,
      },
      REJECTED: {
        DISCOVERY: 0,
        EXPERT_NOTE: 1,
        REJECTED: 2,
        REVIEW: 0,
        INVALID: 0,
      },
    };

    const metrics = calculateClassificationMetrics(matrix);

    expect(metrics).toMatchObject({
      classifiedRows: 7,
      abstainedRows: 2,
      classificationCoverage: 7 / 9,
      classifiedAccuracy: 6 / 7,
    });
    expect(metrics.macroF1).toBeCloseTo(13 / 15);
    expect(metrics.overallMacroF1).toBeLessThan(metrics.macroF1);
  });

  it("matches discoveries by supported names instead of array position", () => {
    const metrics = calculateExtractionMetrics([
      {
        expectedDiscoveries: [
          {
            subjectType: "PROJECT",
            name: "Alpha",
            aliases: ["Alpha Project"],
            evidenceOrigin: "COMMENT",
            urlCandidateIds: ["url:0"],
          },
          {
            subjectType: "LIBRARY",
            name: "Beta",
            aliases: [],
            evidenceOrigin: "BOTH",
            urlCandidateIds: ["url:1"],
          },
        ],
        predictedDiscoveries: [
          {
            subjectType: "LIBRARY",
            name: "Beta",
            aliases: [],
            evidenceOrigin: "BOTH",
            urlCandidateIds: ["url:1"],
          },
          {
            subjectType: "PROJECT",
            name: "Alpha Project",
            aliases: [],
            evidenceOrigin: "COMMENT",
            urlCandidateIds: ["url:0"],
          },
          {
            subjectType: "TOOL",
            name: "Gamma",
            aliases: [],
            evidenceOrigin: "COMMENT",
            urlCandidateIds: ["url:2"],
          },
        ],
        expectedExpertNoteOrigin: "COMMENT",
        predictedExpertNoteOrigin: "COMMENT",
      },
    ]);

    expect(metrics).toMatchObject({
      expectedDiscoveries: 2,
      predictedDiscoveries: 3,
      matchedDiscoveries: 2,
      discoveryExtractionPrecision: 2 / 3,
      discoveryExtractionRecall: 1,
      goldEvidenceOriginAgreement: 1,
      goldEvidenceOriginCoverage: 1,
      urlGroundingPrecision: 2 / 3,
      urlGroundingRecall: 1,
    });
  });

  it("does not claim perfect origin accuracy when nothing was matched", () => {
    const metrics = calculateExtractionMetrics([
      {
        expectedDiscoveries: [],
        predictedDiscoveries: [],
        expectedExpertNoteOrigin: "COMMENT",
        predictedExpertNoteOrigin: null,
      },
    ]);

    expect(metrics.goldEvidenceOriginAgreement).toBe(0);
    expect(metrics.goldEvidenceOriginCoverage).toBe(0);
  });
});
