import type {
  HnItemId,
  MultipartPart,
  MultipartReconstruction,
} from "@hn-knowledge/domain";

import { normalizePlainText } from "../normalize/hn-html.js";

const DEFAULT_MAX_MESSAGE_DISTANCE = 10;
const DEFAULT_MAX_TIME_DISTANCE_MS = 30 * 60 * 1_000;

export interface ReconstructMultipartInput {
  readonly selectedCommentId: HnItemId;
  readonly canonicalText: string;
  readonly parts: readonly MultipartPart[];
  readonly maxMessageDistance?: number;
  readonly maxTimeDistanceMs?: number;
}

const boundedNonNegative = (value: number, field: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
};

export const reconstructMultipart = (
  input: ReconstructMultipartInput,
): MultipartReconstruction => {
  if (input.parts.length === 0) {
    throw new TypeError("Multipart reconstruction requires at least one part");
  }
  const maxMessageDistance = boundedNonNegative(
    input.maxMessageDistance ?? DEFAULT_MAX_MESSAGE_DISTANCE,
    "maxMessageDistance",
  );
  const maxTimeDistanceMs = boundedNonNegative(
    input.maxTimeDistanceMs ?? DEFAULT_MAX_TIME_DISTANCE_MS,
    "maxTimeDistanceMs",
  );
  const expectedParts = input.parts[0]?.total ?? 0;
  const partNumbers = new Set<number>();
  const totals = new Set(input.parts.map((part) => part.total));
  const displayedIds = new Set(
    input.parts
      .map((part) => part.displayedStoryId)
      .filter((id): id is HnItemId => id !== null)
      .map(Number),
  );
  const messageIds = input.parts.map((part) => part.messageId);
  const timestamps = input.parts.map((part) => part.occurredAt.getTime());
  const invalidPart = input.parts.some((part) => {
    const duplicate = partNumbers.has(part.part);
    partNumbers.add(part.part);
    return (
      part.selectedCommentId !== input.selectedCommentId ||
      duplicate ||
      part.part < 1 ||
      part.part > part.total ||
      part.total < 2
    );
  });
  const tooFarApart =
    Math.max(...messageIds) - Math.min(...messageIds) > maxMessageDistance ||
    Math.max(...timestamps) - Math.min(...timestamps) > maxTimeDistanceMs;
  const conflicting =
    invalidPart || totals.size !== 1 || displayedIds.size > 1 || tooFarApart;

  if (conflicting) {
    return {
      selectedCommentId: input.selectedCommentId,
      expectedParts,
      state: "CONFLICTING_PARTS",
      normalizedSnapshot: null,
      partOccurrenceIds: input.parts.map((part) => part.occurrenceId),
    };
  }

  const ordered = [...input.parts].sort(
    (left, right) => left.part - right.part,
  );
  const complete =
    ordered.length === expectedParts &&
    ordered.every((part, index) => part.part === index + 1);
  const normalizedSnapshot = normalizePlainText(
    ordered.map((part) => part.fragment).join("\n\n"),
  );
  if (!complete) {
    return {
      selectedCommentId: input.selectedCommentId,
      expectedParts,
      state: "INCOMPLETE_SNAPSHOT",
      normalizedSnapshot,
      partOccurrenceIds: ordered.map((part) => part.occurrenceId),
    };
  }

  return {
    selectedCommentId: input.selectedCommentId,
    expectedParts,
    state:
      normalizedSnapshot === normalizePlainText(input.canonicalText)
        ? "COMPLETE_MATCH"
        : "COMPLETE_MISMATCH",
    normalizedSnapshot,
    partOccurrenceIds: ordered.map((part) => part.occurrenceId),
  };
};
