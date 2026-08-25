import {
  HnResolutionError,
  type HnFetchResult,
  type HnItem,
  type HnItemId,
  type ResolvedHnComment,
} from "@hn-knowledge/domain";
import type { HnItems } from "@hn-knowledge/ports";

const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_RESOLVER_VERSION = "parent-chain-v1";

export interface ResolveHnCommentInput {
  readonly selectedCommentId: HnItemId;
  readonly displayedStoryId: HnItemId | null;
}

export interface HnResolutionTelemetry {
  readonly cacheHit: () => void;
  readonly resolved: (input: {
    readonly depth: number;
    readonly displayedRootMismatch: boolean;
  }) => void;
}

export class HnParentChainResolver {
  private readonly cache = new Map<number, Promise<HnFetchResult>>();

  constructor(
    private readonly items: HnItems,
    private readonly maxDepth = DEFAULT_MAX_DEPTH,
    private readonly resolverVersion = DEFAULT_RESOLVER_VERSION,
    private readonly telemetry: HnResolutionTelemetry | null = null,
  ) {
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
      throw new TypeError("maxDepth must be a positive safe integer");
    }
  }

  private get(id: HnItemId): Promise<HnFetchResult> {
    const key = Number(id);
    const existing = this.cache.get(key);
    if (existing !== undefined) {
      this.telemetry?.cacheHit();
      return existing;
    }
    const pending = this.items.get(id);
    this.cache.set(key, pending);
    return pending;
  }

  private async requiredItem(
    id: HnItemId,
    missingCode: "SELECTED_ITEM_MISSING" | "PARENT_MISSING",
  ): Promise<HnItem> {
    const fetched = await this.get(id);
    if (fetched.kind === "MISSING") {
      throw new HnResolutionError(
        missingCode,
        `Required HN item ${id} is missing`,
      );
    }
    return fetched.item;
  }

  async resolve(input: ResolveHnCommentInput): Promise<ResolvedHnComment> {
    const selected = await this.requiredItem(
      input.selectedCommentId,
      "SELECTED_ITEM_MISSING",
    );
    if (selected.type !== "comment") {
      throw new HnResolutionError(
        "SELECTED_ITEM_NOT_COMMENT",
        `Selected HN item ${selected.id} is not a comment`,
      );
    }

    const fetchedItems: HnItem[] = [selected];
    const ancestorIds: HnItemId[] = [];
    const visited = new Set<number>([Number(selected.id)]);
    let current = selected;

    while (current.parentId !== null) {
      if (ancestorIds.length >= this.maxDepth) {
        throw new HnResolutionError(
          "PARENT_DEPTH_EXCEEDED",
          `HN parent chain exceeds ${this.maxDepth}`,
        );
      }
      const parentId = current.parentId;
      if (visited.has(Number(parentId))) {
        throw new HnResolutionError(
          "PARENT_CYCLE",
          `HN parent chain contains a cycle at ${parentId}`,
        );
      }
      visited.add(Number(parentId));
      const parent = await this.requiredItem(parentId, "PARENT_MISSING");
      ancestorIds.push(parent.id);
      fetchedItems.push(parent);
      current = parent;
    }

    if (current.type !== "story" && current.type !== "poll") {
      throw new HnResolutionError(
        "INVALID_ROOT_TYPE",
        `HN root ${current.id} has invalid type ${current.type}`,
      );
    }

    const result = {
      selectedItem: selected,
      rootItem: current,
      fetchedItems,
      path: {
        selectedCommentId: selected.id,
        ancestorIds,
        displayedStoryId: input.displayedStoryId,
        resolvedRootId: current.id,
        resolverVersion: this.resolverVersion,
      },
    };
    this.telemetry?.resolved({
      depth: ancestorIds.length,
      displayedRootMismatch:
        input.displayedStoryId !== null &&
        input.displayedStoryId !== current.id,
    });
    return result;
  }
}
