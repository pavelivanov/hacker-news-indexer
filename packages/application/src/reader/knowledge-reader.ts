import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  FeedItemV1,
  KnowledgeFeedV1,
  ReaderCommentV1,
  ReaderStoryV1,
  ReaderSubjectLinkV1,
  ReaderSubjectNotesV1,
  ReaderSubjectV1,
} from "@hn-knowledge/contracts";
import { hnItemId, subjectId } from "@hn-knowledge/domain";
import type {
  KnowledgeReaderRepository,
  ReaderContentRecord,
  ReaderExpertNoteRecord,
} from "@hn-knowledge/ports";

import { redactReaderUrl, renderReaderSafeHtml } from "./safe-html.js";

const PAGE_SIZE = 20;
const REPOSITORY_LIMIT = 1_001;
const MAX_PUBLISHED_RECORDS = REPOSITORY_LIMIT - 1;
const CURSOR_VERSION = 1;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class KnowledgeReaderError extends Error {
  constructor(
    readonly code:
      | "INVALID_CURSOR"
      | "INVALID_IDENTIFIER"
      | "NOT_FOUND"
      | "RESULT_WINDOW_EXCEEDED",
  ) {
    super(code);
    this.name = "KnowledgeReaderError";
  }
}

export interface KnowledgeFeedInput {
  readonly kind: "discovery" | "expert_note";
  readonly cursor: string | null;
}

export interface SubjectNotesInput {
  readonly subjectId: string;
  readonly cursor: string | null;
}

export interface KnowledgeReader {
  readonly getFeed: (input: KnowledgeFeedInput) => Promise<KnowledgeFeedV1>;
  readonly getComment: (id: number) => Promise<ReaderCommentV1>;
  readonly getStory: (id: number) => Promise<ReaderStoryV1>;
  readonly getSubject: (id: string) => Promise<ReaderSubjectV1>;
  readonly getSubjectNotes: (
    input: SubjectNotesInput,
  ) => Promise<ReaderSubjectNotesV1>;
}

interface CursorPayload {
  readonly v: typeof CURSOR_VERSION;
  readonly scope: string;
  readonly cutoff: string;
  readonly after_id: string;
}

const encoded = (value: string): string =>
  Buffer.from(value, "utf8").toString("base64url");

const signature = (payload: string, secret: string): Buffer =>
  createHmac("sha256", secret).update(payload, "utf8").digest();

const encodeCursor = (payload: CursorPayload, secret: string): string => {
  const body = encoded(JSON.stringify(payload));
  return `${body}.${signature(body, secret).toString("base64url")}`;
};

const isCursorPayload = (value: unknown): value is CursorPayload => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 4 &&
    record["v"] === CURSOR_VERSION &&
    typeof record["scope"] === "string" &&
    record["scope"].length > 0 &&
    record["scope"].length <= 128 &&
    typeof record["cutoff"] === "string" &&
    !Number.isNaN(Date.parse(record["cutoff"])) &&
    typeof record["after_id"] === "string" &&
    UUID.test(record["after_id"])
  );
};

const decodeCursor = (
  cursor: string,
  scope: string,
  secret: string,
): CursorPayload => {
  if (cursor.length > 8_192) {
    throw new KnowledgeReaderError("INVALID_CURSOR");
  }
  const [body, rawSignature, extra] = cursor.split(".");
  if (body === undefined || rawSignature === undefined || extra !== undefined) {
    throw new KnowledgeReaderError("INVALID_CURSOR");
  }
  let supplied: Buffer;
  try {
    supplied = Buffer.from(rawSignature, "base64url");
  } catch {
    throw new KnowledgeReaderError("INVALID_CURSOR");
  }
  const expected = signature(body, secret);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    throw new KnowledgeReaderError("INVALID_CURSOR");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new KnowledgeReaderError("INVALID_CURSOR");
  }
  if (!isCursorPayload(parsed) || parsed.scope !== scope) {
    throw new KnowledgeReaderError("INVALID_CURSOR");
  }
  return parsed;
};

const comparePublished = (
  left: ReaderContentRecord,
  right: ReaderContentRecord,
  rootCounts: ReadonlyMap<number, number>,
): number => {
  const time = right.publishedAt.getTime() - left.publishedAt.getTime();
  if (time !== 0) {
    return time;
  }
  const leftPrior = rootCounts.get(left.resolvedRootId) ?? 0;
  const rightPrior = rootCounts.get(right.resolvedRootId) ?? 0;
  const leftScore = left.confidence / Math.sqrt(1 + leftPrior);
  const rightScore = right.confidence / Math.sqrt(1 + rightPrior);
  return rightScore - leftScore || left.id.localeCompare(right.id);
};

export const rankPublishedContent = (
  records: readonly ReaderContentRecord[],
): readonly ReaderContentRecord[] => {
  const remaining = [...records];
  const ranked: ReaderContentRecord[] = [];
  const rootCounts = new Map<number, number>();
  while (remaining.length > 0) {
    remaining.sort((left, right) => comparePublished(left, right, rootCounts));
    const next = remaining.shift();
    if (next === undefined) {
      break;
    }
    ranked.push(next);
    rootCounts.set(
      next.resolvedRootId,
      (rootCounts.get(next.resolvedRootId) ?? 0) + 1,
    );
  }
  return ranked;
};

const subjectLink = (
  value: ReaderContentRecord["subjects"][number],
): ReaderSubjectLinkV1 => ({
  id: value.id,
  name: value.name,
  type: value.type,
});

const clusterMetadata = (
  ranked: readonly ReaderContentRecord[],
): ReadonlyMap<
  string,
  { readonly position: number; readonly size: number }
> => {
  const sizes = new Map<number, number>();
  for (const item of ranked) {
    sizes.set(item.resolvedRootId, (sizes.get(item.resolvedRootId) ?? 0) + 1);
  }
  const positions = new Map<number, number>();
  return new Map(
    ranked.map((item) => {
      const position = (positions.get(item.resolvedRootId) ?? 0) + 1;
      positions.set(item.resolvedRootId, position);
      return [item.id, { position, size: sizes.get(item.resolvedRootId) ?? 1 }];
    }),
  );
};

const feedItem = (
  value: ReaderContentRecord,
  cluster: { readonly position: number; readonly size: number },
): FeedItemV1 => {
  const common = {
    id: value.id,
    title: value.title,
    summary: value.summary,
    subjects: value.subjects.map(subjectLink),
    evidence: value.evidence.map((span) => ({
      origin: span.origin,
      hn_item_id: span.hnItemId,
      start_offset: span.start,
      end_offset: span.end,
      excerpt: span.excerpt,
    })),
    selected_comment_id: value.selectedCommentId,
    resolved_root_id: value.resolvedRootId,
    displayed_story_id: value.displayedStoryId,
    source_occurrence_ids: [...new Set(value.sourceOccurrenceIds)].sort(),
    status: "APPROVED" as const,
    confidence: value.confidence,
    published_at: value.publishedAt.toISOString(),
    updated_at: value.updatedAt.toISOString(),
    review_revision: value.reviewRevision,
    publication_revision: value.publicationRevision,
    cluster_position: cluster.position,
    cluster_size: cluster.size,
  };
  return value.kind === "discovery"
    ? { ...common, kind: "discovery", id: value.id }
    : {
        ...common,
        kind: "expert_note",
        id: value.id,
        note_type: value.noteType,
      };
};

const assertWindow = (records: readonly ReaderContentRecord[]): void => {
  if (records.length >= REPOSITORY_LIMIT) {
    throw new KnowledgeReaderError("RESULT_WINDOW_EXCEEDED");
  }
};

const pageAfter = <T extends { readonly id: string }>(
  values: readonly T[],
  afterId: string | null,
): readonly T[] => {
  if (afterId === null) {
    return values;
  }
  const index = values.findIndex((value) => value.id === afterId);
  if (index < 0) {
    throw new KnowledgeReaderError("INVALID_CURSOR");
  }
  return values.slice(index + 1);
};

const asHnId = (value: number): ReturnType<typeof hnItemId> => {
  try {
    return hnItemId(value);
  } catch {
    throw new KnowledgeReaderError("INVALID_IDENTIFIER");
  }
};

const asSubjectId = (value: string): ReturnType<typeof subjectId> => {
  if (!UUID.test(value)) {
    throw new KnowledgeReaderError("INVALID_IDENTIFIER");
  }
  return subjectId(value);
};

const uniqueSubjects = (
  records: readonly ReaderContentRecord[],
): ReaderSubjectLinkV1[] =>
  [
    ...new Map(
      records.flatMap((record) =>
        record.subjects.map(
          (subject) => [subject.id, subjectLink(subject)] as const,
        ),
      ),
    ).values(),
  ].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );

export const createKnowledgeReader = (
  repository: KnowledgeReaderRepository,
  options: { readonly cursorSecret: string; readonly now?: () => Date },
): KnowledgeReader => {
  const secret = options.cursorSecret;
  if (secret.length === 0) {
    throw new TypeError("cursorSecret must not be empty");
  }
  const now = options.now ?? (() => new Date());

  const published = async (
    filter: Parameters<KnowledgeReaderRepository["listPublishedContent"]>[0],
  ): Promise<readonly ReaderContentRecord[]> => {
    const records = await repository.listPublishedContent(filter);
    assertWindow(records);
    return records;
  };

  return {
    async getFeed(input) {
      const scope = `feed:${input.kind}`;
      const cursor =
        input.cursor === null
          ? null
          : decodeCursor(input.cursor, scope, secret);
      const cutoff = cursor?.cutoff ?? now().toISOString();
      const records = await published({
        kind: input.kind,
        selectedCommentId: null,
        resolvedRootId: null,
        subjectId: null,
        limit: REPOSITORY_LIMIT,
      });
      const ranked = rankPublishedContent(
        records.filter((record) => record.publishedAt.toISOString() <= cutoff),
      );
      const metadata = clusterMetadata(ranked);
      const primary = ranked.filter(
        (record) => (metadata.get(record.id)?.position ?? 1) <= 2,
      );
      const remaining = pageAfter(primary, cursor?.after_id ?? null);
      const page = remaining.slice(0, PAGE_SIZE);
      const pageRoots = new Set(page.map((record) => record.resolvedRootId));
      const extras = ranked.filter(
        (record) =>
          pageRoots.has(record.resolvedRootId) &&
          (metadata.get(record.id)?.position ?? 1) > 2,
      );
      const storyClusters = [...pageRoots]
        .map((rootId) => {
          const items = extras.filter((item) => item.resolvedRootId === rootId);
          const size = ranked.filter(
            (item) => item.resolvedRootId === rootId,
          ).length;
          return { rootId, items, size };
        })
        .filter((cluster) => cluster.items.length > 0)
        .map((cluster) => {
          if (cluster.items.length > 100) {
            throw new KnowledgeReaderError("RESULT_WINDOW_EXCEEDED");
          }
          return {
            resolved_root_id: cluster.rootId,
            total_count: cluster.size,
            items: cluster.items.map((item) =>
              feedItem(item, metadata.get(item.id) ?? { position: 1, size: 1 }),
            ),
          };
        });
      const hasMore = remaining.length > page.length;
      const last = page.at(-1);
      return {
        schema_version: "knowledge-feed.v1",
        kind: input.kind,
        items: page.map((item) =>
          feedItem(item, metadata.get(item.id) ?? { position: 1, size: 1 }),
        ),
        story_clusters: storyClusters,
        next_cursor:
          hasMore && last !== undefined
            ? encodeCursor(
                { v: CURSOR_VERSION, scope, cutoff, after_id: last.id },
                secret,
              )
            : null,
      };
    },

    async getComment(rawId) {
      const id = asHnId(rawId);
      const comment = await repository.getAvailableComment(id);
      if (comment === null) {
        throw new KnowledgeReaderError("NOT_FOUND");
      }
      const records = await published({
        kind: null,
        selectedCommentId: id,
        resolvedRootId: null,
        subjectId: null,
        limit: REPOSITORY_LIMIT,
      });
      const ranked = rankPublishedContent(records);
      const metadata = clusterMetadata(ranked);
      return {
        schema_version: "reader-comment.v1",
        id: comment.id,
        status: "AVAILABLE",
        author: comment.author,
        body_html: renderReaderSafeHtml(comment.canonicalHtml),
        body_text: comment.canonicalText,
        created_at: comment.createdAt?.toISOString() ?? null,
        resolved_root_id: comment.resolvedRootId,
        displayed_story_id: comment.displayedStoryId,
        source_occurrence_ids: [...new Set(comment.sourceOccurrenceIds)].sort(),
        subjects: uniqueSubjects(ranked),
        items: ranked.map((item) =>
          feedItem(item, metadata.get(item.id) ?? { position: 1, size: 1 }),
        ),
      };
    },

    async getStory(rawId) {
      const id = asHnId(rawId);
      const story = await repository.getAvailableStory(id);
      if (story === null) {
        throw new KnowledgeReaderError("NOT_FOUND");
      }
      const records = await published({
        kind: null,
        selectedCommentId: null,
        resolvedRootId: id,
        subjectId: null,
        limit: REPOSITORY_LIMIT,
      });
      const ranked = rankPublishedContent(records);
      const metadata = clusterMetadata(ranked);
      return {
        schema_version: "reader-story.v1",
        id: story.id,
        status: "AVAILABLE",
        title: story.title,
        author: story.author,
        body_html: renderReaderSafeHtml(story.canonicalHtml),
        body_text: story.canonicalText,
        url: redactReaderUrl(story.url),
        created_at: story.createdAt?.toISOString() ?? null,
        subjects: uniqueSubjects(ranked),
        items: ranked.map((item) =>
          feedItem(item, metadata.get(item.id) ?? { position: 1, size: 1 }),
        ),
      };
    },

    async getSubject(rawId) {
      const id = asSubjectId(rawId);
      const subject = await repository.getActiveSubject(id);
      if (subject === null) {
        throw new KnowledgeReaderError("NOT_FOUND");
      }
      const records = await published({
        kind: null,
        selectedCommentId: null,
        resolvedRootId: null,
        subjectId: id,
        limit: REPOSITORY_LIMIT,
      });
      return {
        schema_version: "reader-subject.v1",
        id: subject.id,
        status: "ACTIVE",
        name: subject.name,
        type: subject.type,
        aliases: [...new Set(subject.aliases)].sort(),
        canonical_url: redactReaderUrl(subject.canonicalUrl),
        created_at: subject.createdAt.toISOString(),
        updated_at: subject.updatedAt.toISOString(),
        discovery_count: records.filter((item) => item.kind === "discovery")
          .length,
        expert_note_count: records.filter((item) => item.kind === "expert_note")
          .length,
      };
    },

    async getSubjectNotes(input) {
      const id = asSubjectId(input.subjectId);
      const subject = await repository.getActiveSubject(id);
      if (subject === null) {
        throw new KnowledgeReaderError("NOT_FOUND");
      }
      const scope = `subject:${id}:notes`;
      const cursor =
        input.cursor === null
          ? null
          : decodeCursor(input.cursor, scope, secret);
      const cutoff = cursor?.cutoff ?? now().toISOString();
      const records = (
        await published({
          kind: "expert_note",
          selectedCommentId: null,
          resolvedRootId: null,
          subjectId: id,
          limit: REPOSITORY_LIMIT,
        })
      ).filter(
        (record): record is ReaderExpertNoteRecord =>
          record.kind === "expert_note" &&
          record.publishedAt.toISOString() <= cutoff,
      );
      const ranked = rankPublishedContent(records);
      const metadata = clusterMetadata(ranked);
      const remaining = pageAfter(ranked, cursor?.after_id ?? null);
      const page = remaining.slice(0, PAGE_SIZE);
      const last = page.at(-1);
      return {
        schema_version: "reader-subject-notes.v1",
        subject: subjectLink(subject),
        items: page.map(
          (item) =>
            feedItem(
              item,
              metadata.get(item.id) ?? { position: 1, size: 1 },
            ) as Extract<FeedItemV1, { readonly kind: "expert_note" }>,
        ),
        next_cursor:
          remaining.length > page.length && last !== undefined
            ? encodeCursor(
                { v: CURSOR_VERSION, scope, cutoff, after_id: last.id },
                secret,
              )
            : null,
      };
    },
  };
};

export const KNOWLEDGE_READER_MAX_PUBLISHED_RECORDS = MAX_PUBLISHED_RECORDS;
