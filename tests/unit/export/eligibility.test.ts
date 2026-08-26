import { describe, expect, it } from "vitest";

import {
  findThatProjectIneligibility,
  isFindThatProjectEligible,
  type FindThatProjectEligibilityInput,
} from "@hn-knowledge/application";

const eligible: FindThatProjectEligibilityInput = {
  discoveryStatus: "APPROVED",
  contentAvailable: true,
  canonicalUrl: "https://example.com/project",
  canonicalUrlGroundedInHnEvidence: true,
  subjectType: "PROJECT",
  classificationConfidence: 0.95,
  subjectConfidence: 0.95,
  urlConfidence: 1,
  selectedCommentMateriallyDiscussesSubject: true,
  unresolvedReviewFlags: false,
  evidencePresent: true,
  explicitlyApprovedForExport: true,
};

describe("FindThatProject eligibility", () => {
  it("accepts only a fully approved grounded Discovery", () => {
    expect(isFindThatProjectEligible(eligible)).toBe(true);
  });

  it.each([
    ["DISCOVERY_NOT_APPROVED", { discoveryStatus: "REVIEW_PENDING" }],
    ["CONTENT_UNAVAILABLE", { contentAvailable: false }],
    ["CANONICAL_URL_NOT_GROUNDED", { canonicalUrl: "javascript:alert(1)" }],
    ["CANONICAL_URL_NOT_GROUNDED", { canonicalUrlGroundedInHnEvidence: false }],
    ["SUBJECT_TYPE_NOT_ALLOWED", { subjectType: "FEATURE" }],
    ["CLASSIFICATION_CONFIDENCE_LOW", { classificationConfidence: 0.949 }],
    ["SUBJECT_CONFIDENCE_LOW", { subjectConfidence: 0.949 }],
    ["URL_CONFIDENCE_LOW", { urlConfidence: 0.949 }],
    [
      "COMMENT_MATERIALITY_MISSING",
      { selectedCommentMateriallyDiscussesSubject: false },
    ],
    ["UNRESOLVED_REVIEW_FLAGS", { unresolvedReviewFlags: true }],
    ["EVIDENCE_MISSING", { evidencePresent: false }],
    ["EXPORT_APPROVAL_REQUIRED", { explicitlyApprovedForExport: false }],
  ] as const)("rejects %s", (reason, change) => {
    expect(findThatProjectIneligibility({ ...eligible, ...change })).toContain(
      reason,
    );
  });
});
