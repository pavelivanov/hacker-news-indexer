import Type from "typebox";
import Schema from "typebox/schema";

const exactObject = <const T extends Type.TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

const Confidence = Type.Number({ minimum: 0, maximum: 1 });
const BoundedReason = Type.String({ minLength: 1, maxLength: 500 });
const SpanId = Type.String({ pattern: "^span:[0-9]+$" });
const UrlCandidateId = Type.String({ pattern: "^url:[0-9]+$" });
const EvidenceOrigin = Type.Union([
  Type.Literal("COMMENT"),
  Type.Literal("ROOT_STORY"),
  Type.Literal("BOTH"),
]);

const CommentRelevance = exactObject({
  is_materially_technical: Type.Boolean(),
  reason: BoundedReason,
  evidence_span_ids: Type.Array(SpanId, {
    maxItems: 12,
    uniqueItems: true,
  }),
});

const Discovery = exactObject({
  subject_type: Type.Union([
    Type.Literal("PROJECT"),
    Type.Literal("TOOL"),
    Type.Literal("LIBRARY"),
    Type.Literal("SERVICE"),
    Type.Literal("PRODUCT"),
    Type.Literal("FEATURE"),
    Type.Literal("PLUGIN"),
    Type.Literal("AGENT_SKILL"),
    Type.Literal("GUIDE"),
    Type.Literal("RESOURCE"),
  ]),
  name: Type.String({ minLength: 1, maxLength: 160 }),
  aliases: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), {
    maxItems: 10,
    uniqueItems: true,
  }),
  description_claim: Type.String({ minLength: 1, maxLength: 1000 }),
  evidence_origin: EvidenceOrigin,
  evidence_span_ids: Type.Array(SpanId, {
    minItems: 1,
    maxItems: 12,
    uniqueItems: true,
  }),
  url_candidate_ids: Type.Array(UrlCandidateId, {
    maxItems: 12,
    uniqueItems: true,
  }),
  url_grounding: Type.Union([Type.Literal("GROUNDED"), Type.Literal("NONE")]),
  root_story_only: Type.Boolean(),
  confidence: Confidence,
});

const ExpertNote = exactObject({
  note_type: Type.Union([
    Type.Literal("TECHNICAL_EXPLANATION"),
    Type.Literal("CORRECTION"),
    Type.Literal("PRODUCT_EXPERIENCE"),
    Type.Literal("IMPLEMENTATION_CAVEAT"),
    Type.Literal("SECURITY"),
    Type.Literal("OPERATIONS"),
    Type.Literal("COMPARISON"),
    Type.Literal("GUIDE"),
  ]),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  summary: Type.String({ minLength: 1, maxLength: 2000 }),
  evidence_origin: EvidenceOrigin,
  evidence_span_ids: Type.Array(SpanId, {
    minItems: 1,
    maxItems: 16,
    uniqueItems: true,
  }),
  related_subject_names: Type.Array(
    Type.String({ minLength: 1, maxLength: 160 }),
    { maxItems: 12, uniqueItems: true },
  ),
  qualifiers: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), {
    maxItems: 12,
    uniqueItems: true,
  }),
  confidence: Confidence,
});

const Review = exactObject({
  required: Type.Boolean(),
  reasons: Type.Array(
    Type.Union([
      Type.Literal("MISSING_CANONICAL_URL"),
      Type.Literal("AMBIGUOUS_CANONICAL_URL"),
      Type.Literal("ROOT_ONLY_DISCOVERY"),
      Type.Literal("LEGAL_RECOMMENDATION"),
      Type.Literal("MEDICAL_RECOMMENDATION"),
      Type.Literal("SECURITY_RECOMMENDATION"),
      Type.Literal("DESTRUCTIVE_OR_EVASION_ADVICE"),
      Type.Literal("LOW_CONFIDENCE"),
      Type.Literal("PROMPT_INJECTION"),
      Type.Literal("UNAVAILABLE_CONTENT"),
      Type.Literal("TELEGRAM_HN_DIVERGENCE"),
      Type.Literal("CONFLICTING_EVIDENCE_ORIGIN"),
      Type.Literal("INVALID_EVIDENCE_SPAN"),
      Type.Literal("UNSUPPORTED_URL"),
      Type.Literal("AMBIGUOUS_CLASSIFICATION"),
    ]),
    { maxItems: 12, uniqueItems: true },
  ),
});

export const ClassificationV1Schema = Type.Object(
  {
    schema_version: Type.Literal("classification.v1"),
    primary_decision: Type.Union([
      Type.Literal("DISCOVERY"),
      Type.Literal("EXPERT_NOTE"),
      Type.Literal("REJECTED"),
      Type.Literal("REVIEW"),
    ]),
    decision_confidence: Confidence,
    comment_relevance: CommentRelevance,
    rejection_reasons: Type.Array(
      Type.Union([
        Type.Literal("POLITICS_NO_TECHNICAL_SUBJECT"),
        Type.Literal("JOKE_OR_ONE_LINER"),
        Type.Literal("GENERIC_OPINION"),
        Type.Literal("PERSONAL_STORY_NO_USABLE_SUBJECT"),
        Type.Literal("INCIDENTAL_MENTION"),
        Type.Literal("NEWS_WITHOUT_REUSABLE_DETAIL"),
        Type.Literal("UNAVAILABLE_CONTENT"),
      ]),
      { maxItems: 7, uniqueItems: true },
    ),
    discoveries: Type.Array(Discovery, { maxItems: 5 }),
    expert_note: Type.Union([ExpertNote, Type.Null()]),
    review: Review,
  },
  {
    $id: "classification.v1",
    title: "Grounded classification result v1",
    additionalProperties: false,
  },
);

export type ClassificationV1 = Type.Static<typeof ClassificationV1Schema>;

export const ClassificationV1Validator = Schema.Compile(ClassificationV1Schema);

export const isClassificationV1 = (value: unknown): value is ClassificationV1 =>
  ClassificationV1Validator.Check(value);

export type ClassificationV1ValidationErrorCode =
  | "SCHEMA_INVALID"
  | "PRIMARY_DECISION_CONTENT_MISMATCH"
  | "REVIEW_STATE_MISMATCH"
  | "URL_GROUNDING_MISMATCH"
  | "ROOT_ONLY_ORIGIN_MISMATCH";

export type ClassificationV1ValidationResult =
  | { readonly ok: true; readonly value: ClassificationV1 }
  | { readonly ok: false; readonly code: ClassificationV1ValidationErrorCode };

export const validateClassificationV1 = (
  value: unknown,
): ClassificationV1ValidationResult => {
  if (!isClassificationV1(value)) {
    return { ok: false, code: "SCHEMA_INVALID" };
  }
  const primaryContentIsValid =
    (value.primary_decision === "DISCOVERY" &&
      value.discoveries.length > 0 &&
      value.rejection_reasons.length === 0) ||
    (value.primary_decision === "EXPERT_NOTE" &&
      value.discoveries.length === 0 &&
      value.expert_note !== null &&
      value.rejection_reasons.length === 0) ||
    (value.primary_decision === "REJECTED" &&
      value.discoveries.length === 0 &&
      value.expert_note === null &&
      value.rejection_reasons.length > 0) ||
    value.primary_decision === "REVIEW";
  if (!primaryContentIsValid) {
    return { ok: false, code: "PRIMARY_DECISION_CONTENT_MISMATCH" };
  }
  if (value.review.required !== value.review.reasons.length > 0) {
    return { ok: false, code: "REVIEW_STATE_MISMATCH" };
  }
  for (const discovery of value.discoveries) {
    if (
      (discovery.url_grounding === "GROUNDED") !==
      discovery.url_candidate_ids.length > 0
    ) {
      return { ok: false, code: "URL_GROUNDING_MISMATCH" };
    }
    if (
      discovery.root_story_only !==
      (discovery.evidence_origin === "ROOT_STORY")
    ) {
      return { ok: false, code: "ROOT_ONLY_ORIGIN_MISMATCH" };
    }
  }
  return { ok: true, value };
};
