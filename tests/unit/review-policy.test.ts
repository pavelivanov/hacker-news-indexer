import { describe, expect, it } from "vitest";

import {
  evaluateReviewPolicy,
  REVIEW_REASON_CODES,
  UNPROMOTED_MODEL_REVIEW_DECISION,
  type ReviewPolicyInput,
  type ReviewReasonCode,
} from "@hn-knowledge/domain";

const safeInput: ReviewPolicyInput = {
  decisionSource: "MANUAL",
  providerPromoted: true,
  findThatProjectCandidate: false,
  canonicalUrlState: "PRESENT",
  mergeBasis: "NONE",
  rootOnlyDiscovery: false,
  recommendationRisk: "NONE",
  destructiveOrEvasionAdvice: false,
  lowConfidence: false,
  promptInjection: false,
  contentState: "AVAILABLE",
  telegramHnDivergence: false,
  conflictingEvidenceOrigin: false,
  ambiguousClassification: false,
};

const cases: readonly {
  readonly reason: ReviewReasonCode;
  readonly input: Partial<ReviewPolicyInput>;
}[] = [
  { reason: "PROMPT_INJECTION", input: { promptInjection: true } },
  {
    reason: "DESTRUCTIVE_OR_EVASION_ADVICE",
    input: { destructiveOrEvasionAdvice: true },
  },
  {
    reason: "DELETED_OR_FLAGGED_CONTENT",
    input: { contentState: "DELETED" },
  },
  {
    reason: "SECURITY_RECOMMENDATION",
    input: { recommendationRisk: "SECURITY" },
  },
  {
    reason: "MEDICAL_RECOMMENDATION",
    input: { recommendationRisk: "MEDICAL" },
  },
  {
    reason: "LEGAL_RECOMMENDATION",
    input: { recommendationRisk: "LEGAL" },
  },
  {
    reason: "TELEGRAM_HN_DIVERGENCE",
    input: { telegramHnDivergence: true },
  },
  {
    reason: "CONFLICTING_EVIDENCE_ORIGIN",
    input: { conflictingEvidenceOrigin: true },
  },
  {
    reason: "FINDTHATPROJECT_INITIAL_ROLLOUT",
    input: { findThatProjectCandidate: true },
  },
  {
    reason: "NAME_ONLY_MERGE_SUGGESTION",
    input: { mergeBasis: "NAME_ONLY" },
  },
  {
    reason: "AMBIGUOUS_CANONICAL_URL",
    input: { canonicalUrlState: "AMBIGUOUS" },
  },
  {
    reason: "MISSING_CANONICAL_URL",
    input: { canonicalUrlState: "MISSING" },
  },
  { reason: "ROOT_ONLY_DISCOVERY", input: { rootOnlyDiscovery: true } },
  { reason: "LOW_CONFIDENCE", input: { lowConfidence: true } },
  {
    reason: "AMBIGUOUS_CLASSIFICATION",
    input: { ambiguousClassification: true },
  },
  {
    reason: "UNPROMOTED_MODEL_DECISION",
    input: { decisionSource: "MODEL", providerPromoted: false },
  },
];

describe("mandatory review policy", () => {
  it("allows a safe manual decision without review", () => {
    expect(evaluateReviewPolicy(safeInput)).toEqual({
      required: false,
      reasons: [],
      priority: "NONE",
      priorityScore: 0,
    });
  });

  it("keeps the current model workflow in mandatory review", () => {
    expect(UNPROMOTED_MODEL_REVIEW_DECISION).toEqual({
      required: true,
      reasons: ["UNPROMOTED_MODEL_DECISION"],
      priority: "LOW",
      priorityScore: 25,
    });
  });

  it.each(cases)("requires review for $reason", ({ reason, input }) => {
    const decision = evaluateReviewPolicy({ ...safeInput, ...input });

    expect(decision.required).toBe(true);
    expect(decision.reasons).toContain(reason);
  });

  it("covers every stable reason code", () => {
    expect(new Set(cases.map(({ reason }) => reason))).toEqual(
      new Set(REVIEW_REASON_CODES),
    );
  });

  it("orders combined reasons deterministically by priority", () => {
    expect(
      evaluateReviewPolicy({
        ...safeInput,
        decisionSource: "MODEL",
        providerPromoted: false,
        promptInjection: true,
        recommendationRisk: "SECURITY",
        canonicalUrlState: "MISSING",
        lowConfidence: true,
      }),
    ).toEqual({
      required: true,
      reasons: [
        "PROMPT_INJECTION",
        "SECURITY_RECOMMENDATION",
        "MISSING_CANONICAL_URL",
        "LOW_CONFIDENCE",
        "UNPROMOTED_MODEL_DECISION",
      ],
      priority: "CRITICAL",
      priorityScore: 100,
    });
  });

  it("treats flagged content the same as deleted content", () => {
    expect(
      evaluateReviewPolicy({ ...safeInput, contentState: "FLAGGED" }).reasons,
    ).toEqual(["DELETED_OR_FLAGGED_CONTENT"]);
  });
});
