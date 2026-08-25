import { describe, expect, it, vi } from "vitest";

import {
  createKnowledgeReader,
  KnowledgeReaderError,
  rankPublishedContent,
  redactReaderUrl,
  renderReaderSafeHtml,
  type KnowledgeReader,
} from "@hn-knowledge/application";
import { isKnowledgeFeedV1, isReaderSubjectV1 } from "@hn-knowledge/contracts";
import { hnItemId, subjectId } from "@hn-knowledge/domain";
import type {
  KnowledgeReaderRepository,
  ReaderContentFilter,
  ReaderContentRecord,
} from "@hn-knowledge/ports";
import { createApp, type SafeLogger } from "@hn-knowledge/api";

const publishedAt = new Date("2026-08-26T12:00:00.000Z");
const subjectUuid = "00000000-0000-4000-8000-000000000111";
const token = "reader-test-token";
const logger: SafeLogger = { error: vi.fn() };

const discovery = (
  id: string,
  rootId: number,
  confidence: number,
): ReaderContentRecord => ({
  id,
  kind: "discovery",
  title: `Subject ${id.slice(-2)}`,
  summary: "A grounded discovery summary.",
  confidence,
  subjects: [{ id: subjectUuid, name: "Example", type: "TOOL" }],
  evidence: [
    {
      origin: "COMMENT",
      hnItemId: hnItemId(100),
      start: 0,
      end: 8,
      excerpt: "Evidence",
    },
  ],
  selectedCommentId: hnItemId(100),
  resolvedRootId: hnItemId(rootId),
  displayedStoryId: hnItemId(rootId),
  sourceOccurrenceIds: ["00000000-0000-4000-8000-000000000222"],
  publishedAt,
  updatedAt: publishedAt,
  reviewRevision: 1,
  publicationRevision: 1,
});

const records = [
  discovery("00000000-0000-4000-8000-000000000001", 10, 1),
  discovery("00000000-0000-4000-8000-000000000002", 10, 0.9),
  discovery("00000000-0000-4000-8000-000000000003", 10, 0.8),
  discovery("00000000-0000-4000-8000-000000000004", 20, 0.95),
] as const;

const repository = (
  content: readonly ReaderContentRecord[] = records,
): KnowledgeReaderRepository => ({
  listPublishedContent: vi.fn(async (filter: ReaderContentFilter) =>
    content.filter((item) => filter.kind === null || item.kind === filter.kind),
  ),
  getAvailableComment: vi.fn(async () => null),
  getAvailableStory: vi.fn(async () => null),
  getActiveSubject: vi.fn(async () => ({
    id: subjectId(subjectUuid),
    name: "Example",
    type: "TOOL" as const,
    aliases: ["Example CLI"],
    canonicalUrl: "https://example.com/tool?private=1#fragment",
    createdAt: publishedAt,
    updatedAt: publishedAt,
  })),
});

describe("knowledge reader", () => {
  it("applies the story saturation factor deterministically", () => {
    const ranked = rankPublishedContent(records);

    expect(ranked.map((item) => item.id)).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000004",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
    ]);
  });

  it("keeps at most two same-root items in the main feed and exposes extras in a cluster", async () => {
    const reader = createKnowledgeReader(repository(), {
      cursorSecret: "unit-test-cursor-secret",
      now: () => publishedAt,
    });

    const feed = await reader.getFeed({ kind: "discovery", cursor: null });

    expect(
      feed.items.filter((item) => item.resolved_root_id === 10),
    ).toHaveLength(2);
    expect(feed.story_clusters).toEqual([
      expect.objectContaining({
        resolved_root_id: 10,
        total_count: 3,
        items: [expect.objectContaining({ cluster_position: 3 })],
      }),
    ]);
    expect(isKnowledgeFeedV1(feed)).toBe(true);
    expect(JSON.stringify(feed)).not.toMatch(
      /provider_output|prompt|token|session|raw_url/iu,
    );
  });

  it("signs cursors and rejects tampering or cross-scope reuse", async () => {
    const many = Array.from({ length: 21 }, (_, index) =>
      discovery(
        `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        1_000 + index,
        1 - index / 100,
      ),
    );
    const reader = createKnowledgeReader(repository(many), {
      cursorSecret: "unit-test-cursor-secret",
      now: () => publishedAt,
    });
    const first = await reader.getFeed({ kind: "discovery", cursor: null });
    expect(first.next_cursor).not.toBeNull();

    await expect(
      reader.getFeed({
        kind: "discovery",
        cursor: `${first.next_cursor?.slice(0, -1)}x`,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    await expect(
      reader.getFeed({ kind: "expert_note", cursor: first.next_cursor }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });

  it("does not use notes as a subject description and redacts URL queries", async () => {
    const reader = createKnowledgeReader(repository(), {
      cursorSecret: "unit-test-cursor-secret",
      now: () => publishedAt,
    });

    const subject = await reader.getSubject(subjectUuid);

    expect(subject).not.toHaveProperty("description");
    expect(subject.canonical_url).toBe("https://example.com/tool");
    expect(isReaderSubjectV1(subject)).toBe(true);
  });

  it("renders only safe HN HTML links with defensive rel attributes", () => {
    const html = renderReaderSafeHtml(
      '<p>Hello <a href="https://example.com/path?q=1">world</a> <a href="javascript:alert(1)">bad</a><script>secret</script></p>',
    );

    expect(html).toBe(
      '<p>Hello <a href="https://example.com/path?q=1" rel="noopener noreferrer nofollow">world</a> bad</p>',
    );
    expect(redactReaderUrl("https://example.com/path?q=secret#token")).toBe(
      "https://example.com/path",
    );
  });
});

describe("reader routes", () => {
  const fakeReader = (): KnowledgeReader => ({
    getFeed: vi.fn(async () => ({
      schema_version: "knowledge-feed.v1" as const,
      kind: "discovery" as const,
      items: [],
      story_clusters: [],
      next_cursor: null,
    })),
    getComment: vi.fn(async () => {
      throw new KnowledgeReaderError("NOT_FOUND");
    }),
    getStory: vi.fn(async () => {
      throw new KnowledgeReaderError("NOT_FOUND");
    }),
    getSubject: vi.fn(async () => {
      throw new KnowledgeReaderError("NOT_FOUND");
    }),
    getSubjectNotes: vi.fn(async () => {
      throw new KnowledgeReaderError("NOT_FOUND");
    }),
  });

  it("protects every reader endpoint with bearer authentication", async () => {
    const reader = fakeReader();
    const app = createApp({ apiToken: token, logger, knowledgeReader: reader });

    for (const path of [
      "/v1/feed?kind=discovery",
      "/v1/comments/1",
      "/v1/stories/1",
      `/v1/subjects/${subjectUuid}`,
      `/v1/subjects/${subjectUuid}/notes`,
    ]) {
      expect((await app.request(path)).status).toBe(401);
    }
    expect(reader.getFeed).not.toHaveBeenCalled();
  });

  it("rejects malformed IDs and unexpected query fields", async () => {
    const reader = fakeReader();
    const app = createApp({ apiToken: token, logger, knowledgeReader: reader });
    const headers = { authorization: `Bearer ${token}` };

    expect((await app.request("/v1/comments/1e3", { headers })).status).toBe(
      400,
    );
    expect(
      (
        await app.request("/v1/feed?kind=discovery&limit=1000", {
          headers,
        })
      ).status,
    ).toBe(400);
    expect(reader.getComment).not.toHaveBeenCalled();
    expect(reader.getFeed).not.toHaveBeenCalled();
  });
});
