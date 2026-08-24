import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  ClassificationV1Schema,
  isClassificationV1,
  validateClassificationV1,
  type ClassificationV1,
} from "@hn-knowledge/contracts";

const note = (): NonNullable<ClassificationV1["expert_note"]> => ({
  note_type: "IMPLEMENTATION_CAVEAT",
  title: "A bounded caveat",
  summary: "The supplied implementation has a material constraint.",
  evidence_origin: "COMMENT",
  evidence_span_ids: ["span:0"],
  related_subject_names: ["Example"],
  qualifiers: ["Version dependent"],
  confidence: 0.9,
});

const discovery = (): ClassificationV1["discoveries"][number] => ({
  subject_type: "PROJECT",
  name: "Example",
  aliases: [],
  description_claim: "Example is a supplied project.",
  evidence_origin: "COMMENT",
  evidence_span_ids: ["span:0"],
  url_candidate_ids: ["url:0"],
  url_grounding: "GROUNDED",
  root_story_only: false,
  confidence: 0.95,
});

const base = (): ClassificationV1 => ({
  schema_version: "classification.v1",
  primary_decision: "REJECTED",
  decision_confidence: 0.8,
  comment_relevance: {
    is_materially_technical: false,
    reason: "No reusable technical content.",
    evidence_span_ids: [],
  },
  rejection_reasons: ["GENERIC_OPINION"],
  discoveries: [],
  expert_note: null,
  review: { required: false, reasons: [] },
});

describe("classification.v1 contract", () => {
  it("accepts canonical results for every primary class", () => {
    const rejected = base();
    const expert: ClassificationV1 = {
      ...base(),
      primary_decision: "EXPERT_NOTE",
      comment_relevance: {
        is_materially_technical: true,
        reason: "Contains a reusable implementation caveat.",
        evidence_span_ids: ["span:0"],
      },
      rejection_reasons: [],
      expert_note: note(),
    };
    const discovered: ClassificationV1 = {
      ...expert,
      primary_decision: "DISCOVERY",
      discoveries: [discovery()],
      expert_note: null,
    };
    const review: ClassificationV1 = {
      ...base(),
      primary_decision: "REVIEW",
      rejection_reasons: [],
      review: { required: true, reasons: ["AMBIGUOUS_CLASSIFICATION"] },
    };

    for (const result of [rejected, expert, discovered, review]) {
      expect(validateClassificationV1(result)).toMatchObject({ ok: true });
    }
  });

  it.each([
    ["unknown root field", { ...base(), unexpected: true }],
    ["unknown enum", { ...base(), primary_decision: "MAYBE" }],
    ["NaN confidence", { ...base(), decision_confidence: Number.NaN }],
    [
      "excess reason length",
      {
        ...base(),
        comment_relevance: {
          ...base().comment_relevance,
          reason: "x".repeat(501),
        },
      },
    ],
    [
      "excess discovery count",
      {
        ...base(),
        primary_decision: "DISCOVERY",
        rejection_reasons: [],
        discoveries: Array.from({ length: 6 }, discovery),
      },
    ],
  ])("rejects %s", (_name, result) => {
    expect(isClassificationV1(result)).toBe(false);
  });

  it("rejects primary-decision content mismatches", () => {
    expect(
      validateClassificationV1({
        ...base(),
        discoveries: [discovery()],
      }),
    ).toEqual({ ok: false, code: "PRIMARY_DECISION_CONTENT_MISMATCH" });
  });

  it("rejects inconsistent URL grounding and root-only state", () => {
    const result: ClassificationV1 = {
      ...base(),
      primary_decision: "DISCOVERY",
      rejection_reasons: [],
      discoveries: [
        {
          ...discovery(),
          url_candidate_ids: [],
          root_story_only: true,
        },
      ],
    };

    expect(validateClassificationV1(result)).toEqual({
      ok: false,
      code: "URL_GROUNDING_MISMATCH",
    });
  });

  it("keeps the generated provider schema byte-equivalent to its source", async () => {
    const generated = JSON.parse(
      await readFile(
        new URL(
          "../../../packages/contracts/src/generated/classification-v1.schema.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as unknown;

    expect(generated).toEqual(ClassificationV1Schema);
  });
});
