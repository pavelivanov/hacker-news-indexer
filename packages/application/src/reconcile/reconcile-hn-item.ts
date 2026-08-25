import {
  HnResolutionError,
  type HnFetchResult,
  type HnItemId,
  type SelectedComment,
} from "@hn-knowledge/domain";
import type {
  Hasher,
  HnItems,
  HnReconciliationRepository,
  HnReconciliationResult,
  ReconciliationScheduleResult,
} from "@hn-knowledge/ports";

import { normalizeHnCommentHtml } from "../normalize/hn-html.js";
import { HnParentChainResolver } from "../resolve-hn/parent-chain.js";

export class HnReconciliationError extends Error {
  constructor(
    readonly code:
      "RECONCILIATION_TARGET_NOT_FOUND" | "RECONCILIATION_ITEM_NOT_COMMENT",
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "HnReconciliationError";
  }
}

export type ReconcileHnItem = (
  selectedCommentId: HnItemId,
) => Promise<HnReconciliationResult>;

const primedItems = (
  selectedCommentId: HnItemId,
  selected: HnFetchResult,
  items: HnItems,
): HnItems => ({
  get: (id) =>
    Number(id) === Number(selectedCommentId)
      ? Promise.resolve(selected)
      : items.get(id),
});

export const createReconcileHnItem =
  (
    items: HnItems,
    repository: HnReconciliationRepository,
    hasher: Hasher,
  ): ReconcileHnItem =>
  async (selectedCommentId) => {
    const target = await repository.loadTarget(selectedCommentId);
    if (target === null) {
      throw new HnReconciliationError("RECONCILIATION_TARGET_NOT_FOUND");
    }
    const fetched = await items.get(selectedCommentId);
    if (fetched.kind === "MISSING") {
      return repository.tombstone({
        selectedCommentId,
        availability: "MISSING",
        responseHash: fetched.responseHash,
        fetchedAt: fetched.fetchedAt,
        item: null,
        idempotencyKey: `reconcile:${selectedCommentId}:${fetched.responseHash}:missing`,
      });
    }
    if (fetched.item.type !== "comment") {
      throw new HnReconciliationError("RECONCILIATION_ITEM_NOT_COMMENT");
    }
    if (fetched.item.availability !== "AVAILABLE") {
      return repository.tombstone({
        selectedCommentId,
        availability: fetched.item.availability,
        responseHash: fetched.item.responseHash,
        fetchedAt: fetched.item.fetchedAt,
        item: fetched.item,
        idempotencyKey: `reconcile:${selectedCommentId}:${fetched.item.responseHash}:${fetched.item.availability.toLowerCase()}`,
      });
    }

    const resolver = new HnParentChainResolver(
      primedItems(selectedCommentId, fetched, items),
    );
    let resolved;
    try {
      resolved = await resolver.resolve({
        selectedCommentId,
        displayedStoryId: target.displayedStoryId,
      });
    } catch (error) {
      if (error instanceof HnResolutionError) {
        throw new HnReconciliationError("RECONCILIATION_TARGET_NOT_FOUND", {
          cause: error,
        });
      }
      throw error;
    }
    const normalized = normalizeHnCommentHtml(
      resolved.selectedItem.textHtml ?? "",
      `hn:item:${selectedCommentId}`,
      hasher,
    );
    const selected: SelectedComment = {
      id: selectedCommentId,
      rootId: resolved.rootItem.id,
      canonicalHtml: normalized.canonicalHtml,
      canonicalText: normalized.canonicalText,
      contentHash: normalized.contentHash,
      availability: resolved.selectedItem.availability,
      firstSeenAt: resolved.selectedItem.fetchedAt,
      lastSeenAt: resolved.selectedItem.fetchedAt,
    };
    const reconciliationHash = hasher.sha256(
      JSON.stringify({
        selectedCommentId,
        contentHash: normalized.contentHash,
        rootId: resolved.rootItem.id,
        path: resolved.path.ancestorIds,
        items: resolved.fetchedItems
          .map((item) => [item.id, item.responseHash])
          .sort(([left], [right]) => Number(left) - Number(right)),
      }),
    );
    return repository.apply({
      selected,
      path: resolved.path,
      fetchedItems: resolved.fetchedItems,
      urlCandidates: normalized.urlCandidates,
      idempotencyKey: `reconcile:${selectedCommentId}:${reconciliationHash}`,
    });
  };

export const createScheduleHnReconciliation =
  (
    repository: HnReconciliationRepository,
  ): ((
    scheduleKey: string,
    availableAt: Date,
    limit: number,
  ) => Promise<ReconciliationScheduleResult>) =>
  (scheduleKey, availableAt, limit) =>
    repository.schedule(scheduleKey, availableAt, limit);
