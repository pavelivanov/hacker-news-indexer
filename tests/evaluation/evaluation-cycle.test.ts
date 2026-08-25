import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  assertEvaluationHoldoutMayOpen,
  parseEvaluationCycleManifest,
  prepareEvaluationCycle,
  validateEvaluationCycleSet,
} from "@hn-knowledge/application";

const loadV1 = async () =>
  parseEvaluationCycleManifest(
    JSON.parse(await readFile("evaluation/cycles/v1.json", "utf8")) as unknown,
  );

const freshIds = Array.from({ length: 90 }, (_, index) => 50_000_000 + index);

describe("immutable evaluation cycles", () => {
  it("records the terminal failed state of the opened v1 holdout", async () => {
    const v1 = await loadV1();

    expect(() => validateEvaluationCycleSet([v1])).not.toThrow();
    expect(v1).toMatchObject({
      cycleId: "v1",
      status: "OPENED_FAILED",
      candidate: { modelId: "gpt-5.6-sol" },
      holdoutOpening: { passed: false },
    });
  });

  it("freezes a deterministic fresh v2 split before annotation", async () => {
    const v1 = await loadV1();
    const first = prepareEvaluationCycle({
      cycleId: "v2",
      source: {
        path: "evaluation/source-v2.json",
        sha256: "1".repeat(64),
        commentIds: freshIds,
      },
      holdoutPath: "evaluation/holdout-v2.json",
      priorManifests: [v1],
    });
    const second = prepareEvaluationCycle({
      cycleId: "v2",
      source: {
        path: "evaluation/source-v2.json",
        sha256: "1".repeat(64),
        commentIds: [...freshIds].reverse(),
      },
      holdoutPath: "evaluation/holdout-v2.json",
      priorManifests: [v1],
    });

    expect(first).toEqual(second);
    expect(first.manifest).toMatchObject({
      status: "SPLIT_FROZEN",
      annotations: { annotatorA: null, annotatorB: null, gold: null },
      candidate: null,
      holdoutOpening: null,
    });
    expect(first.manifest.split.developmentCommentIds).toHaveLength(63);
    expect(first.manifest.split.holdoutCommentIds).toHaveLength(27);
    expect(() =>
      validateEvaluationCycleSet([v1, first.manifest]),
    ).not.toThrow();
  });

  it("rejects overlap with an opened cycle", async () => {
    const v1 = await loadV1();
    const ids = [...freshIds];
    ids[0] = v1.source.commentIds[0] as number;

    expect(() =>
      prepareEvaluationCycle({
        cycleId: "v2",
        source: {
          path: "evaluation/source-v2.json",
          sha256: "2".repeat(64),
          commentIds: ids,
        },
        holdoutPath: "evaluation/holdout-v2.json",
        priorManifests: [v1],
      }),
    ).toThrow(/reuses a comment/u);
  });

  it("rejects an older window even when IDs do not overlap", async () => {
    const v1 = await loadV1();
    const oldIds = Array.from({ length: 90 }, (_, index) => 40_000_000 + index);

    expect(() =>
      prepareEvaluationCycle({
        cycleId: "v2",
        source: {
          path: "evaluation/source-v2.json",
          sha256: "3".repeat(64),
          commentIds: oldIds,
        },
        holdoutPath: "evaluation/holdout-v2.json",
        priorManifests: [v1],
      }),
    ).toThrow(/not a fresh later HN comment window/u);
  });

  it("prevents the opened v1 holdout from being run again", async () => {
    const v1 = await loadV1();

    expect(() =>
      assertEvaluationHoldoutMayOpen(v1, {
        corpusSha256: v1.annotations.gold?.sha256 ?? "",
        provider: "openai",
        modelId: "gpt-5.6-sol",
        modelConfigId: v1.candidate?.modelConfigId ?? "",
        promptVersion: "classification-prompt.v3",
        promptHash: v1.candidate?.promptHash ?? "",
      }),
    ).toThrow(/already been opened/u);
  });
});
