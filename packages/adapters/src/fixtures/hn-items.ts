import type { HnFetchResult, HnItem, HnItemId } from "@hn-knowledge/domain";
import { HN_ITEM_TYPES, hnItemId } from "@hn-knowledge/domain";
import type { HnItems } from "@hn-knowledge/ports";

export interface HnFixtureItem {
  readonly id: number;
  readonly type?: string;
  readonly parent?: number;
  readonly by?: string;
  readonly time?: number;
  readonly title?: string;
  readonly text?: string;
  readonly url?: string;
  readonly deleted?: boolean;
  readonly dead?: boolean;
  readonly responseHash: string;
}

export interface HnFixture {
  readonly capturedAt: string;
  readonly items: readonly HnFixtureItem[];
}

export class FixtureHnItems implements HnItems {
  private readonly items: ReadonlyMap<number, HnFixtureItem>;
  private readonly fetchedAt: Date;
  readonly requestedIds: number[] = [];

  constructor(fixture: HnFixture) {
    this.items = new Map(fixture.items.map((item) => [item.id, item]));
    this.fetchedAt = new Date(fixture.capturedAt);
    if (Number.isNaN(this.fetchedAt.getTime())) {
      throw new TypeError("HN fixture capturedAt must be an ISO timestamp");
    }
  }

  get(id: HnItemId): Promise<HnFetchResult> {
    this.requestedIds.push(Number(id));
    const item = this.items.get(Number(id));
    if (item === undefined) {
      return Promise.resolve({
        kind: "MISSING",
        id,
        fetchedAt: this.fetchedAt,
        responseHash: "fixture-missing",
      });
    }
    if (
      item.type === undefined ||
      !HN_ITEM_TYPES.includes(item.type as HnItem["type"])
    ) {
      throw new TypeError(`HN fixture item ${item.id} has an invalid type`);
    }
    return Promise.resolve({
      kind: "ITEM",
      item: {
        id: hnItemId(item.id),
        type: item.type as HnItem["type"],
        parentId: item.parent === undefined ? null : hnItemId(item.parent),
        author: item.by ?? null,
        time: item.time === undefined ? null : new Date(item.time * 1_000),
        title: item.title ?? null,
        textHtml: item.text ?? null,
        url: item.url ?? null,
        availability: item.deleted
          ? "DELETED"
          : item.dead
            ? "DEAD"
            : "AVAILABLE",
        fetchedAt: this.fetchedAt,
        responseHash: item.responseHash,
      },
    });
  }
}
