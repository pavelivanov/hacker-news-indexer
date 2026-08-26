import type { FindThatProjectSubjectTypeV1 } from "@hn-knowledge/contracts";

export const FINDTHATPROJECT_MINIMUM_CONFIDENCE = 0.95;

export const FINDTHATPROJECT_SUBJECT_TYPES = [
  "PROJECT",
  "TOOL",
  "LIBRARY",
  "SERVICE",
  "PRODUCT",
  "PLUGIN",
  "AGENT_SKILL",
] as const satisfies readonly FindThatProjectSubjectTypeV1[];

export type FindThatProjectIneligibilityCode =
  | "DISCOVERY_NOT_APPROVED"
  | "CONTENT_UNAVAILABLE"
  | "CANONICAL_URL_NOT_GROUNDED"
  | "SUBJECT_TYPE_NOT_ALLOWED"
  | "CLASSIFICATION_CONFIDENCE_LOW"
  | "SUBJECT_CONFIDENCE_LOW"
  | "URL_CONFIDENCE_LOW"
  | "COMMENT_MATERIALITY_MISSING"
  | "UNRESOLVED_REVIEW_FLAGS"
  | "EVIDENCE_MISSING"
  | "EXPORT_APPROVAL_REQUIRED";

export interface FindThatProjectEligibilityInput {
  readonly discoveryStatus:
    "REVIEW_PENDING" | "APPROVED" | "REJECTED" | "SUPERSEDED";
  readonly contentAvailable: boolean;
  readonly canonicalUrl: string | null;
  readonly canonicalUrlGroundedInHnEvidence: boolean;
  readonly subjectType: string;
  readonly classificationConfidence: number;
  readonly subjectConfidence: number;
  readonly urlConfidence: number;
  readonly selectedCommentMateriallyDiscussesSubject: boolean;
  readonly unresolvedReviewFlags: boolean;
  readonly evidencePresent: boolean;
  readonly explicitlyApprovedForExport: boolean;
}

const groundedHttpUrl = (value: string | null): boolean => {
  if (value === null) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
};

export const findThatProjectIneligibility = (
  input: FindThatProjectEligibilityInput,
): readonly FindThatProjectIneligibilityCode[] => {
  const reasons: FindThatProjectIneligibilityCode[] = [];
  if (input.discoveryStatus !== "APPROVED") {
    reasons.push("DISCOVERY_NOT_APPROVED");
  }
  if (!input.contentAvailable) {
    reasons.push("CONTENT_UNAVAILABLE");
  }
  if (
    !groundedHttpUrl(input.canonicalUrl) ||
    !input.canonicalUrlGroundedInHnEvidence
  ) {
    reasons.push("CANONICAL_URL_NOT_GROUNDED");
  }
  if (
    !FINDTHATPROJECT_SUBJECT_TYPES.includes(
      input.subjectType as FindThatProjectSubjectTypeV1,
    )
  ) {
    reasons.push("SUBJECT_TYPE_NOT_ALLOWED");
  }
  if (input.classificationConfidence < FINDTHATPROJECT_MINIMUM_CONFIDENCE) {
    reasons.push("CLASSIFICATION_CONFIDENCE_LOW");
  }
  if (input.subjectConfidence < FINDTHATPROJECT_MINIMUM_CONFIDENCE) {
    reasons.push("SUBJECT_CONFIDENCE_LOW");
  }
  if (input.urlConfidence < FINDTHATPROJECT_MINIMUM_CONFIDENCE) {
    reasons.push("URL_CONFIDENCE_LOW");
  }
  if (!input.selectedCommentMateriallyDiscussesSubject) {
    reasons.push("COMMENT_MATERIALITY_MISSING");
  }
  if (input.unresolvedReviewFlags) {
    reasons.push("UNRESOLVED_REVIEW_FLAGS");
  }
  if (!input.evidencePresent) {
    reasons.push("EVIDENCE_MISSING");
  }
  if (!input.explicitlyApprovedForExport) {
    reasons.push("EXPORT_APPROVAL_REQUIRED");
  }
  return reasons;
};

export const isFindThatProjectEligible = (
  input: FindThatProjectEligibilityInput,
): boolean => findThatProjectIneligibility(input).length === 0;
