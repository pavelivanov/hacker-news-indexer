import type { HnItemId } from "./identities.js";

export const HN_ITEM_TYPES = [
  "comment",
  "story",
  "poll",
  "pollopt",
  "job",
] as const;
export type HnItemType = (typeof HN_ITEM_TYPES)[number];

export const HN_AVAILABILITY_STATES = [
  "AVAILABLE",
  "DELETED",
  "DEAD",
  "MISSING",
] as const;
export type HnAvailabilityState = (typeof HN_AVAILABILITY_STATES)[number];

export interface HnItem {
  readonly id: HnItemId;
  readonly type: HnItemType;
  readonly parentId: HnItemId | null;
  readonly author: string | null;
  readonly time: Date | null;
  readonly title: string | null;
  readonly textHtml: string | null;
  readonly url: string | null;
  readonly availability: HnAvailabilityState;
  readonly fetchedAt: Date;
  readonly responseHash: string;
}

export type HnFetchResult =
  | { readonly kind: "ITEM"; readonly item: HnItem }
  | {
      readonly kind: "MISSING";
      readonly id: HnItemId;
      readonly fetchedAt: Date;
      readonly responseHash: string;
    };

export const HN_RESOLUTION_FAILURES = [
  "SELECTED_ITEM_MISSING",
  "SELECTED_ITEM_NOT_COMMENT",
  "PARENT_MISSING",
  "PARENT_CYCLE",
  "PARENT_DEPTH_EXCEEDED",
  "INVALID_ROOT_TYPE",
] as const;
export type HnResolutionFailure = (typeof HN_RESOLUTION_FAILURES)[number];

export interface ResolutionPath {
  readonly selectedCommentId: HnItemId;
  readonly ancestorIds: readonly HnItemId[];
  readonly displayedStoryId: HnItemId | null;
  readonly resolvedRootId: HnItemId;
  readonly resolverVersion: string;
}

export interface SelectedComment {
  readonly id: HnItemId;
  readonly rootId: HnItemId;
  readonly canonicalHtml: string;
  readonly canonicalText: string;
  readonly contentHash: string;
  readonly availability: HnAvailabilityState;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
}

export interface ResolvedHnComment {
  readonly selectedItem: HnItem;
  readonly rootItem: HnItem;
  readonly fetchedItems: readonly HnItem[];
  readonly path: ResolutionPath;
}

export const URL_VALIDATION_STATES = [
  "CANDIDATE",
  "VALID",
  "REJECTED",
] as const;
export type UrlValidationState = (typeof URL_VALIDATION_STATES)[number];

export interface UrlCandidate {
  readonly rawUrl: string;
  readonly canonicalUrl: string | null;
  readonly sourceDocument: string;
  readonly originField: "href";
  readonly scheme: string | null;
  readonly host: string | null;
  readonly validationState: UrlValidationState;
  readonly contentHash: string;
}

export interface CanonicalContentBlock {
  readonly kind: "TEXT" | "CODE";
  readonly text: string;
}

export interface NormalizedHnContent {
  readonly canonicalHtml: string;
  readonly canonicalText: string;
  readonly contentHash: string;
  readonly blocks: readonly CanonicalContentBlock[];
  readonly urlCandidates: readonly UrlCandidate[];
}

export class HnResolutionError extends Error {
  constructor(
    readonly code: HnResolutionFailure,
    message: string,
  ) {
    super(message);
    this.name = "HnResolutionError";
  }
}
