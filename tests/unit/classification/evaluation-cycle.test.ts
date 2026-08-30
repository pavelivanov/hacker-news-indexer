import { describe, expect, it } from "vitest";

import { prepareEvaluationCycle } from "@hn-knowledge/application";

const freshIds = Array.from({ length: 90 }, (_, index) => 50_000_000 + index);

// Generated with the SHA256_SORT_V1 codepoint comparator (NOT localeCompare)
// over salt `gold-v1-holdout`: take the first 27 IDs by ascending
// sha256(`<salt>:<commentId>`) hex under plain < / > string comparison,
// then sort the survivors numerically.
const expectedHoldoutIds = [
  50_000_001, 50_000_002, 50_000_008, 50_000_011, 50_000_019, 50_000_023,
  50_000_025, 50_000_026, 50_000_027, 50_000_038, 50_000_039, 50_000_044,
  50_000_051, 50_000_056, 50_000_057, 50_000_058, 50_000_059, 50_000_060,
  50_000_062, 50_000_064, 50_000_069, 50_000_070, 50_000_079, 50_000_081,
  50_000_082, 50_000_084, 50_000_085,
];

const prepareWith = (commentIds: readonly number[]) =>
  prepareEvaluationCycle({
    cycleId: "v1",
    source: {
      path: "evaluation/source-v1.json",
      sha256: "1".repeat(64),
      commentIds,
    },
    holdoutPath: "evaluation/holdout-v1.json",
    priorManifests: [],
    holdoutSize: 27,
  });

describe("evaluation cycle holdout split ordering", () => {
  it("matches a hardcoded fixture computed with the codepoint comparator", () => {
    const { manifest } = prepareWith(freshIds);

    expect(manifest.split.algorithm).toBe("SHA256_SORT_V1");
    expect(manifest.split.holdoutCommentIds).toEqual(expectedHoldoutIds);
    expect(manifest.split.developmentCommentIds).toEqual(
      freshIds.filter((id) => !expectedHoldoutIds.includes(id)),
    );
  });

  it("is stable across repeated computations regardless of input order", () => {
    const first = prepareWith(freshIds);
    const second = prepareWith(freshIds);
    const reversed = prepareWith([...freshIds].reverse());

    expect(first.manifest.split.holdoutCommentIds).toEqual(
      second.manifest.split.holdoutCommentIds,
    );
    expect(first.manifest.split.holdoutCommentIds).toEqual(
      reversed.manifest.split.holdoutCommentIds,
    );
    expect(first.manifest.split.holdoutFile.sha256).toBe(
      reversed.manifest.split.holdoutFile.sha256,
    );
  });
});
