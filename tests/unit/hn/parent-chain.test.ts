import { describe, expect, it, vi } from "vitest";

import { HnParentChainResolver } from "@hn-knowledge/application";
import {
  HnResolutionError,
  hnItemId,
  type HnFetchResult,
  type HnItem,
  type HnItemId,
} from "@hn-knowledge/domain";
import type { HnItems } from "@hn-knowledge/ports";

const now = new Date("2026-08-24T12:00:00.000Z");

const item = (
  id: number,
  type: HnItem["type"],
  parentId: number | null,
  availability: HnItem["availability"] = "AVAILABLE",
): HnItem => ({
  id: hnItemId(id),
  type,
  parentId: parentId === null ? null : hnItemId(parentId),
  author: null,
  time: null,
  title: null,
  textHtml: type === "comment" ? `comment ${id}` : null,
  url: null,
  availability,
  fetchedAt: now,
  responseHash: `hash-${id}`,
});

const source = (
  values: readonly HnItem[],
  missing: readonly number[] = [],
): { readonly items: HnItems; readonly requests: number[] } => {
  const records = new Map(values.map((value) => [Number(value.id), value]));
  const requests: number[] = [];
  return {
    requests,
    items: {
      async get(id: HnItemId): Promise<HnFetchResult> {
        requests.push(Number(id));
        const value = records.get(Number(id));
        if (value === undefined || missing.includes(Number(id))) {
          return {
            kind: "MISSING",
            id,
            fetchedAt: now,
            responseHash: "missing",
          };
        }
        return { kind: "ITEM", item: value };
      },
    },
  };
};

describe("HN parent-chain resolver", () => {
  it("follows only the selected comment's ordered parent chain", async () => {
    const fixture = source([
      item(300, "comment", 200),
      item(200, "comment", 100),
      item(100, "story", null),
      item(201, "comment", 100),
    ]);
    const resolver = new HnParentChainResolver(fixture.items);

    const resolved = await resolver.resolve({
      selectedCommentId: hnItemId(300),
      displayedStoryId: hnItemId(100),
    });

    expect(resolved.path).toMatchObject({
      selectedCommentId: 300,
      ancestorIds: [200, 100],
      displayedStoryId: 100,
      resolvedRootId: 100,
    });
    expect(fixture.requests).toEqual([300, 200, 100]);
    expect(fixture.requests).not.toContain(201);
  });

  it.each([901, 902, 903, 904, 905])(
    "preserves displayed/current-root mismatch %i",
    async (displayedId) => {
      const fixture = source([
        item(10, "comment", 11),
        item(11, "story", null),
      ]);
      const resolver = new HnParentChainResolver(fixture.items);

      const resolved = await resolver.resolve({
        selectedCommentId: hnItemId(10),
        displayedStoryId: hnItemId(displayedId),
      });

      expect(resolved.path.displayedStoryId).toBe(displayedId);
      expect(resolved.path.resolvedRootId).toBe(11);
    },
  );

  it("accepts deleted comments and dead story roots as tombstones", async () => {
    const fixture = source([
      item(20, "comment", 21, "DELETED"),
      item(21, "story", null, "DEAD"),
    ]);
    const resolver = new HnParentChainResolver(fixture.items);

    const resolved = await resolver.resolve({
      selectedCommentId: hnItemId(20),
      displayedStoryId: hnItemId(21),
    });

    expect(resolved.selectedItem.availability).toBe("DELETED");
    expect(resolved.rootItem.availability).toBe("DEAD");
  });

  it("rejects cycles before requesting an item twice", async () => {
    const fixture = source([item(30, "comment", 31), item(31, "comment", 30)]);
    const resolver = new HnParentChainResolver(fixture.items);

    await expect(
      resolver.resolve({
        selectedCommentId: hnItemId(30),
        displayedStoryId: null,
      }),
    ).rejects.toMatchObject({ code: "PARENT_CYCLE" });
    expect(fixture.requests).toEqual([30, 31]);
  });

  it("rejects a chain deeper than 64 ancestors", async () => {
    const chain = Array.from({ length: 66 }, (_, index) =>
      item(
        1_000 + index,
        index === 65 ? "story" : "comment",
        1_000 + index + 1,
      ),
    );
    chain[65] = item(1_065, "story", null);
    const fixture = source(chain);
    const resolver = new HnParentChainResolver(fixture.items);

    await expect(
      resolver.resolve({
        selectedCommentId: hnItemId(1_000),
        displayedStoryId: null,
      }),
    ).rejects.toMatchObject({ code: "PARENT_DEPTH_EXCEEDED" });
    expect(fixture.requests).toHaveLength(65);
  });

  it.each([
    [[], 40, "SELECTED_ITEM_MISSING"],
    [[item(40, "story", null)], 40, "SELECTED_ITEM_NOT_COMMENT"],
    [[item(40, "comment", 41)], 40, "PARENT_MISSING"],
  ] as const)(
    "reports deterministic resolution failures",
    async (values, id, code) => {
      const fixture = source(values);
      const resolver = new HnParentChainResolver(fixture.items);

      await expect(
        resolver.resolve({
          selectedCommentId: hnItemId(id),
          displayedStoryId: null,
        }),
      ).rejects.toMatchObject({ name: HnResolutionError.name, code });
    },
  );

  it("single-flights shared ancestors across concurrent resolutions", async () => {
    const values = new Map([
      [50, item(50, "comment", 60)],
      [51, item(51, "comment", 60)],
      [60, item(60, "comment", 70)],
      [70, item(70, "story", null)],
    ]);
    const get = vi.fn(async (id: HnItemId): Promise<HnFetchResult> => {
      await Promise.resolve();
      const value = values.get(Number(id));
      if (value === undefined) {
        throw new Error("unexpected request");
      }
      return { kind: "ITEM", item: value };
    });
    const resolver = new HnParentChainResolver({ get });

    await Promise.all([
      resolver.resolve({
        selectedCommentId: hnItemId(50),
        displayedStoryId: null,
      }),
      resolver.resolve({
        selectedCommentId: hnItemId(51),
        displayedStoryId: null,
      }),
    ]);

    expect(get).toHaveBeenCalledTimes(4);
    expect(get.mock.calls.filter(([id]) => id === 60)).toHaveLength(1);
    expect(get.mock.calls.filter(([id]) => id === 70)).toHaveLength(1);
  });
});
