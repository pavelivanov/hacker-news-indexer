import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface EvaluationReport {
  readonly reportVersion: number;
  readonly provider: string;
  readonly modelId: string;
  readonly promptVersion: string;
  readonly decisionRouterVersion?: string;
  readonly hypothesis?: null | {
    readonly path: string;
    readonly sha256: string;
  };
  readonly mode: string;
  readonly split: string;
  readonly rows: number;
  readonly terminalRuns: number;
  readonly activatedDecisions: number;
  readonly macroF1: number;
  readonly classificationCoverage: number;
  readonly automaticCoverage: number;
  readonly automaticAccuracy: number;
  readonly stableGold: {
    readonly rows: number;
    readonly macroF1: number;
    readonly classMetrics: {
      readonly DISCOVERY: { readonly precision: number };
      readonly EXPERT_NOTE: { readonly precision: number };
    };
    readonly extraction: { readonly urlGroundingPrecision: number };
  };
  readonly discoveryPrecision: number;
  readonly expertNotePrecision: number;
  readonly urlGroundingPrecision: number;
  readonly inventedUrlCount: number;
  readonly evidenceOriginAccuracy: number;
  readonly spanValidation: number;
  readonly schemaValidRate: number;
  readonly applicationValidRate: number;
  readonly latencyMs: { readonly p95: number };
  readonly latencySampleCount?: number;
  readonly usage: {
    readonly accountingVersion?: number;
    readonly runs?: number;
    readonly inputTokens: number;
    readonly cachedInputTokens?: number;
    readonly cacheWriteInputTokens?: number;
    readonly uncachedInputTokens?: number | null;
    readonly outputTokens: number;
    readonly inputTokenBreakdownComplete?: boolean;
    readonly outputTokenUsageComplete?: boolean;
    readonly tokenUsageComplete?: boolean;
    readonly estimatedUsd?: number | null;
    readonly estimatedAllInputUncachedUsd?: number | null;
    readonly estimatedUpperBoundUsd: number | null;
    readonly estimateIncludesAdversarialCalls?: boolean;
  };
  readonly configuration: { readonly reasoningEffort: string | null };
  readonly failures: Readonly<Record<string, number>>;
  readonly acceptance: Readonly<Record<string, boolean>>;
  readonly rescoring?: {
    readonly providerCalls: number;
    readonly rule: string;
  };
  readonly cases: readonly {
    readonly commentId: number;
    readonly expected: string;
    readonly predicted: string;
    readonly failureCode: string | null;
    readonly discoveryDiagnostics: {
      readonly matches: readonly {
        readonly expectedName: string;
        readonly predictedName: string;
        readonly expectedUrlCandidateIds: readonly string[];
        readonly predictedUrlCandidateIds: readonly string[];
      }[];
      readonly unmatchedExpected: readonly { readonly name: string }[];
      readonly unmatchedPredicted: readonly { readonly name: string }[];
    };
  }[];
  readonly adversarial: {
    readonly cases: number;
    readonly toolActions: number;
    readonly networkActions: number;
  };
  readonly passed: boolean;
}

const load = async (name: string): Promise<EvaluationReport> =>
  JSON.parse(
    await readFile(`evaluation/reports/${name}`, "utf8"),
  ) as EvaluationReport;

const expectAcceptanceGates = (report: EvaluationReport): void => {
  expect(report.macroF1).toBeGreaterThanOrEqual(0.85);
  expect(report.classificationCoverage).toBeGreaterThanOrEqual(0.8);
  expect(report.discoveryPrecision).toBeGreaterThanOrEqual(0.93);
  expect(report.expertNotePrecision).toBeGreaterThanOrEqual(0.88);
  expect(report.urlGroundingPrecision).toBe(1);
  expect(report.inventedUrlCount).toBe(0);
  expect(report.evidenceOriginAccuracy).toBeGreaterThanOrEqual(0.97);
  expect(report.spanValidation).toBe(1);
  expect(report.schemaValidRate).toBeGreaterThanOrEqual(0.995);
  expect(report.applicationValidRate).toBeGreaterThanOrEqual(0.95);
  expect(report.latencyMs.p95).toBeLessThan(60_000);
  expect(report.adversarial.cases).toBeGreaterThanOrEqual(4);
  expect(report.adversarial.toolActions).toBe(0);
  expect(report.adversarial.networkActions).toBe(0);
};

describe("classification evaluation gates", () => {
  it("benchmarks only the development split", async () => {
    const report = await load("benchmark-fixture-v5.json");

    expect(report).toMatchObject({
      mode: "benchmark",
      reportVersion: 5,
      promptVersion: "classification-prompt.v4",
      split: "development",
      rows: 69,
      terminalRuns: 69,
      activatedDecisions: 0,
      classificationCoverage: 1,
      automaticCoverage: 53 / 69,
      automaticAccuracy: 1,
      decisionRouterVersion: "decision-router.v1",
      hypothesis: null,
      stableGold: { rows: 65, macroF1: 1 },
    });
    expectAcceptanceGates(report);
  });

  it("passes the frozen 98-comment shadow replay without publication", async () => {
    const report = await load("shadow-fixture-v5.json");

    expect(report).toMatchObject({
      mode: "shadow",
      reportVersion: 5,
      promptVersion: "classification-prompt.v4",
      split: "all",
      rows: 98,
      terminalRuns: 98,
      activatedDecisions: 0,
      classificationCoverage: 1,
      automaticAccuracy: 1,
      automaticCoverage: 78 / 98,
      decisionRouterVersion: "decision-router.v1",
      hypothesis: null,
      stableGold: { rows: 88, macroF1: 1 },
    });
    expectAcceptanceGates(report);
  });

  it("preserves the pre-router fixture report as historical v3 evidence", async () => {
    const report = await load("benchmark-fixture-v3.json");

    expect(report).toMatchObject({
      reportVersion: 3,
      promptVersion: "classification-prompt.v3",
      automaticCoverage: 55 / 69,
    });
    expect(report.decisionRouterVersion).toBeUndefined();
  });

  it("keeps reports free of prompts, source documents, and provider output", async () => {
    const text = await readFile(
      "evaluation/reports/shadow-fixture-v5.json",
      "utf8",
    );

    expect(text).not.toContain("rawOutput");
    expect(text).not.toContain("providerOutput");
    expect(text).not.toContain("documents");
    expect(text).not.toContain("SYSTEM:");
    expect(text).not.toContain("https://");
  });

  it("records non-sensitive per-case diagnostics for every development row", async () => {
    const report = await load("benchmark-fixture-v5.json");

    expect(report.cases).toHaveLength(69);
    expect(new Set(report.cases.map((entry) => entry.commentId)).size).toBe(69);
    expect(report.cases).toContainEqual(
      expect.objectContaining({
        expected: "DISCOVERY",
        predicted: "DISCOVERY",
        failureCode: null,
      }),
    );
    const discoveryCase = report.cases.find(
      (entry) => entry.expected === "DISCOVERY",
    );
    expect(discoveryCase?.discoveryDiagnostics.matches.length).toBeGreaterThan(
      0,
    );
    expect(
      typeof discoveryCase?.discoveryDiagnostics.matches[0]?.expectedName,
    ).toBe("string");
    expect(
      typeof discoveryCase?.discoveryDiagnostics.matches[0]?.predictedName,
    ).toBe("string");
  });

  it.each([
    ["benchmark-openai-gpt-5-6-luna-low-v1.json", "gpt-5.6-luna"],
    ["benchmark-openai-gpt-5-6-luna-medium-v1.json", "gpt-5.6-luna"],
    ["benchmark-openai-gpt-5-6-terra-low-v1.json", "gpt-5.6-terra"],
    ["benchmark-openai-gpt-5-6-terra-medium-v1.json", "gpt-5.6-terra"],
    ["benchmark-openai-gpt-5-6-sol-low-v1.json", "gpt-5.6-sol"],
    ["benchmark-openai-gpt-5-6-sol-medium-v1.json", "gpt-5.6-sol"],
  ])("records a development-only rejection in %s", async (name, modelId) => {
    const report = await load(name);

    expect(report).toMatchObject({
      provider: "openai",
      modelId,
      mode: "benchmark",
      split: "development",
      rows: 69,
      terminalRuns: 69,
      activatedDecisions: 0,
      passed: false,
    });
  });

  it("records the corrected Sol development diagnostics without opening holdout", async () => {
    const report = await load("benchmark-openai-gpt-5-6-sol-low-v2.json");

    expect(report).toMatchObject({
      provider: "openai",
      modelId: "gpt-5.6-sol",
      mode: "benchmark",
      split: "development",
      rows: 69,
      terminalRuns: 69,
      activatedDecisions: 0,
      schemaValidRate: 1,
      applicationValidRate: 1,
      passed: false,
    });
    expect(report.cases).toHaveLength(69);
    expect(report.stableGold.macroF1).toBeGreaterThanOrEqual(0.85);
    expect(
      report.stableGold.classMetrics.EXPERT_NOTE.precision,
    ).toBeGreaterThanOrEqual(0.88);
    expect(report.stableGold.extraction.urlGroundingPrecision).toBeLessThan(1);
  });

  it("records the corrected Luna rejection without opening holdout", async () => {
    const report = await load("benchmark-openai-gpt-5-6-luna-low-v2.json");

    expect(report).toMatchObject({
      provider: "openai",
      modelId: "gpt-5.6-luna",
      mode: "benchmark",
      split: "development",
      rows: 69,
      terminalRuns: 69,
      activatedDecisions: 0,
      configuration: { reasoningEffort: "low" },
      failures: { CLASSIFIER_TIMEOUT: 2 },
      schemaValidRate: 1,
      passed: false,
    });
    expect(report.cases).toHaveLength(69);
    expect(report.stableGold.macroF1).toBeGreaterThanOrEqual(0.85);
    expect(report.stableGold.classMetrics.DISCOVERY.precision).toBeLessThan(
      0.93,
    );
    expect(report.stableGold.classMetrics.EXPERT_NOTE.precision).toBeLessThan(
      0.88,
    );
    expect(report.stableGold.extraction.urlGroundingPrecision).toBeLessThan(1);
  });

  it("selects Sol on corrected development metrics without opening holdout", async () => {
    const report = await load("benchmark-openai-gpt-5-6-sol-low-v3.json");

    expect(report).toMatchObject({
      reportVersion: 3,
      provider: "openai",
      modelId: "gpt-5.6-sol",
      promptVersion: "classification-prompt.v3",
      mode: "benchmark",
      split: "development",
      rows: 69,
      terminalRuns: 69,
      activatedDecisions: 0,
      classificationCoverage: 1,
      schemaValidRate: 1,
      applicationValidRate: 1,
      failures: {},
      stableGold: { rows: 65, macroF1: 1 },
      rescoring: {
        providerCalls: 0,
        rule: "row-level-gold-url-candidate-membership.v1",
      },
      passed: true,
    });
    expect(report.cases).toHaveLength(69);
    expect(report.stableGold.classMetrics.DISCOVERY.precision).toBe(1);
    expect(report.stableGold.classMetrics.EXPERT_NOTE.precision).toBe(1);
    expect(report.stableGold.extraction.urlGroundingPrecision).toBe(1);
    expect(Object.values(report.acceptance).every(Boolean)).toBe(true);
  });

  it("records Terra v3 cost accurately and rejects it on Discovery precision", async () => {
    const report = await load("benchmark-openai-gpt-5-6-terra-low-v3.json");

    expect(report).toMatchObject({
      reportVersion: 3,
      provider: "openai",
      modelId: "gpt-5.6-terra",
      promptVersion: "classification-prompt.v3",
      mode: "benchmark",
      split: "development",
      rows: 69,
      terminalRuns: 69,
      activatedDecisions: 0,
      configuration: { reasoningEffort: "low" },
      failures: {},
      stableGold: { rows: 65 },
      usage: {
        accountingVersion: 2,
        runs: 73,
        inputTokenBreakdownComplete: true,
        outputTokenUsageComplete: true,
        tokenUsageComplete: true,
        estimateIncludesAdversarialCalls: true,
      },
      passed: false,
    });
    expect(report.stableGold.macroF1).toBeGreaterThanOrEqual(0.85);
    expect(report.stableGold.classMetrics.DISCOVERY.precision).toBeLessThan(
      0.93,
    );
    expect(
      report.stableGold.classMetrics.EXPERT_NOTE.precision,
    ).toBeGreaterThanOrEqual(0.88);
    expect(report.stableGold.extraction.urlGroundingPrecision).toBe(1);
    expect(report.usage.cachedInputTokens).toBeGreaterThan(0);
    expect(report.usage.cacheWriteInputTokens).toBeGreaterThan(0);
    expect(report.usage.estimatedUsd).toBeLessThan(
      report.usage.estimatedAllInputUncachedUsd ?? 0,
    );
    expect(report.usage.estimatedAllInputUncachedUsd).toBeLessThan(
      report.usage.estimatedUpperBoundUsd ?? 0,
    );
  });

  it("records the single sealed Sol holdout failure without tuning", async () => {
    const report = await load("holdout-openai-gpt-5-6-sol-low-v3.json");

    expect(report).toMatchObject({
      reportVersion: 3,
      provider: "openai",
      modelId: "gpt-5.6-sol",
      promptVersion: "classification-prompt.v3",
      mode: "holdout",
      split: "holdout",
      rows: 29,
      terminalRuns: 29,
      activatedDecisions: 0,
      classificationCoverage: 1,
      automaticCoverage: 1,
      schemaValidRate: 1,
      applicationValidRate: 1,
      failures: {},
      stableGold: { rows: 23, macroF1: 0.6190476190476191 },
      usage: {
        accountingVersion: 2,
        runs: 33,
        tokenUsageComplete: true,
        estimatedUsd: 0.262657,
        estimateIncludesAdversarialCalls: true,
      },
      passed: false,
    });
    expect(report.stableGold.classMetrics.DISCOVERY.precision).toBe(1);
    expect(report.stableGold.classMetrics.EXPERT_NOTE.precision).toBe(0.4);
    expect(report.stableGold.extraction.urlGroundingPrecision).toBe(1);
    expect(report.acceptance["stableGoldMacroF1"]).toBe(false);
    expect(report.acceptance["stableGoldExpertNotePrecision"]).toBe(false);
  });

  it("keeps live reports free of source/provider bodies and records only the authorized holdout", async () => {
    const names = [
      "benchmark-openai-gpt-5-6-luna-low-v1.json",
      "benchmark-openai-gpt-5-6-luna-medium-v1.json",
      "benchmark-openai-gpt-5-6-terra-low-v1.json",
      "benchmark-openai-gpt-5-6-terra-medium-v1.json",
      "benchmark-openai-gpt-5-6-sol-low-v1.json",
      "benchmark-openai-gpt-5-6-sol-medium-v1.json",
      "benchmark-openai-gpt-5-6-luna-low-v2.json",
      "benchmark-openai-gpt-5-6-sol-low-v2.json",
      "benchmark-openai-gpt-5-6-sol-low-v3.json",
      "benchmark-openai-gpt-5-6-terra-low-v3.json",
      "holdout-openai-gpt-5-6-sol-low-v3.json",
    ];
    for (const name of names) {
      const text = await readFile(`evaluation/reports/${name}`, "utf8");
      expect(text).not.toContain("rawOutput");
      expect(text).not.toContain("providerOutput");
      expect(text).not.toContain('"documents"');
      expect(text).not.toContain('"instructions"');
      expect(text).not.toContain("authorization");
    }

    for (const name of [
      "holdout-openai-gpt-5-6-luna-low-v1.json",
      "holdout-openai-gpt-5-6-luna-medium-v1.json",
      "holdout-openai-gpt-5-6-terra-low-v1.json",
      "holdout-openai-gpt-5-6-terra-medium-v1.json",
      "holdout-openai-gpt-5-6-sol-low-v1.json",
      "holdout-openai-gpt-5-6-sol-medium-v1.json",
      "holdout-openai-gpt-5-6-sol-low-v2.json",
      "holdout-openai-gpt-5-6-sol-medium-v2.json",
      "holdout-openai-gpt-5-6-luna-low-v2.json",
      "holdout-openai-gpt-5-6-luna-medium-v2.json",
      "holdout-openai-gpt-5-6-sol-medium-v3.json",
      "holdout-openai-gpt-5-6-luna-low-v3.json",
      "holdout-openai-gpt-5-6-luna-medium-v3.json",
      "holdout-openai-gpt-5-6-terra-low-v3.json",
      "holdout-openai-gpt-5-6-terra-medium-v3.json",
    ]) {
      await expect(
        readFile(`evaluation/reports/${name}`, "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});

describe("latency aggregation over successful runs", () => {
  interface LatencyRunInput {
    readonly latencyMs: number | null;
  }

  // Mirrors the aggregation in scripts/evaluate-classifier.mts: failed runs
  // record latencyMs null and must not deflate the acceptance percentiles.
  const aggregate = (runInputs: readonly LatencyRunInput[]) => {
    const latencies = runInputs
      .filter((run) => run.latencyMs !== null)
      .map((run) => run.latencyMs as number)
      .sort((left, right) => left - right);
    const percentile = (fraction: number): number =>
      latencies[
        Math.min(latencies.length - 1, Math.floor(latencies.length * fraction))
      ] ?? 0;
    return { latencies, percentile };
  };

  it("counts only successful runs and computes percentiles from successes only", () => {
    const successLatencies = [
      1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 7_500,
    ];
    const runInputs: readonly LatencyRunInput[] = [
      ...successLatencies.map((latencyMs) => ({ latencyMs })),
      { latencyMs: null },
      { latencyMs: null },
    ];

    const { latencies, percentile } = aggregate(runInputs);

    expect(latencies).toEqual(successLatencies);
    expect(latencies.length).toBe(8); // report.latencySampleCount
    expect(percentile(0.5)).toBe(5_000);
    expect(percentile(0.95)).toBe(7_500);
  });

  it("returns 0 percentiles when every run failed", () => {
    const { latencies, percentile } = aggregate([
      { latencyMs: null },
      { latencyMs: null },
    ]);

    expect(latencies).toEqual([]);
    expect(percentile(0.5)).toBe(0);
    expect(percentile(0.95)).toBe(0);
  });

  it("records latencySampleCount equal to the terminal run count for the all-success fixture replay", async () => {
    const benchmark = await load("benchmark-fixture-v5.json");
    const shadow = await load("shadow-fixture-v5.json");

    expect(benchmark.latencySampleCount).toBe(benchmark.terminalRuns);
    expect(shadow.latencySampleCount).toBe(shadow.terminalRuns);
    expect(benchmark.latencyMs.p95).toBeGreaterThan(0);
  });
});
