import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  HackerNewsApiItems,
  HnRetryExhaustedError,
  type HttpFetch,
} from "@hn-knowledge/adapters";
import { hnItemId } from "@hn-knowledge/domain";

const fetchedAt = new Date("2026-08-24T12:00:00.000Z");
const clock = { now: () => fetchedAt };
const hasher = {
  sha256: (value: string) => createHash("sha256").update(value).digest("hex"),
};
const noDelay = { sleep: async (_milliseconds: number) => undefined };
const noJitter = { fraction: () => 0.5 };

const response = (body: string, status = 200): Response =>
  new Response(body, { status });

describe("official HN item adapter", () => {
  it("fetches only the requested item endpoint and tolerates extra fields", async () => {
    const fetcher = vi.fn<HttpFetch>(async () =>
      response(
        JSON.stringify({
          id: 123,
          type: "comment",
          parent: 100,
          by: "alice",
          time: 1_700_000_000,
          text: "hello",
          kids: [124, 125],
          future_field: true,
        }),
      ),
    );
    const items = new HackerNewsApiItems({
      fetch: fetcher,
      clock,
      hasher,
      sleeper: noDelay,
    });

    const result = await items.get(hnItemId(123));

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "https://hacker-news.firebaseio.com/v0/item/123.json",
    );
    expect(result).toMatchObject({
      kind: "ITEM",
      item: {
        id: 123,
        type: "comment",
        parentId: 100,
        author: "alice",
        availability: "AVAILABLE",
        fetchedAt,
      },
    });
    expect(JSON.stringify(result)).not.toContain("kids");
  });

  it("delays and confirms a 200 null before marking an item missing", async () => {
    const fetcher = vi.fn<HttpFetch>(async () => response("null"));
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const items = new HackerNewsApiItems({
      fetch: fetcher,
      clock,
      hasher,
      sleeper: { sleep },
      nullConfirmationDelayMs: 321,
    });

    const result = await items.get(hnItemId(404));

    expect(result).toEqual({
      kind: "MISSING",
      id: 404,
      fetchedAt,
      responseHash: hasher.sha256("null"),
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(321);
  });

  it("can recover when the delayed null confirmation returns an item", async () => {
    const fetcher = vi
      .fn<HttpFetch>()
      .mockResolvedValueOnce(response("null"))
      .mockResolvedValueOnce(
        response(JSON.stringify({ id: 50, type: "story", title: "ready" })),
      );
    const items = new HackerNewsApiItems({
      fetch: fetcher,
      clock,
      hasher,
      sleeper: noDelay,
    });

    await expect(items.get(hnItemId(50))).resolves.toMatchObject({
      kind: "ITEM",
      item: { id: 50, type: "story", title: "ready" },
    });
  });

  it("keeps timeout failures distinct from missing items", async () => {
    const fetcher: HttpFetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    const items = new HackerNewsApiItems({
      fetch: fetcher,
      clock,
      hasher,
      sleeper: noDelay,
      timeoutMs: 5,
      retryCount: 0,
    });

    await expect(items.get(hnItemId(60))).rejects.toBeInstanceOf(
      HnRetryExhaustedError,
    );
  });

  it("retries 429 and 5xx responses three times with exponential backoff", async () => {
    const fetcher = vi
      .fn<HttpFetch>()
      .mockResolvedValueOnce(response("busy", 500))
      .mockResolvedValueOnce(response("busy", 429))
      .mockResolvedValueOnce(response("busy", 503))
      .mockResolvedValueOnce(
        response(JSON.stringify({ id: 70, type: "story" })),
      );
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const items = new HackerNewsApiItems({
      fetch: fetcher,
      clock,
      hasher,
      sleeper: { sleep },
      random: noJitter,
      retryBaseMs: 10,
    });

    await expect(items.get(hnItemId(70))).resolves.toMatchObject({
      kind: "ITEM",
    });
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([10, 20, 40]);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([
    [{ deleted: true }, "DELETED"],
    [{ dead: true }, "DEAD"],
  ] as const)(
    "maps tombstone flags to %s availability",
    async (flag, expected) => {
      const fetcher: HttpFetch = async () =>
        response(JSON.stringify({ id: 80, type: "comment", ...flag }));
      const items = new HackerNewsApiItems({
        fetch: fetcher,
        clock,
        hasher,
        sleeper: noDelay,
      });

      await expect(items.get(hnItemId(80))).resolves.toMatchObject({
        kind: "ITEM",
        item: { availability: expected },
      });
    },
  );
});
