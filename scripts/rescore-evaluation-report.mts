import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { format } from "prettier";

interface DiscoveryDiagnostic {
  readonly expectedUrlCandidateIds: readonly string[];
  readonly predictedUrlCandidateIds: readonly string[];
}

interface UnmatchedDiscoveryDiagnostic {
  readonly urlCandidateIds: readonly string[];
}

interface SafeCase {
  readonly goldStatus: string;
  readonly discoveryDiagnostics: {
    readonly matches: readonly DiscoveryDiagnostic[];
    readonly unmatchedExpected: readonly UnmatchedDiscoveryDiagnostic[];
    readonly unmatchedPredicted: readonly UnmatchedDiscoveryDiagnostic[];
  };
}

interface UrlMetrics {
  readonly predictedUrlIds: number;
  readonly expectedUrlIds: number;
  readonly correctUrlIds: number;
  readonly urlGroundingPrecision: number;
  readonly urlGroundingRecall: number;
}

interface EvaluationReport {
  readonly reportVersion: number;
  readonly mode: string;
  readonly provider: string;
  readonly rows: number;
  readonly extraction: Record<string, unknown>;
  readonly stableGold: {
    readonly extraction: Record<string, unknown>;
    readonly [key: string]: unknown;
  };
  readonly cases: readonly SafeCase[];
  readonly acceptance: Readonly<Record<string, boolean>>;
  readonly rescoring?: {
    readonly rule: string;
    readonly providerCalls: number;
  };
  readonly [key: string]: unknown;
}

const argument = (name: string): string | null => {
  const index = process.argv.lastIndexOf(name);
  return index < 0 ? null : (process.argv[index + 1] ?? null);
};

const ratio = (numerator: number, denominator: number): number =>
  denominator === 0 ? 1 : numerator / denominator;

const urlMetricsFor = (cases: readonly SafeCase[]): UrlMetrics => {
  let predictedUrlIds = 0;
  let expectedUrlIds = 0;
  let correctUrlIds = 0;
  for (const entry of cases) {
    const expectedIds = [
      ...entry.discoveryDiagnostics.matches.flatMap(
        (match) => match.expectedUrlCandidateIds,
      ),
      ...entry.discoveryDiagnostics.unmatchedExpected.flatMap(
        (discovery) => discovery.urlCandidateIds,
      ),
    ];
    const predictedIds = [
      ...entry.discoveryDiagnostics.matches.flatMap(
        (match) => match.predictedUrlCandidateIds,
      ),
      ...entry.discoveryDiagnostics.unmatchedPredicted.flatMap(
        (discovery) => discovery.urlCandidateIds,
      ),
    ];
    expectedUrlIds += expectedIds.length;
    predictedUrlIds += predictedIds.length;
    const remainingExpectedIds = new Map<string, number>();
    for (const id of expectedIds) {
      remainingExpectedIds.set(id, (remainingExpectedIds.get(id) ?? 0) + 1);
    }
    for (const id of predictedIds) {
      const remaining = remainingExpectedIds.get(id) ?? 0;
      if (remaining > 0) {
        correctUrlIds += 1;
        remainingExpectedIds.set(id, remaining - 1);
      }
    }
  }
  return {
    predictedUrlIds,
    expectedUrlIds,
    correctUrlIds,
    urlGroundingPrecision: ratio(correctUrlIds, predictedUrlIds),
    urlGroundingRecall: ratio(correctUrlIds, expectedUrlIds),
  };
};

const input = argument("--input");
if (input === null) {
  throw new Error("--input is required");
}
const root = path.resolve(process.cwd());
const inputPath = path.resolve(root, input);
const inputText = await readFile(inputPath, "utf8");
const report = JSON.parse(inputText) as EvaluationReport;
if (
  report.reportVersion !== 3 ||
  report.mode !== "benchmark" ||
  report.provider === "fixture" ||
  report.cases.length !== report.rows
) {
  throw new Error("Only complete live benchmark v3 reports can be rescored");
}
if (
  report.rescoring?.rule === "row-level-gold-url-candidate-membership.v1" &&
  report.rescoring.providerCalls === 0
) {
  console.log(
    JSON.stringify(
      {
        reportPath: path.relative(root, inputPath),
        passed: Object.values(report.acceptance).every(Boolean),
        providerCalls: 0,
        alreadyRescored: true,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const fullUrlMetrics = urlMetricsFor(report.cases);
const stableUrlMetrics = urlMetricsFor(
  report.cases.filter((entry) => entry.goldStatus === "CONSENSUS"),
);
const acceptance = {
  ...report.acceptance,
  stableGoldUrlGroundingPrecision: stableUrlMetrics.urlGroundingPrecision === 1,
};
const rescored = {
  ...report,
  extraction: { ...report.extraction, ...fullUrlMetrics },
  stableGold: {
    ...report.stableGold,
    extraction: {
      ...report.stableGold.extraction,
      ...stableUrlMetrics,
    },
  },
  urlGroundingPrecision: fullUrlMetrics.urlGroundingPrecision,
  urlGroundingRecall: fullUrlMetrics.urlGroundingRecall,
  acceptance,
  passed: Object.values(acceptance).every(Boolean),
  rescoring: {
    sourceReportSha256: createHash("sha256").update(inputText).digest("hex"),
    rule: "row-level-gold-url-candidate-membership.v1",
    providerCalls: 0,
  },
};

await writeFile(
  inputPath,
  await format(JSON.stringify(rescored), { parser: "json" }),
  "utf8",
);
console.log(
  JSON.stringify(
    {
      reportPath: path.relative(root, inputPath),
      stableGoldUrlGroundingPrecision: stableUrlMetrics.urlGroundingPrecision,
      stableGoldUrlGroundingRecall: stableUrlMetrics.urlGroundingRecall,
      passed: rescored.passed,
      providerCalls: 0,
    },
    null,
    2,
  ),
);
