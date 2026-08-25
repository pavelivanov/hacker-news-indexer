export const REVIEW_REASON_CODES = [
  "PROMPT_INJECTION",
  "DESTRUCTIVE_OR_EVASION_ADVICE",
  "DELETED_OR_FLAGGED_CONTENT",
  "SECURITY_RECOMMENDATION",
  "MEDICAL_RECOMMENDATION",
  "LEGAL_RECOMMENDATION",
  "TELEGRAM_HN_DIVERGENCE",
  "CONFLICTING_EVIDENCE_ORIGIN",
  "FINDTHATPROJECT_INITIAL_ROLLOUT",
  "NAME_ONLY_MERGE_SUGGESTION",
  "AMBIGUOUS_CANONICAL_URL",
  "MISSING_CANONICAL_URL",
  "ROOT_ONLY_DISCOVERY",
  "LOW_CONFIDENCE",
  "AMBIGUOUS_CLASSIFICATION",
  "UNPROMOTED_MODEL_DECISION",
] as const;

export type ReviewReasonCode = (typeof REVIEW_REASON_CODES)[number];

export const REVIEW_PRIORITIES = [
  "NONE",
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
] as const;
export type ReviewPriority = (typeof REVIEW_PRIORITIES)[number];

export interface ReviewPolicyInput {
  readonly decisionSource: "MODEL" | "MANUAL";
  readonly providerPromoted: boolean;
  readonly findThatProjectCandidate: boolean;
  readonly canonicalUrlState: "PRESENT" | "MISSING" | "AMBIGUOUS";
  readonly mergeBasis: "NONE" | "VERIFIED" | "NAME_ONLY";
  readonly rootOnlyDiscovery: boolean;
  readonly recommendationRisk: "NONE" | "LEGAL" | "MEDICAL" | "SECURITY";
  readonly destructiveOrEvasionAdvice: boolean;
  readonly lowConfidence: boolean;
  readonly promptInjection: boolean;
  readonly contentState: "AVAILABLE" | "DELETED" | "FLAGGED";
  readonly telegramHnDivergence: boolean;
  readonly conflictingEvidenceOrigin: boolean;
  readonly ambiguousClassification: boolean;
}

export interface ReviewPolicyDecision {
  readonly required: boolean;
  readonly reasons: readonly ReviewReasonCode[];
  readonly priority: ReviewPriority;
  readonly priorityScore: number;
}

const SCORES: Readonly<Record<ReviewReasonCode, number>> = {
  PROMPT_INJECTION: 100,
  DESTRUCTIVE_OR_EVASION_ADVICE: 95,
  DELETED_OR_FLAGGED_CONTENT: 90,
  SECURITY_RECOMMENDATION: 85,
  MEDICAL_RECOMMENDATION: 80,
  LEGAL_RECOMMENDATION: 75,
  TELEGRAM_HN_DIVERGENCE: 70,
  CONFLICTING_EVIDENCE_ORIGIN: 65,
  FINDTHATPROJECT_INITIAL_ROLLOUT: 60,
  NAME_ONLY_MERGE_SUGGESTION: 55,
  AMBIGUOUS_CANONICAL_URL: 50,
  MISSING_CANONICAL_URL: 45,
  ROOT_ONLY_DISCOVERY: 40,
  LOW_CONFIDENCE: 35,
  AMBIGUOUS_CLASSIFICATION: 30,
  UNPROMOTED_MODEL_DECISION: 25,
};

const priorityFor = (score: number): ReviewPriority => {
  if (score >= 90) {
    return "CRITICAL";
  }
  if (score >= 65) {
    return "HIGH";
  }
  if (score >= 40) {
    return "MEDIUM";
  }
  return score > 0 ? "LOW" : "NONE";
};

export const evaluateReviewPolicy = (
  input: ReviewPolicyInput,
): ReviewPolicyDecision => {
  const reasons = new Set<ReviewReasonCode>();
  if (input.promptInjection) {
    reasons.add("PROMPT_INJECTION");
  }
  if (input.destructiveOrEvasionAdvice) {
    reasons.add("DESTRUCTIVE_OR_EVASION_ADVICE");
  }
  if (input.contentState !== "AVAILABLE") {
    reasons.add("DELETED_OR_FLAGGED_CONTENT");
  }
  if (input.recommendationRisk !== "NONE") {
    reasons.add(`${input.recommendationRisk}_RECOMMENDATION`);
  }
  if (input.telegramHnDivergence) {
    reasons.add("TELEGRAM_HN_DIVERGENCE");
  }
  if (input.conflictingEvidenceOrigin) {
    reasons.add("CONFLICTING_EVIDENCE_ORIGIN");
  }
  if (input.findThatProjectCandidate) {
    reasons.add("FINDTHATPROJECT_INITIAL_ROLLOUT");
  }
  if (input.mergeBasis === "NAME_ONLY") {
    reasons.add("NAME_ONLY_MERGE_SUGGESTION");
  }
  if (input.canonicalUrlState === "AMBIGUOUS") {
    reasons.add("AMBIGUOUS_CANONICAL_URL");
  } else if (input.canonicalUrlState === "MISSING") {
    reasons.add("MISSING_CANONICAL_URL");
  }
  if (input.rootOnlyDiscovery) {
    reasons.add("ROOT_ONLY_DISCOVERY");
  }
  if (input.lowConfidence) {
    reasons.add("LOW_CONFIDENCE");
  }
  if (input.ambiguousClassification) {
    reasons.add("AMBIGUOUS_CLASSIFICATION");
  }
  if (input.decisionSource === "MODEL" && !input.providerPromoted) {
    reasons.add("UNPROMOTED_MODEL_DECISION");
  }

  const orderedReasons = REVIEW_REASON_CODES.filter((reason) =>
    reasons.has(reason),
  );
  const priorityScore = Math.max(
    0,
    ...orderedReasons.map((reason) => SCORES[reason]),
  );
  return {
    required: orderedReasons.length > 0,
    reasons: orderedReasons,
    priority: priorityFor(priorityScore),
    priorityScore,
  };
};

export const UNPROMOTED_MODEL_REVIEW_DECISION = evaluateReviewPolicy({
  decisionSource: "MODEL",
  providerPromoted: false,
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
});
