import Type from "typebox";
import Schema from "typebox/schema";

const exactObject = <const T extends Type.TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

const Uuid = Type.String({
  pattern:
    "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
const Timestamp = Type.String({ format: "date-time" });
const HnItemId = Type.Integer({ minimum: 1 });
const TelegramMessageId = Type.Integer({ minimum: 1 });
const Confidence = Type.Number({ minimum: 0.95, maximum: 1 });
const HttpUrl = Type.String({
  minLength: 8,
  maxLength: 2048,
  pattern: "^https?://[^\\s]+$",
});

export const FindThatProjectSubjectTypeV1Schema = Type.Union([
  Type.Literal("PROJECT"),
  Type.Literal("TOOL"),
  Type.Literal("LIBRARY"),
  Type.Literal("SERVICE"),
  Type.Literal("PRODUCT"),
  Type.Literal("PLUGIN"),
  Type.Literal("AGENT_SKILL"),
]);

export const FindThatProjectSubjectV1Schema = exactObject({
  name: Type.String({ minLength: 1, maxLength: 160 }),
  type: FindThatProjectSubjectTypeV1Schema,
  canonical_url: HttpUrl,
  evidence_based_summary: Type.String({ minLength: 1, maxLength: 1000 }),
});

export const FindThatProjectProvenanceV1Schema = exactObject({
  hn_comment_id: HnItemId,
  hn_root_story_id: HnItemId,
  telegram_message_ids: Type.Array(TelegramMessageId, {
    minItems: 1,
    maxItems: 100,
    uniqueItems: true,
  }),
  evidence_origin: Type.Union([Type.Literal("COMMENT"), Type.Literal("BOTH")]),
  evidence_quote: Type.String({ minLength: 1, maxLength: 500 }),
});

const CommonExportProperties = {
  schema_version: Type.Literal("findthatproject.discovery.v1"),
  export_id: Uuid,
  revision: Type.Integer({ minimum: 1 }),
  discovery_id: Uuid,
  kind: Type.Literal("DISCOVERY"),
  reviewed_at: Timestamp,
};

export const FindThatProjectUpsertV1Schema = exactObject({
  ...CommonExportProperties,
  action: Type.Literal("UPSERT"),
  subject: FindThatProjectSubjectV1Schema,
  provenance: FindThatProjectProvenanceV1Schema,
  confidence: Confidence,
});

export const FindThatProjectRetractionV1Schema = exactObject({
  ...CommonExportProperties,
  action: Type.Literal("RETRACT"),
  retraction_reason: Type.Union([
    Type.Literal("CONTENT_CHANGED"),
    Type.Literal("CONTENT_UNAVAILABLE"),
    Type.Literal("DISCOVERY_REJECTED"),
    Type.Literal("EVIDENCE_INVALIDATED"),
    Type.Literal("SUBJECT_CHANGED"),
  ]),
  provenance: exactObject({
    hn_comment_id: HnItemId,
    hn_root_story_id: HnItemId,
    telegram_message_ids: Type.Array(TelegramMessageId, {
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
    }),
  }),
});

export const FindThatProjectDiscoveryV1Schema = Type.Union([
  FindThatProjectUpsertV1Schema,
  FindThatProjectRetractionV1Schema,
]);

export type FindThatProjectSubjectTypeV1 = Type.Static<
  typeof FindThatProjectSubjectTypeV1Schema
>;
export type FindThatProjectUpsertV1 = Type.Static<
  typeof FindThatProjectUpsertV1Schema
>;
export type FindThatProjectRetractionV1 = Type.Static<
  typeof FindThatProjectRetractionV1Schema
>;
export type FindThatProjectDiscoveryV1 = Type.Static<
  typeof FindThatProjectDiscoveryV1Schema
>;

const validator = Schema.Compile(FindThatProjectDiscoveryV1Schema);

export const isFindThatProjectDiscoveryV1 = (
  value: unknown,
): value is FindThatProjectDiscoveryV1 => validator.Check(value);
