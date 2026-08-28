import { describe, expect, it } from "vitest";

import {
  CLASSIFICATION_DECISION_ROUTER_VERSION,
  CLASSIFICATION_PROMPT_VERSION,
  CLASSIFICATION_SYSTEM_PROMPT,
  MINIMUM_AUTOMATIC_CLASSIFICATION_CONFIDENCE,
  routeClassificationDecision,
} from "@hn-knowledge/application";
import {
  validateClassificationV1,
  type ClassificationV1,
} from "@hn-knowledge/contracts";

const rejected = (): ClassificationV1 => ({
  schema_version: "classification.v1",
  primary_decision: "REJECTED",
  decision_confidence: 0.99,
  comment_relevance: {
    is_materially_technical: false,
    reason: "The comment has no reusable technical content.",
    evidence_span_ids: [],
  },
  rejection_reasons: ["GENERIC_OPINION"],
  discoveries: [],
  expert_note: null,
  review: { required: false, reasons: [] },
});

const discovery = (): ClassificationV1 => ({
  ...rejected(),
  primary_decision: "DISCOVERY",
  comment_relevance: {
    is_materially_technical: true,
    reason: "The selected comment materially identifies Example.",
    evidence_span_ids: ["span:0"],
  },
  rejection_reasons: [],
  discoveries: [
    {
      subject_type: "PROJECT",
      name: "Example",
      aliases: [],
      description_claim: "A bounded technical project.",
      evidence_origin: "COMMENT",
      evidence_span_ids: ["span:0"],
      url_candidate_ids: ["url:0"],
      url_grounding: "GROUNDED",
      root_story_only: false,
      confidence: 0.99,
    },
  ],
});

const expertNote = (): ClassificationV1 => ({
  ...rejected(),
  primary_decision: "EXPERT_NOTE",
  comment_relevance: {
    is_materially_technical: true,
    reason: "The selected comment contains a reusable explanation.",
    evidence_span_ids: ["span:0"],
  },
  rejection_reasons: [],
  expert_note: {
    note_type: "TECHNICAL_EXPLANATION",
    title: "A bounded explanation",
    summary: "The comment explains a reusable technical mechanism.",
    evidence_origin: "COMMENT",
    evidence_span_ids: ["span:0"],
    related_subject_names: ["Example"],
    qualifiers: [],
    confidence: 0.99,
  },
});

const contradictionCases: readonly (readonly [string, ClassificationV1])[] = [
  [
    "a non-material Discovery",
    {
      ...discovery(),
      comment_relevance: {
        is_materially_technical: false,
        reason: "The materiality signal conflicts with the retained class.",
        evidence_span_ids: ["span:2"],
      },
    },
  ],
  [
    "a material rejection",
    {
      ...rejected(),
      comment_relevance: {
        is_materially_technical: true,
        reason: "The materiality signal conflicts with rejection.",
        evidence_span_ids: ["span:2"],
      },
    },
  ],
];

describe("two-stage classification decision router", () => {
  it.each([
    ["material Discovery", discovery(), "MATERIAL", "DISCOVERY"],
    ["material Expert note", expertNote(), "MATERIAL", "EXPERT_NOTE"],
    ["non-material rejection", rejected(), "NOT_MATERIAL", "NOT_RUN"],
  ] as const)(
    "routes a %s through the expected stages",
    (_name, output, a, b) => {
      const route = routeClassificationDecision(output);

      expect(route).toMatchObject({
        version: CLASSIFICATION_DECISION_ROUTER_VERSION,
        stageA: a,
        stageB: b,
        primaryDecision: output.primary_decision,
        materiallyTechnical: output.comment_relevance.is_materially_technical,
        reviewReasons: [],
      });
      expect(route.output).toEqual(output);
      expect(validateClassificationV1(route.output)).toMatchObject({
        ok: true,
      });
    },
  );

  it.each(contradictionCases)(
    "normalizes %s to a bounded review",
    (_name, output) => {
      const route = routeClassificationDecision(output);

      expect(route).toMatchObject({
        stageA: "REVIEW",
        stageB: "NOT_RUN",
        primaryDecision: "REVIEW",
        materiallyTechnical: false,
        reviewReasons: ["AMBIGUOUS_CLASSIFICATION"],
        evidenceSpanIds: ["span:2"],
        output: {
          primary_decision: "REVIEW",
          comment_relevance: { is_materially_technical: false },
          rejection_reasons: [],
          discoveries: [],
          expert_note: null,
          review: {
            required: true,
            reasons: ["AMBIGUOUS_CLASSIFICATION"],
          },
        },
      });
      expect(validateClassificationV1(route.output)).toMatchObject({
        ok: true,
      });
    },
  );

  it("derives structural and confidence review reasons in application code", () => {
    const output = discovery();
    const first = output.discoveries[0];
    if (first === undefined) {
      throw new Error("Expected a discovery fixture");
    }
    const route = routeClassificationDecision({
      ...output,
      decision_confidence: MINIMUM_AUTOMATIC_CLASSIFICATION_CONFIDENCE - 0.01,
      discoveries: [
        {
          ...first,
          evidence_origin: "ROOT_STORY",
          evidence_span_ids: ["span:1"],
          url_candidate_ids: [],
          url_grounding: "NONE",
          root_story_only: true,
        },
        {
          ...first,
          name: "Example feature",
          evidence_span_ids: ["span:2"],
          url_candidate_ids: ["url:1", "url:2"],
        },
      ],
    });

    expect(route.reviewReasons).toEqual([
      "MISSING_CANONICAL_URL",
      "AMBIGUOUS_CANONICAL_URL",
      "ROOT_ONLY_DISCOVERY",
      "LOW_CONFIDENCE",
    ]);
    expect(route.output.review).toEqual({
      required: true,
      reasons: route.reviewReasons,
    });
  });

  it("preserves model risk flags only as additional review signals", () => {
    const route = routeClassificationDecision({
      ...expertNote(),
      review: {
        required: true,
        reasons: ["SECURITY_RECOMMENDATION"],
      },
    });

    expect(route).toMatchObject({
      stageA: "MATERIAL",
      stageB: "EXPERT_NOTE",
      primaryDecision: "EXPERT_NOTE",
      reviewReasons: ["SECURITY_RECOMMENDATION"],
      output: {
        review: {
          required: true,
          reasons: ["SECURITY_RECOMMENDATION"],
        },
      },
    });
  });

  it("versions and explains the two-stage compatibility set", () => {
    expect(CLASSIFICATION_PROMPT_VERSION).toBe("classification-prompt.v4");
    expect(CLASSIFICATION_SYSTEM_PROMPT).toContain("Stage A");
    expect(CLASSIFICATION_SYSTEM_PROMPT).toContain("Stage B");
    expect(CLASSIFICATION_SYSTEM_PROMPT).toContain(
      "Stage B — retained class and extraction: run only when Stage A is materially technical",
    );
  });
});
