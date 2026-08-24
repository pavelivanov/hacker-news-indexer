import type { HnItemId, SelectionOccurrenceId } from "./identities.js";

export const MULTIPART_STATES = [
  "AWAITING_PARTS",
  "COMPLETE_MATCH",
  "COMPLETE_MISMATCH",
  "INCOMPLETE_SNAPSHOT",
  "CONFLICTING_PARTS",
] as const;
export type MultipartState = (typeof MULTIPART_STATES)[number];

export interface MultipartPart {
  readonly occurrenceId: SelectionOccurrenceId;
  readonly selectedCommentId: HnItemId;
  readonly displayedStoryId: HnItemId | null;
  readonly messageId: number;
  readonly occurredAt: Date;
  readonly part: number;
  readonly total: number;
  readonly fragment: string;
  readonly fragmentHash: string;
}

export interface MultipartReconstruction {
  readonly selectedCommentId: HnItemId;
  readonly expectedParts: number;
  readonly state: MultipartState;
  readonly normalizedSnapshot: string | null;
  readonly partOccurrenceIds: readonly SelectionOccurrenceId[];
}
