import { describe, expect, it } from "vitest";

import { reconstructMultipart } from "@hn-knowledge/application";
import {
  hnItemId,
  selectionOccurrenceId,
  type MultipartPart,
} from "@hn-knowledge/domain";

const at = (minutes: number) =>
  new Date(Date.UTC(2026, 7, 24, 12, minutes, 0, 0));

const part = (
  selectedId: number,
  partNo: number,
  total: number,
  fragment: string,
  overrides: Partial<MultipartPart> = {},
): MultipartPart => ({
  occurrenceId: selectionOccurrenceId(`occurrence-${selectedId}-${partNo}`),
  selectedCommentId: hnItemId(selectedId),
  displayedStoryId: hnItemId(123),
  messageId: 32_800 + partNo,
  occurredAt: at(partNo),
  part: partNo,
  total,
  fragment,
  fragmentHash: `hash-${partNo}`,
  ...overrides,
});

describe("multipart provenance reconstruction", () => {
  it.each([49_369_163, 49_370_357])(
    "reconstructs known seed selected comment %i from two ordered parts",
    (selectedId) => {
      const reconstruction = reconstructMultipart({
        selectedCommentId: hnItemId(selectedId),
        canonicalText: "first half\n\nsecond half",
        parts: [
          part(selectedId, 2, 2, "second half"),
          part(selectedId, 1, 2, "first half "),
        ],
      });

      expect(reconstruction).toMatchObject({
        selectedCommentId: selectedId,
        expectedParts: 2,
        state: "COMPLETE_MATCH",
        normalizedSnapshot: "first half\n\nsecond half",
      });
      expect(reconstruction.partOccurrenceIds).toEqual([
        `occurrence-${selectedId}-1`,
        `occurrence-${selectedId}-2`,
      ]);
    },
  );

  it("keeps HN canonical when a complete snapshot differs", () => {
    const reconstruction = reconstructMultipart({
      selectedCommentId: hnItemId(10),
      canonicalText: "canonical HN text",
      parts: [part(10, 1, 2, "telegram "), part(10, 2, 2, "snapshot")],
    });

    expect(reconstruction).toMatchObject({
      state: "COMPLETE_MISMATCH",
      normalizedSnapshot: "telegram\n\nsnapshot",
    });
  });

  it("marks a missing part as an incomplete snapshot", () => {
    const reconstruction = reconstructMultipart({
      selectedCommentId: hnItemId(20),
      canonicalText: "one two three",
      parts: [part(20, 1, 3, "one "), part(20, 3, 3, "three")],
    });

    expect(reconstruction).toMatchObject({
      expectedParts: 3,
      state: "INCOMPLETE_SNAPSHOT",
      normalizedSnapshot: "one\n\nthree",
    });
  });

  it.each([
    ["duplicate part", [part(30, 1, 2, "a"), part(30, 1, 2, "a again")]],
    ["conflicting totals", [part(30, 1, 2, "a"), part(30, 2, 3, "b")]],
    [
      "incompatible story",
      [
        part(30, 1, 2, "a"),
        part(30, 2, 2, "b", { displayedStoryId: hnItemId(999) }),
      ],
    ],
    [
      "distant message",
      [part(30, 1, 2, "a"), part(30, 2, 2, "b", { messageId: 40_000 })],
    ],
  ] as const)("marks %s as conflicting", (_label, parts) => {
    const reconstruction = reconstructMultipart({
      selectedCommentId: hnItemId(30),
      canonicalText: "ab",
      parts,
    });

    expect(reconstruction).toMatchObject({
      state: "CONFLICTING_PARTS",
      normalizedSnapshot: null,
    });
  });
});
