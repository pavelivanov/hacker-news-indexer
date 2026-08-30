import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  abandonEvaluationHoldoutClaim,
  assertEvaluationCycleArtifactsMatch,
  assertEvaluationDevelopmentMayRun,
  assertEvaluationHoldoutMayOpen,
  assertEvaluationRowsMatchCycle,
  claimEvaluationHoldout,
  parseEvaluationCycleManifest,
  prepareEvaluationCycle,
  recordEvaluationAnnotationFailure,
  recordEvaluationHoldoutResult,
  selectEvaluationCandidate,
  serializeEvaluationCycleManifest,
  validateEvaluationCycleSet,
  type EvaluationCycleManifest,
} from "@hn-knowledge/application";

const loadV1 = async () =>
  parseEvaluationCycleManifest(
    JSON.parse(await readFile("evaluation/cycles/v1.json", "utf8")) as unknown,
  );

const freshIds = Array.from({ length: 90 }, (_, index) => 50_000_000 + index);

const annotatedV2 = (v1: EvaluationCycleManifest): EvaluationCycleManifest =>
  parseEvaluationCycleManifest({
    ...prepareEvaluationCycle({
      cycleId: "v2",
      source: {
        path: "evaluation/source-v2.json",
        sha256: "5".repeat(64),
        commentIds: freshIds,
      },
      holdoutPath: "evaluation/holdout-v2.json",
      priorManifests: [v1],
    }).manifest,
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

  it("terminalizes a failed annotation gate before a fresh cycle", async () => {
    const v1 = await loadV1();
    const frozen = prepareEvaluationCycle({
      cycleId: "v2",
      source: {
        path: "evaluation/source-v2.json",
        sha256: "4".repeat(64),
        commentIds: freshIds,
      },
      holdoutPath: "evaluation/holdout-v2.json",
      priorManifests: [v1],
    }).manifest;
    const input = {
      cycleId: "v2",
      rows: 90,
      exactDecisionAgreementRows: 70,
      primaryClassKappa: 0.5713,
      materialRelevanceKappa: 0.598,
      requiredKappa: 0.75,
      annotatorA: {
        path: "evaluation/annotations/failed/v2/annotator-a.jsonl",
        sha256: "a".repeat(64),
      },
      annotatorB: {
        path: "evaluation/annotations/failed/v2/annotator-b.jsonl",
        sha256: "b".repeat(64),
      },
      report: {
        path: "evaluation/reports/annotation-comparison-v2.json",
        sha256: "c".repeat(64),
      },
    } as const;

    const failed = recordEvaluationAnnotationFailure(frozen, input);

    expect(failed).toMatchObject({
      status: "ANNOTATION_FAILED",
      annotations: {
        annotatorA: input.annotatorA,
        annotatorB: input.annotatorB,
        gold: null,
      },
      annotationFailure: {
        report: input.report,
        rows: 90,
        exactDecisionAgreementRows: 70,
        primaryClassKappa: 0.5713,
        materialRelevanceKappa: 0.598,
        requiredKappa: 0.75,
      },
      candidate: null,
      holdoutOpening: null,
    });
    expect(() => validateEvaluationCycleSet([v1, failed])).not.toThrow();
    expect(() => assertEvaluationDevelopmentMayRun(failed)).toThrow(
      /requires ANNOTATED/u,
    );
    expect(() => recordEvaluationAnnotationFailure(failed, input)).toThrow(
      /requires SPLIT_FROZEN/u,
    );
    expect(() =>
      recordEvaluationAnnotationFailure(frozen, {
        ...input,
        primaryClassKappa: 0.8,
        materialRelevanceKappa: 0.8,
      }),
    ).toThrow(/did not fail/u);

    const v3 = prepareEvaluationCycle({
      cycleId: "v3",
      source: {
        path: "evaluation/source-v3.json",
        sha256: "d".repeat(64),
        commentIds: Array.from(
          { length: 90 },
          (_, index) => 60_000_000 + index,
        ),
      },
      holdoutPath: "evaluation/holdout-v3.json",
      priorManifests: [v1, failed],
    }).manifest;
    expect(() => validateEvaluationCycleSet([v1, failed, v3])).not.toThrow();
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

    const runtime = {
      corpusSha256: input.corpusSha256,
      sourceSha256: input.sourceSha256,
      provider: input.provider,
      modelId: input.modelId,
      modelConfigId: input.modelConfigId,
      promptVersion: input.promptVersion,
      promptHash: input.promptHash,
    } as const;
    const claimed = claimEvaluationHoldout(selected, runtime);

    expect(claimed).toMatchObject({
      status: "HOLDOUT_CLAIMED",
      candidate: selected.candidate,
      holdoutOpening: null,
    });
    expect(() => validateEvaluationCycleSet([v1, claimed])).not.toThrow();
    expect(() => assertEvaluationHoldoutMayOpen(claimed, runtime)).toThrow(
      /already been opened/u,
    );

    const holdoutInput = {
      ...runtime,
      cycleId: "v2",
      mode: "holdout",
      split: "holdout",
      rows: 27,
      terminalRuns: 27,
      activatedDecisions: 0,
      passed: true,
      report: {
        path: "evaluation/reports/holdout-v2-openai-test-v4.json",
        sha256: "f".repeat(64),
      },
    } as const;
    const terminal = recordEvaluationHoldoutResult(claimed, holdoutInput);

    expect(terminal).toMatchObject({
      status: "OPENED_PASSED",
      holdoutOpening: {
        passed: true,
        report: holdoutInput.report,
      },
    });
    expect(() => validateEvaluationCycleSet([v1, terminal])).not.toThrow();
    expect(() => recordEvaluationHoldoutResult(terminal, holdoutInput)).toThrow(
      /requires HOLDOUT_CLAIMED/u,
    );
    expect(
      recordEvaluationHoldoutResult(claimed, {
        ...holdoutInput,
        passed: false,
      }).status,
    ).toBe("OPENED_FAILED");
    expect(() =>
      recordEvaluationHoldoutResult(claimed, {
        ...holdoutInput,
        terminalRuns: 26,
      }),
    ).toThrow(/run count is incomplete/u);
    expect(() =>
      recordEvaluationHoldoutResult(claimed, {
        ...holdoutInput,
        report: input.developmentReport,
      }),
    ).toThrow(/reports must differ/u);
  });

  it("abandons a wedged holdout claim back to a re-claimable candidate", async () => {
    const v1 = await loadV1();
    const annotated = annotatedV2(v1);
    const runtime = {
      corpusSha256: "c".repeat(64),
      sourceSha256: "5".repeat(64),
      provider: "openai",
      modelId: "gpt-5.6-sol",
      modelConfigId: "openai:test",
      promptVersion: "classification-prompt.v4",
      promptHash: "d".repeat(64),
    } as const;
    const claimed = claimEvaluationHoldout(
      selectEvaluationCandidate(annotated, {
        ...runtime,
        cycleId: "v2",
        mode: "benchmark",
        split: "development",
        rows: 63,
        terminalRuns: 63,
        activatedDecisions: 0,
        passed: true,
        developmentReport: {
          path: "evaluation/reports/benchmark-v2-openai-test-v4.json",
          sha256: "e".repeat(64),
        },
      }),
      runtime,
    );
    expect(claimed.status).toBe("HOLDOUT_CLAIMED");

    const directory = await mkdtemp(path.join(tmpdir(), "hn-abandon-"));
    const manifestPath = path.join(directory, "v2.json");
    const markerPath = path.join(
      directory,
      "holdout-v2-openai-test-v5.json.attempt",
    );
    const manifestText = serializeEvaluationCycleManifest(claimed);
    await writeFile(manifestPath, manifestText, "utf8");
    await writeFile(markerPath, "stale attempt\n", "utf8");

    const abandoned = await abandonEvaluationHoldoutClaim(claimed, {
      manifestPath,
      manifestText,
      attemptMarkerPaths: [markerPath],
      existingHoldoutReportPaths: [],
      abandonedAt: "2026-08-30T00:00:00.000Z",
      companionManifests: [v1],
    });

    expect(abandoned.manifest).toMatchObject({
      cycleId: "v2",
      status: "CANDIDATE_SELECTED",
      claimAbandonedAt: "2026-08-30T00:00:00.000Z",
      holdoutOpening: null,
    });
    expect(abandoned.removedAttemptMarkerPaths).toEqual([markerPath]);
    await expect(readFile(markerPath, "utf8")).rejects.toThrow(/ENOENT/u);
    expect(
      parseEvaluationCycleManifest(
        JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
      ),
    ).toEqual(abandoned.manifest);
    expect(() =>
      validateEvaluationCycleSet([v1, abandoned.manifest]),
    ).not.toThrow();

    expect(() =>
      assertEvaluationHoldoutMayOpen(abandoned.manifest, runtime),
    ).not.toThrow();
    const reclaimed = claimEvaluationHoldout(abandoned.manifest, runtime);
    expect(reclaimed.status).toBe("HOLDOUT_CLAIMED");
    expect(reclaimed.claimAbandonedAt).toBe("2026-08-30T00:00:00.000Z");
    expect(() => validateEvaluationCycleSet([v1, reclaimed])).not.toThrow();
  });

  it("refuses to abandon a holdout claim unless every precondition holds", async () => {
    const v1 = await loadV1();
    const annotated = annotatedV2(v1);
    const runtime = {
      corpusSha256: "c".repeat(64),
      sourceSha256: "5".repeat(64),
      provider: "openai",
      modelId: "gpt-5.6-sol",
      modelConfigId: "openai:test",
      promptVersion: "classification-prompt.v4",
      promptHash: "d".repeat(64),
    } as const;
    const selected = selectEvaluationCandidate(annotated, {
      ...runtime,
      cycleId: "v2",
      mode: "benchmark",
      split: "development",
      rows: 63,
      terminalRuns: 63,
      activatedDecisions: 0,
      passed: true,
      developmentReport: {
        path: "evaluation/reports/benchmark-v2-openai-test-v4.json",
        sha256: "e".repeat(64),
      },
    });
    const claimed = claimEvaluationHoldout(selected, runtime);

    const directory = await mkdtemp(path.join(tmpdir(), "hn-abandon-refuse-"));
    const manifestPath = path.join(directory, "v2.json");
    const markerPath = path.join(
      directory,
      "holdout-v2-openai-test-v5.json.attempt",
    );
    const manifestText = serializeEvaluationCycleManifest(claimed);
    await writeFile(manifestPath, manifestText, "utf8");
    await writeFile(markerPath, "stale attempt\n", "utf8");

    const input = {
      manifestPath,
      manifestText,
      attemptMarkerPaths: [markerPath],
      abandonedAt: "2026-08-30T00:00:00.000Z",
    } as const;

    await expect(
      abandonEvaluationHoldoutClaim(claimed, {
        ...input,
        existingHoldoutReportPaths: [
          path.join(directory, "holdout-v2-openai-test-v5.json"),
        ],
      }),
    ).rejects.toThrow(/holdout report already exists/u);
    await expect(
      abandonEvaluationHoldoutClaim(claimed, {
        ...input,
        attemptMarkerPaths: [
          path.join(directory, "holdout-v2-missing-v5.json.attempt"),
        ],
        existingHoldoutReportPaths: [],
      }),
    ).rejects.toThrow(/attempt marker is missing/u);
    await expect(
      abandonEvaluationHoldoutClaim(claimed, {
        ...input,
        attemptMarkerPaths: [],
        existingHoldoutReportPaths: [],
      }),
    ).rejects.toThrow(/attempt marker is missing/u);
    await expect(
      abandonEvaluationHoldoutClaim(claimed, {
        ...input,
        existingHoldoutReportPaths: [],
        abandonedAt: "   ",
      }),
    ).rejects.toThrow(/claimAbandonedAt/u);

    for (const refusal of [annotated, selected, v1]) {
      await expect(
        abandonEvaluationHoldoutClaim(refusal, {
          ...input,
          existingHoldoutReportPaths: [],
        }),
      ).rejects.toThrow(/requires HOLDOUT_CLAIMED/u);
    }

    expect(await readFile(manifestPath, "utf8")).toBe(manifestText);
    expect(await readFile(markerPath, "utf8")).toBe("stale attempt\n");
  });
});
