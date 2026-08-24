import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface EvaluationReport {
  readonly provider: string;
  readonly modelId: string;
  readonly mode: string;
  readonly split: string;
  readonly rows: number;
  readonly terminalRuns: number;
  readonly activatedDecisions: number;
  readonly macroF1: number;
  readonly discoveryPrecision: number;
  readonly expertNotePrecision: number;
  readonly urlGroundingPrecision: number;
  readonly inventedUrlCount: number;
  readonly evidenceOriginAccuracy: number;
  readonly spanValidation: number;
  readonly schemaValidRate: number;
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
  expect(report.discoveryPrecision).toBeGreaterThanOrEqual(0.93);
  expect(report.expertNotePrecision).toBeGreaterThanOrEqual(0.88);
  expect(report.urlGroundingPrecision).toBe(1);
  expect(report.inventedUrlCount).toBe(0);
  expect(report.evidenceOriginAccuracy).toBeGreaterThanOrEqual(0.97);
  expect(report.spanValidation).toBe(1);
  expect(report.schemaValidRate).toBeGreaterThanOrEqual(0.995);
  expect(report.adversarial.cases).toBeGreaterThanOrEqual(4);
  expect(report.adversarial.toolActions).toBe(0);
  expect(report.adversarial.networkActions).toBe(0);
};

describe("classification evaluation gates", () => {
  it("benchmarks only the development split", async () => {
    const report = await load("benchmark-fixture-v1.json");

    expect(report).toMatchObject({
      mode: "benchmark",
      split: "development",
      rows: 69,
      terminalRuns: 69,
      activatedDecisions: 0,
    });
    expectAcceptanceGates(report);
  });

  it("passes the frozen 98-comment shadow replay without publication", async () => {
    const report = await load("shadow-fixture-v1.json");

    expect(report).toMatchObject({
      mode: "shadow",
      split: "all",
      rows: 98,
      terminalRuns: 98,
      activatedDecisions: 0,
    });
    expectAcceptanceGates(report);
  });

  it("keeps reports free of prompts, source documents, and provider output", async () => {
    const text = await readFile(
      "evaluation/reports/shadow-fixture-v1.json",
      "utf8",
    );

    expect(text).not.toContain("rawOutput");
    expect(text).not.toContain("providerOutput");
    expect(text).not.toContain("documents");
    expect(text).not.toContain("SYSTEM:");
    expect(text).not.toContain("https://");
  });

  it.each([
    "benchmark-openai-gpt-5-6-luna-low-v1.json",
    "benchmark-openai-gpt-5-6-luna-medium-v1.json",
  ])("records a development-only rejection in %s", async (name) => {
    const report = await load(name);

    expect(report).toMatchObject({
      provider: "openai",
      modelId: "gpt-5.6-luna",
      mode: "benchmark",
      split: "development",
      rows: 69,
      terminalRuns: 69,
      activatedDecisions: 0,
      passed: false,
    });
  });

  it("keeps live reports aggregate-only and does not check in a holdout report", async () => {
    const names = [
      "benchmark-openai-gpt-5-6-luna-low-v1.json",
      "benchmark-openai-gpt-5-6-luna-medium-v1.json",
    ];
    for (const name of names) {
      const text = await readFile(`evaluation/reports/${name}`, "utf8");
      expect(text).not.toContain("rawOutput");
      expect(text).not.toContain("providerOutput");
      expect(text).not.toContain('"documents"');
      expect(text).not.toContain('"instructions"');
      expect(text).not.toContain("authorization");
    }

    await expect(
      readFile(
        "evaluation/reports/holdout-openai-gpt-5-6-luna-low-v1.json",
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
