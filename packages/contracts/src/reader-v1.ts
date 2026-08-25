import Type from "typebox";
import Schema from "typebox/schema";

const exactObject = <const T extends Type.TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

const Uuid = Type.String({
  pattern:
    "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
const HnItemId = Type.Integer({ minimum: 1 });
const Timestamp = Type.String({ format: "date-time" });
const Confidence = Type.Number({ minimum: 0, maximum: 1 });
const SubjectType = Type.Union([
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
]);
const EvidenceOrigin = Type.Union([
  Type.Literal("COMMENT"),
  Type.Literal("ROOT_STORY"),
]);

export const ReaderEvidenceV1Schema = exactObject({
  origin: EvidenceOrigin,
  hn_item_id: HnItemId,
  start_offset: Type.Integer({ minimum: 0 }),
  end_offset: Type.Integer({ minimum: 1 }),
  excerpt: Type.String({ minLength: 1, maxLength: 500 }),
});

export const ReaderSubjectLinkV1Schema = exactObject({
  id: Uuid,
  name: Type.String({ minLength: 1, maxLength: 160 }),
  type: SubjectType,
});

const ReaderProvenanceProperties = {
  selected_comment_id: HnItemId,
  resolved_root_id: HnItemId,
  displayed_story_id: Type.Union([HnItemId, Type.Null()]),
  source_occurrence_ids: Type.Array(Uuid, {
    maxItems: 100,
    uniqueItems: true,
  }),
};

const ReaderPublicationProperties = {
  status: Type.Literal("APPROVED"),
  confidence: Confidence,
  published_at: Timestamp,
  updated_at: Timestamp,
  review_revision: Type.Integer({ minimum: 0 }),
  publication_revision: Type.Integer({ minimum: 1 }),
};

export const DiscoveryFeedItemV1Schema = exactObject({
  id: Uuid,
  kind: Type.Literal("discovery"),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  summary: Type.String({ minLength: 1, maxLength: 1000 }),
  subjects: Type.Array(ReaderSubjectLinkV1Schema, {
    minItems: 1,
    maxItems: 12,
  }),
  evidence: Type.Array(ReaderEvidenceV1Schema, {
    minItems: 1,
    maxItems: 16,
  }),
  cluster_position: Type.Integer({ minimum: 1 }),
  cluster_size: Type.Integer({ minimum: 1 }),
  ...ReaderProvenanceProperties,
  ...ReaderPublicationProperties,
});

export const ExpertNoteFeedItemV1Schema = exactObject({
  id: Uuid,
  kind: Type.Literal("expert_note"),
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
  subjects: Type.Array(ReaderSubjectLinkV1Schema, { maxItems: 12 }),
  evidence: Type.Array(ReaderEvidenceV1Schema, {
    minItems: 1,
    maxItems: 16,
  }),
  cluster_position: Type.Integer({ minimum: 1 }),
  cluster_size: Type.Integer({ minimum: 1 }),
  ...ReaderProvenanceProperties,
  ...ReaderPublicationProperties,
});

export const FeedItemV1Schema = Type.Union([
  DiscoveryFeedItemV1Schema,
  ExpertNoteFeedItemV1Schema,
]);

export const ReaderStoryClusterV1Schema = exactObject({
  resolved_root_id: HnItemId,
  total_count: Type.Integer({ minimum: 3 }),
  items: Type.Array(FeedItemV1Schema, { minItems: 1, maxItems: 100 }),
});

export const KnowledgeFeedV1Schema = exactObject({
  schema_version: Type.Literal("knowledge-feed.v1"),
  kind: Type.Union([Type.Literal("discovery"), Type.Literal("expert_note")]),
  items: Type.Array(FeedItemV1Schema, { maxItems: 20 }),
  story_clusters: Type.Array(ReaderStoryClusterV1Schema, { maxItems: 20 }),
  next_cursor: Type.Union([
    Type.String({ minLength: 16, maxLength: 8192 }),
    Type.Null(),
  ]),
});

export const ReaderCommentV1Schema = exactObject({
  schema_version: Type.Literal("reader-comment.v1"),
  id: HnItemId,
  status: Type.Literal("AVAILABLE"),
  author: Type.Union([Type.String({ maxLength: 80 }), Type.Null()]),
  body_html: Type.String({ maxLength: 100_000 }),
  body_text: Type.String({ maxLength: 100_000 }),
  created_at: Type.Union([Timestamp, Type.Null()]),
  resolved_root_id: HnItemId,
  displayed_story_id: Type.Union([HnItemId, Type.Null()]),
  source_occurrence_ids: Type.Array(Uuid, {
    maxItems: 100,
    uniqueItems: true,
  }),
  subjects: Type.Array(ReaderSubjectLinkV1Schema, { maxItems: 100 }),
  items: Type.Array(FeedItemV1Schema, { maxItems: 100 }),
});

export const ReaderStoryV1Schema = exactObject({
  schema_version: Type.Literal("reader-story.v1"),
  id: HnItemId,
  status: Type.Literal("AVAILABLE"),
  title: Type.Union([
    Type.String({ minLength: 1, maxLength: 500 }),
    Type.Null(),
  ]),
  author: Type.Union([Type.String({ maxLength: 80 }), Type.Null()]),
  body_html: Type.String({ maxLength: 100_000 }),
  body_text: Type.String({ maxLength: 100_000 }),
  url: Type.Union([Type.String({ maxLength: 2048 }), Type.Null()]),
  created_at: Type.Union([Timestamp, Type.Null()]),
  subjects: Type.Array(ReaderSubjectLinkV1Schema, { maxItems: 100 }),
  items: Type.Array(FeedItemV1Schema, { maxItems: 100 }),
});

export const ReaderSubjectV1Schema = exactObject({
  schema_version: Type.Literal("reader-subject.v1"),
  id: Uuid,
  status: Type.Literal("ACTIVE"),
  name: Type.String({ minLength: 1, maxLength: 160 }),
  type: SubjectType,
  aliases: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), {
    maxItems: 100,
    uniqueItems: true,
  }),
  canonical_url: Type.Union([
    Type.String({ minLength: 1, maxLength: 2048 }),
    Type.Null(),
  ]),
  created_at: Timestamp,
  updated_at: Timestamp,
  discovery_count: Type.Integer({ minimum: 0 }),
  expert_note_count: Type.Integer({ minimum: 0 }),
});

export const ReaderSubjectNotesV1Schema = exactObject({
  schema_version: Type.Literal("reader-subject-notes.v1"),
  subject: ReaderSubjectLinkV1Schema,
  items: Type.Array(ExpertNoteFeedItemV1Schema, { maxItems: 100 }),
  next_cursor: Type.Union([
    Type.String({ minLength: 16, maxLength: 8192 }),
    Type.Null(),
  ]),
});

export type ReaderEvidenceV1 = Type.Static<typeof ReaderEvidenceV1Schema>;
export type ReaderSubjectLinkV1 = Type.Static<typeof ReaderSubjectLinkV1Schema>;
export type DiscoveryFeedItemV1 = Type.Static<typeof DiscoveryFeedItemV1Schema>;
export type ExpertNoteFeedItemV1 = Type.Static<
  typeof ExpertNoteFeedItemV1Schema
>;
export type FeedItemV1 = Type.Static<typeof FeedItemV1Schema>;
export type KnowledgeFeedV1 = Type.Static<typeof KnowledgeFeedV1Schema>;
export type ReaderCommentV1 = Type.Static<typeof ReaderCommentV1Schema>;
export type ReaderStoryV1 = Type.Static<typeof ReaderStoryV1Schema>;
export type ReaderSubjectV1 = Type.Static<typeof ReaderSubjectV1Schema>;
export type ReaderSubjectNotesV1 = Type.Static<
  typeof ReaderSubjectNotesV1Schema
>;

const feedValidator = Schema.Compile(KnowledgeFeedV1Schema);
const commentValidator = Schema.Compile(ReaderCommentV1Schema);
const storyValidator = Schema.Compile(ReaderStoryV1Schema);
const subjectValidator = Schema.Compile(ReaderSubjectV1Schema);
const subjectNotesValidator = Schema.Compile(ReaderSubjectNotesV1Schema);

export const isKnowledgeFeedV1 = (value: unknown): value is KnowledgeFeedV1 =>
  feedValidator.Check(value);
export const isReaderCommentV1 = (value: unknown): value is ReaderCommentV1 =>
  commentValidator.Check(value);
export const isReaderStoryV1 = (value: unknown): value is ReaderStoryV1 =>
  storyValidator.Check(value);
export const isReaderSubjectV1 = (value: unknown): value is ReaderSubjectV1 =>
  subjectValidator.Check(value);
export const isReaderSubjectNotesV1 = (
  value: unknown,
): value is ReaderSubjectNotesV1 => subjectNotesValidator.Check(value);
