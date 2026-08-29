import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  assertEvaluationCycleArtifactsMatch,
  assertEvaluationDevelopmentMayRun,
  assertEvaluationHoldoutMayOpen,
  assertEvaluationRowsMatchCycle,
  parseEvaluationCycleManifest,
  prepareEvaluationCycle,
  selectEvaluationCandidate,
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
        sourceSha256: v1.source.sha256,
        provider: "openai",
        modelId: "gpt-5.6-sol",
        modelConfigId: v1.candidate?.modelConfigId ?? "",
        promptVersion: "classification-prompt.v3",
        promptHash: v1.candidate?.promptHash ?? "",
      }),
    ).toThrow(/already been opened/u);
  });

  it("blocks development evaluation until independent annotation is final", async () => {
    const v1 = await loadV1();
    const v2 = prepareEvaluationCycle({
      cycleId: "v2",
      source: {
        path: "evaluation/source-v2.json",
        sha256: "4".repeat(64),
        commentIds: freshIds,
      },
      holdoutPath: "evaluation/holdout-v2.json",
      priorManifests: [v1],
    }).manifest;

    expect(() => assertEvaluationDevelopmentMayRun(v2)).toThrow(
      /requires ANNOTATED/u,
    );
  });

  it("pins development evaluation to cycle artifacts and split rows", async () => {
    const v1 = await loadV1();
    const frozen = prepareEvaluationCycle({
      cycleId: "v2",
      source: {
        path: "evaluation/source-v2.json",
        sha256: "5".repeat(64),
        commentIds: freshIds,
      },
      holdoutPath: "evaluation/holdout-v2.json",
      priorManifests: [v1],
    }).manifest;
    const annotated = parseEvaluationCycleManifest({
      ...frozen,
      status: "ANNOTATED",
      annotations: {
        annotatorA: {
          path: "evaluation/annotations/annotator-a-v2.jsonl",
          sha256: "a".repeat(64),
        },
        annotatorB: {
          path: "evaluation/annotations/annotator-b-v2.jsonl",
          sha256: "b".repeat(64),
        },
        gold: {
          path: "evaluation/gold-v2.jsonl",
          sha256: "c".repeat(64),
        },
      },
    });

    expect(() => assertEvaluationDevelopmentMayRun(annotated)).not.toThrow();
    expect(() =>
      assertEvaluationCycleArtifactsMatch(annotated, {
        corpusSha256: "c".repeat(64),
        sourceSha256: "5".repeat(64),
      }),
    ).not.toThrow();
    expect(() =>
      assertEvaluationRowsMatchCycle(
        annotated,
        "benchmark",
        [...annotated.split.developmentCommentIds].reverse(),
      ),
    ).not.toThrow();

    expect(() =>
      assertEvaluationCycleArtifactsMatch(annotated, {
        corpusSha256: "d".repeat(64),
        sourceSha256: "5".repeat(64),
      }),
    ).toThrow(/runtime corpus/u);
    expect(() =>
      assertEvaluationRowsMatchCycle(annotated, "benchmark", [
        ...annotated.split.developmentCommentIds,
        annotated.split.holdoutCommentIds[0] as number,
      ]),
    ).toThrow(/frozen split/u);
  });

  it("freezes only a passing live development candidate", async () => {
    const v1 = await loadV1();
    const frozen = prepareEvaluationCycle({
      cycleId: "v2",
      source: {
        path: "evaluation/source-v2.json",
        sha256: "5".repeat(64),
        commentIds: freshIds,
      },
      holdoutPath: "evaluation/holdout-v2.json",
      priorManifests: [v1],
    }).manifest;
    const annotated = parseEvaluationCycleManifest({
      ...frozen,
      status: "ANNOTATED",
      annotations: {
        annotatorA: {
          path: "evaluation/annotations/annotator-a-v2.jsonl",
          sha256: "a".repeat(64),
        },
        annotatorB: {
          path: "evaluation/annotations/annotator-b-v2.jsonl",
          sha256: "b".repeat(64),
        },
        gold: {
          path: "evaluation/gold-v2.jsonl",
          sha256: "c".repeat(64),
        },
      },
    });
    const input = {
      cycleId: "v2",
      mode: "benchmark",
      split: "development",
      rows: 63,
      terminalRuns: 63,
      activatedDecisions: 0,
      passed: true,
      corpusSha256: "c".repeat(64),
      sourceSha256: "5".repeat(64),
      provider: "openai",
      modelId: "gpt-5.6-sol",
      modelConfigId: "openai:test",
      promptVersion: "classification-prompt.v4",
      promptHash: "d".repeat(64),
      developmentReport: {
        path: "evaluation/reports/benchmark-v2-openai-test-v4.json",
        sha256: "e".repeat(64),
      },
    } as const;

    const selected = selectEvaluationCandidate(annotated, input);

    expect(selected).toMatchObject({
      status: "CANDIDATE_SELECTED",
      candidate: {
        provider: "openai",
        modelId: "gpt-5.6-sol",
        developmentReport: input.developmentReport,
      },
      holdoutOpening: null,
    });
    expect(() => validateEvaluationCycleSet([v1, selected])).not.toThrow();
    expect(() =>
      assertEvaluationHoldoutMayOpen(selected, {
        corpusSha256: input.corpusSha256,
        sourceSha256: "f".repeat(64),
        provider: input.provider,
        modelId: input.modelId,
        modelConfigId: input.modelConfigId,
        promptVersion: input.promptVersion,
        promptHash: input.promptHash,
      }),
    ).toThrow(/runtime source/u);
    expect(() => selectEvaluationCandidate(selected, input)).toThrow(
      /requires ANNOTATED/u,
    );
    expect(() =>
      selectEvaluationCandidate(annotated, {
        ...input,
        provider: "fixture",
      }),
    ).toThrow(/provider is unsupported/u);
    expect(() =>
      selectEvaluationCandidate(annotated, { ...input, passed: false }),
    ).toThrow(/did not pass/u);
    expect(() =>
      selectEvaluationCandidate(annotated, {
        ...input,
        activatedDecisions: 1,
      }),
    ).toThrow(/activated a decision/u);
    expect(() =>
      selectEvaluationCandidate(annotated, { ...input, terminalRuns: 62 }),
    ).toThrow(/run count is incomplete/u);
  });
});
