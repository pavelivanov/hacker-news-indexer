import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  TelegramDeferredError,
  TelegramMtprotoSource,
  TelegramRetryExhaustedError,
  type TelegramMessageRecord,
  type TelegramMessagesClient,
} from "@hn-knowledge/adapters";
import { telegramMessageId, type IngestionRange } from "@hn-knowledge/domain";

const hasher = {
  sha256: (value: string) => createHash("sha256").update(value).digest("hex"),
};

const range = (minId: number, maxId: number): IngestionRange => ({
  source: "TELEGRAM",
  sourceKey: "hn_best_comments",
  minId: telegramMessageId(minId),
  maxId: telegramMessageId(maxId),
});

const collect = async (
  source: TelegramMtprotoSource,
  input: IngestionRange,
) => {
  const values = [];
  for await (const value of source.readRange(input)) {
    values.push(value);
  }
  return values;
};

const message = (
  id: number,
  overrides: Partial<TelegramMessageRecord> = {},
): TelegramMessageRecord => ({
  id,
  date: new Date(`2026-08-24T12:00:${String(id).padStart(2, "0")}.000Z`),
  editDate: null,
  text: `message ${id}`,
  entities: [],
  ...overrides,
});

describe("Telegram exact-ID ingestion", () => {
  it("reconciles an inclusive range in ID order and makes gaps explicit", async () => {
    const editedAt = new Date("2026-08-24T13:00:00.000Z");
    const client: TelegramMessagesClient = {
      getMessages: vi.fn(async () => [
        message(12),
        null,
        message(10, { editDate: editedAt }),
      ]),
    };
    const source = new TelegramMtprotoSource(client, { hasher });

    const occurrences = await collect(source, range(10, 12));

    expect(occurrences.map((value) => value.externalId)).toEqual([10, 11, 12]);
    expect(occurrences[0]).toMatchObject({
      status: "OBSERVED",
      editedAt,
    });
    expect(occurrences[1]).toMatchObject({
      status: "MISSING",
      occurredAt: null,
      text: null,
    });
    expect(client.getMessages).toHaveBeenCalledWith(
      "hn_best_comments",
      [10, 11, 12],
    );
  });

  it("parses HN entity roles, UTF-16 offsets, hashes, and multipart markers", async () => {
    const text = "🚀 Story selected Part 1/2";
    const storyOffset = text.indexOf("Story");
    const selectedOffset = text.indexOf("selected");
    const client: TelegramMessagesClient = {
      getMessages: vi.fn(async () => [
        message(20, {
          text,
          entities: [
            {
              kind: "text_link",
              offset: storyOffset,
              length: "Story".length,
              url: "https://news.ycombinator.com/item?id=111",
            },
            {
              kind: "text_link",
              offset: selectedOffset,
              length: "selected".length,
              url: "https://news.ycombinator.com/item?id=222",
            },
          ],
        }),
      ]),
    };
    const source = new TelegramMtprotoSource(client, { hasher });

    const [occurrence] = await collect(source, range(20, 20));

    expect(occurrence).toMatchObject({
      contentHash: hasher.sha256(text),
      multipart: { part: 1, total: 2 },
      references: [
        {
          itemId: 111,
          role: "DISPLAYED_STORY_REFERENCE",
          entityOffset: storyOffset,
        },
        {
          itemId: 222,
          role: "SELECTED_COMMENT",
          entityOffset: selectedOffset,
        },
      ],
    });
  });

  it("does not confuse body fractions with a trailing multipart marker", async () => {
    const client: TelegramMessagesClient = {
      getMessages: vi.fn(async () => [
        message(21, {
          text: "Dates 4/4, 6/6, and 8/8 are memorable.\n\nauthor, now [1/2]",
        }),
      ]),
    };
    const source = new TelegramMtprotoSource(client, { hasher });

    const [occurrence] = await collect(source, range(21, 21));

    expect(occurrence?.multipart).toEqual({ part: 1, total: 2 });
  });

  it("is deterministic when the same source records are replayed", async () => {
    const record = message(30);
    const client: TelegramMessagesClient = {
      getMessages: vi.fn(async () => [record]),
    };
    const source = new TelegramMtprotoSource(client, { hasher });

    const first = await collect(source, range(30, 30));
    const second = await collect(source, range(30, 30));

    expect(second).toEqual(first);
  });

  it("honors bounded flood waits before retrying", async () => {
    const flood = Object.assign(new Error("FLOOD_WAIT_2"), { seconds: 2 });
    const getMessages = vi
      .fn<TelegramMessagesClient["getMessages"]>()
      .mockRejectedValueOnce(flood)
      .mockResolvedValueOnce([message(40)]);
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const source = new TelegramMtprotoSource(
      { getMessages },
      {
        hasher,
        sleeper: { sleep },
        random: { fraction: () => 0.5 },
        maxFloodWaitMs: 2_000,
      },
    );

    await expect(collect(source, range(40, 40))).resolves.toHaveLength(1);
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(getMessages).toHaveBeenCalledTimes(2);
  });

  it("defers flood waits above the configured ceiling", async () => {
    const flood = Object.assign(new Error("FLOOD_WAIT_31"), { seconds: 31 });
    const source = new TelegramMtprotoSource(
      { getMessages: vi.fn(async () => Promise.reject(flood)) },
      { hasher, maxFloodWaitMs: 30_000 },
    );

    await expect(collect(source, range(50, 50))).rejects.toMatchObject({
      name: TelegramDeferredError.name,
      waitMilliseconds: 31_000,
    });
  });

  it("uses three retries and reports retry exhaustion", async () => {
    const getMessages = vi
      .fn<TelegramMessagesClient["getMessages"]>()
      .mockRejectedValue(
        Object.assign(new Error("server error"), { code: 503 }),
      );
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const source = new TelegramMtprotoSource(
      { getMessages },
      {
        hasher,
        sleeper: { sleep },
        random: { fraction: () => 0.5 },
        retryBaseMs: 10,
      },
    );

    await expect(collect(source, range(60, 60))).rejects.toBeInstanceOf(
      TelegramRetryExhaustedError,
    );
    expect(getMessages).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([10, 20, 40]);
  });
});
