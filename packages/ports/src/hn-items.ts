import type { HnFetchResult, HnItemId } from "@hn-knowledge/domain";

export interface HnItems {
  get(id: HnItemId): Promise<HnFetchResult>;
}
