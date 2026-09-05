import {
  validateClassificationV1,
  type ClassificationV1,
  type ManualDraftPayload,
} from "@hn-knowledge/contracts";
import type { CommentDetail } from "./api";

export type Draft = ManualDraftPayload;
export type Discovery = NonNullable<Draft["discoveries"]>[number];
export type Note = NonNullable<Draft["expert_note"]>;
export type EvidenceTarget = "relevance" | "note" | `discovery:${number}`;
export const label = (value: string) =>
  value
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
export const newNote = (): Note => ({
  note_type: "TECHNICAL_EXPLANATION",
  title: "",
  summary: "",
  evidence_origin: "COMMENT",
  evidence_span_ids: [],
  related_subject_names: [],
  qualifiers: [],
});
export const newDiscovery = (): Discovery => ({
  subject_type: "PROJECT",
  name: "",
  aliases: [],
  description_claim: "",
  evidence_origin: "COMMENT",
  evidence_span_ids: [],
  url_candidate_ids: [],
  url_grounding: "NONE",
  root_story_only: false,
});
export const initialDraft = (value: Draft = {}): Draft => ({
  schema_version: "classification.v1",
  primary_decision: "EXPERT_NOTE",
  rejection_reasons: [],
  ...value,
  discoveries:
    value.discoveries?.map((item) => ({ ...newDiscovery(), ...item })) ?? [],
  expert_note:
    value.primary_decision === "REJECTED"
      ? null
      : value.expert_note
        ? { ...newNote(), ...value.expert_note }
        : !value.primary_decision || value.primary_decision === "EXPERT_NOTE"
          ? newNote()
          : null,
  comment_relevance: {
    is_materially_technical: false,
    reason: "",
    evidence_span_ids: [],
    ...value.comment_relevance,
  },
  review: { required: false, reasons: [], ...value.review },
});
export const changeClass = (
  draft: Draft,
  kind: Draft["primary_decision"],
): Draft => ({
  ...draft,
  primary_decision: kind,
  discoveries:
    kind === "DISCOVERY"
      ? draft.discoveries?.length
        ? draft.discoveries
        : [newDiscovery()]
      : [],
  expert_note:
    kind === "REJECTED"
      ? null
      : kind === "EXPERT_NOTE"
        ? (draft.expert_note ?? newNote())
        : draft.expert_note?.title ||
            draft.expert_note?.summary ||
            draft.expert_note?.evidence_span_ids?.length
          ? draft.expert_note
          : null,
  rejection_reasons: kind === "REJECTED" ? draft.rejection_reasons : [],
});
export const evidenceIds = (draft: Draft, target: EvidenceTarget): string[] => {
  if (target === "relevance")
    return draft.comment_relevance?.evidence_span_ids ?? [];
  if (target === "note") return draft.expert_note?.evidence_span_ids ?? [];
  return (
    draft.discoveries?.[Number(target.split(":")[1])]?.evidence_span_ids ?? []
  );
};
export const setEvidence = (
  draft: Draft,
  target: EvidenceTarget,
  ids: string[],
  source: CommentDetail["source"],
): Draft => {
  const origins = new Set(
    source?.documents
      .flatMap((doc) => doc.spans)
      .filter((span) => ids.includes(span.id))
      .map((span) => span.origin),
  );
  const origin =
    origins.size > 1
      ? "BOTH"
      : origins.has("ROOT_STORY")
        ? "ROOT_STORY"
        : "COMMENT";
  if (target === "relevance")
    return {
      ...draft,
      comment_relevance: { ...draft.comment_relevance, evidence_span_ids: ids },
    };
  if (target === "note")
    return {
      ...draft,
      expert_note: {
        ...draft.expert_note,
        evidence_span_ids: ids,
        evidence_origin: origin,
      },
    };
  return {
    ...draft,
    discoveries: draft.discoveries?.map((item, index) =>
      index === Number(target.split(":")[1])
        ? {
            ...item,
            evidence_span_ids: ids,
            evidence_origin: origin,
            root_story_only: origin === "ROOT_STORY",
          }
        : item,
    ),
  };
};
export const clearEvidence = (draft: Draft): Draft => ({
  ...draft,
  comment_relevance: { ...draft.comment_relevance, evidence_span_ids: [] },
  expert_note: draft.expert_note
    ? { ...draft.expert_note, evidence_span_ids: [] }
    : draft.expert_note,
  discoveries: draft.discoveries?.map((item) => ({
    ...item,
    evidence_span_ids: [],
    url_candidate_ids: [],
    url_grounding: "NONE",
  })),
});
export const missingFields = (
  draft: Draft,
  source: CommentDetail["source"],
): string[] => {
  const missing: string[] = [];
  if (!draft.comment_relevance?.reason?.trim())
    missing.push("Explain the comment’s relevance.");
  if (draft.decision_confidence === undefined)
    missing.push("Choose your review confidence.");
  if (draft.primary_decision === "REJECTED" && !draft.rejection_reasons?.length)
    missing.push("Choose a rejection reason.");
  for (const [index, item] of (draft.discoveries ?? []).entries()) {
    if (!item.name?.trim()) missing.push(`Name discovery ${index + 1}.`);
    if (!item.description_claim?.trim())
      missing.push(`Describe discovery ${index + 1}.`);
    if (!item.evidence_span_ids?.length)
      missing.push(`Select evidence for discovery ${index + 1}.`);
    const text =
      source?.documents
        .flatMap((doc) => doc.spans)
        .filter((span) => item.evidence_span_ids?.includes(span.id))
        .map((span) => span.text.toLowerCase())
        .join("\n") ?? "";
    if (
      item.name &&
      item.evidence_span_ids?.length &&
      !text.includes(item.name.toLowerCase()) &&
      !item.aliases?.some((alias) => text.includes(alias.toLowerCase()))
    )
      missing.push(`Use a name found in discovery ${index + 1} evidence.`);
  }
  if (draft.expert_note) {
    if (!draft.expert_note.title?.trim())
      missing.push("Give the Expert note a title.");
    if (!draft.expert_note.summary?.trim())
      missing.push("Write the Expert note summary.");
    if (!draft.expert_note.evidence_span_ids?.length)
      missing.push("Select evidence for the Expert note.");
  }
  if (!missing.length && !validateClassificationV1(draft).ok)
    missing.push(
      "Complete the required fields and review flags before approval.",
    );
  return missing;
};
export const setConfidence = (
  draft: Draft,
  value: number | undefined,
): Draft => ({
  ...draft,
  decision_confidence: value,
  discoveries: draft.discoveries?.map((item) => ({
    ...item,
    confidence: value,
  })),
  expert_note: draft.expert_note
    ? { ...draft.expert_note, confidence: value }
    : draft.expert_note,
});
export const subjectTypes: ClassificationV1["discoveries"][number]["subject_type"][] =
  [
    "PROJECT",
    "TOOL",
    "LIBRARY",
    "SERVICE",
    "PRODUCT",
    "FEATURE",
    "PLUGIN",
    "AGENT_SKILL",
    "GUIDE",
    "RESOURCE",
  ];
export const noteTypes: NonNullable<
  ClassificationV1["expert_note"]
>["note_type"][] = [
  "TECHNICAL_EXPLANATION",
  "CORRECTION",
  "PRODUCT_EXPERIENCE",
  "IMPLEMENTATION_CAVEAT",
  "SECURITY",
  "OPERATIONS",
  "COMPARISON",
  "GUIDE",
];
export const rejectionReasons: ClassificationV1["rejection_reasons"] = [
  "POLITICS_NO_TECHNICAL_SUBJECT",
  "JOKE_OR_ONE_LINER",
  "GENERIC_OPINION",
  "PERSONAL_STORY_NO_USABLE_SUBJECT",
  "INCIDENTAL_MENTION",
  "NEWS_WITHOUT_REUSABLE_DETAIL",
  "UNAVAILABLE_CONTENT",
];
export const reviewReasons: ClassificationV1["review"]["reasons"] = [
  "MISSING_CANONICAL_URL",
  "AMBIGUOUS_CANONICAL_URL",
  "ROOT_ONLY_DISCOVERY",
  "LEGAL_RECOMMENDATION",
  "MEDICAL_RECOMMENDATION",
  "SECURITY_RECOMMENDATION",
  "DESTRUCTIVE_OR_EVASION_ADVICE",
  "LOW_CONFIDENCE",
  "PROMPT_INJECTION",
  "TELEGRAM_HN_DIVERGENCE",
  "CONFLICTING_EVIDENCE_ORIGIN",
  "AMBIGUOUS_CLASSIFICATION",
];
