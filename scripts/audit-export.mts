import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const valueAfter = (name: string): string | null => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : (process.argv[index + 1] ?? null);
};

const corpus = valueAfter("--corpus") ?? "holdout-v1";
if (corpus !== "holdout-v1") {
  throw new TypeError(
    "Only the reviewed holdout-v1 export corpus is supported",
  );
}

const sourcePath = path.resolve(
  "evaluation/reports/holdout-openai-gpt-5-6-sol-low-v3.json",
);
const approvalPath = path.resolve("contracts/findthatproject/approval-v1.json");
const sourceText = await readFile(sourcePath, "utf8");
const source = JSON.parse(sourceText) as {
  readonly reportVersion: number;
  readonly mode: string;
  readonly split: string;
  readonly activatedDecisions: number;
  readonly extraction: {
    readonly predictedDiscoveries: number;
    readonly matchedDiscoveries: number;
    readonly discoveryExtractionPrecision: number;
    readonly urlGroundingPrecision: number;
  };
};
const approval = JSON.parse(await readFile(approvalPath, "utf8")) as {
  readonly status: string;
  readonly mutatingDownstreamAuthorized: boolean;
};
if (
  source.reportVersion !== 3 ||
  source.mode !== "holdout" ||
  source.split !== "holdout"
) {
  throw new Error("Unexpected holdout report contract");
}

const reviewedCandidates = source.extraction.predictedDiscoveries;
const falsePositiveExports = Math.max(
  0,
  reviewedCandidates - source.extraction.matchedDiscoveries,
);
const precision = source.extraction.discoveryExtractionPrecision;
const report = {
  reportVersion: 1,
  corpus,
  generatedAt: new Date().toISOString(),
  sourceReport: path.relative(process.cwd(), sourcePath),
  sourceSha256: createHash("sha256").update(sourceText).digest("hex"),
  contractApproval: approval.status,
  downstreamMutationAuthorized: approval.mutatingDownstreamAuthorized,
  reviewedCandidates,
  matchedDiscoveries: source.extraction.matchedDiscoveries,
  falsePositiveExports,
  precision,
  urlGroundingPrecision: source.extraction.urlGroundingPrecision,
  activatedDecisions: source.activatedDecisions,
  automaticOutboxInsertionEnabled: false,
  gates: {
    candidatesReviewed: reviewedCandidates > 0,
    precision: precision >= 0.98,
    zeroFalsePositives: falsePositiveExports === 0,
    urlGrounding: source.extraction.urlGroundingPrecision === 1,
    contractApproved: approval.status === "APPROVED",
    noDownstreamMutation: approval.mutatingDownstreamAuthorized === false,
    noAutomaticActivation: source.activatedDecisions === 0,
  },
};
const passed = Object.values(report.gates).every(Boolean);
const output = { ...report, passed };
const outputPath = path.resolve(
  "evaluation/reports/export-audit-holdout-v1.json",
);
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ...output, outputPath })}\n`);
if (!passed) {
  process.exitCode = 1;
}
