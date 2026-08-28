import type { ClassificationV1 } from "@hn-knowledge/contracts";

export const CLASSIFICATION_DECISION_ROUTER_VERSION = "decision-router.v1";
export const MINIMUM_AUTOMATIC_CLASSIFICATION_CONFIDENCE = 0.95;

export type ClassificationStageADecision =
  "MATERIAL" | "NOT_MATERIAL" | "REVIEW";
export type ClassificationStageBDecision =
  "DISCOVERY" | "EXPERT_NOTE" | "NOT_RUN";

type ClassificationReviewReason = ClassificationV1["review"]["reasons"][number];

export interface ClassificationDecisionRoute {
  readonly version: typeof CLASSIFICATION_DECISION_ROUTER_VERSION;
  readonly stageA: ClassificationStageADecision;
  readonly stageB: ClassificationStageBDecision;
  readonly primaryDecision: ClassificationV1["primary_decision"];
  readonly materiallyTechnical: boolean;
  readonly reviewReasons: readonly ClassificationReviewReason[];
  readonly evidenceSpanIds: readonly string[];
  readonly output: ClassificationV1;
}

const REVIEW_REASON_ORDER = [
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
] as const satisfies readonly ClassificationReviewReason[];

const stageAFor = (output: ClassificationV1): ClassificationStageADecision => {
  if (
    output.comment_relevance.is_materially_technical &&
    (output.primary_decision === "DISCOVERY" ||
      output.primary_decision === "EXPERT_NOTE")
  ) {
    return "MATERIAL";
  }
  if (
    !output.comment_relevance.is_materially_technical &&
    output.primary_decision === "REJECTED"
  ) {
    return "NOT_MATERIAL";
  }
  return "REVIEW";
};

const stageBFor = (
  output: ClassificationV1,
  stageA: ClassificationStageADecision,
): ClassificationStageBDecision => {
  if (stageA !== "MATERIAL") {
    return "NOT_RUN";
  }
  return output.primary_decision === "DISCOVERY" ? "DISCOVERY" : "EXPERT_NOTE";
};

const hasLowConfidence = (
  output: ClassificationV1,
  stageA: ClassificationStageADecision,
  stageB: ClassificationStageBDecision,
): boolean => {
  const retainedConfidence = [output.decision_confidence];
  if (stageA === "MATERIAL" && stageB === "DISCOVERY") {
    retainedConfidence.push(
      ...output.discoveries.map((discovery) => discovery.confidence),
    );
    if (output.expert_note !== null) {
      retainedConfidence.push(output.expert_note.confidence);
    }
  } else if (
    stageA === "MATERIAL" &&
    stageB === "EXPERT_NOTE" &&
    output.expert_note !== null
  ) {
    retainedConfidence.push(output.expert_note.confidence);
  }
  return retainedConfidence.some(
    (confidence) => confidence < MINIMUM_AUTOMATIC_CLASSIFICATION_CONFIDENCE,
  );
};

const evidenceSpanIdsFor = (output: ClassificationV1): string[] => [
  ...new Set([
    ...output.comment_relevance.evidence_span_ids,
    ...output.discoveries.flatMap((discovery) => discovery.evidence_span_ids),
    ...(output.expert_note?.evidence_span_ids ?? []),
  ]),
];

export const routeClassificationDecision = (
  providerOutput: ClassificationV1,
): ClassificationDecisionRoute => {
  const stageA = stageAFor(providerOutput);
  const stageB = stageBFor(providerOutput, stageA);
  const reasons = new Set<ClassificationReviewReason>(
    providerOutput.review.reasons,
  );
  if (stageA === "REVIEW") {
    reasons.add("AMBIGUOUS_CLASSIFICATION");
  }
  if (stageA === "MATERIAL" && stageB === "DISCOVERY") {
    if (
      providerOutput.discoveries.some(
        (discovery) => discovery.url_candidate_ids.length === 0,
      )
    ) {
      reasons.add("MISSING_CANONICAL_URL");
    }
    if (
      providerOutput.discoveries.some(
        (discovery) => discovery.url_candidate_ids.length > 1,
      )
    ) {
      reasons.add("AMBIGUOUS_CANONICAL_URL");
    }
    if (
      providerOutput.discoveries.some((discovery) => discovery.root_story_only)
    ) {
      reasons.add("ROOT_ONLY_DISCOVERY");
    }
  }
  if (hasLowConfidence(providerOutput, stageA, stageB)) {
    reasons.add("LOW_CONFIDENCE");
  }
  const reviewReasons = REVIEW_REASON_ORDER.filter((reason) =>
    reasons.has(reason),
  );
  const review = {
    required: reviewReasons.length > 0,
    reasons: reviewReasons,
  } as const;
  const output: ClassificationV1 =
    stageA === "REVIEW"
      ? {
          ...providerOutput,
          primary_decision: "REVIEW",
          comment_relevance: {
            ...providerOutput.comment_relevance,
            is_materially_technical: false,
          },
          rejection_reasons: [],
          discoveries: [],
          expert_note: null,
          review,
        }
      : { ...providerOutput, review };

  return {
    version: CLASSIFICATION_DECISION_ROUTER_VERSION,
    stageA,
    stageB,
    primaryDecision: output.primary_decision,
    materiallyTechnical: output.comment_relevance.is_materially_technical,
    reviewReasons,
    evidenceSpanIds: evidenceSpanIdsFor(output),
    output,
  };
};
