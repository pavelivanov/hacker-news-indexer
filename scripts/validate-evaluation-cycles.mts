import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
  parseEvaluationCycleManifest,
  validateEvaluationCycleSet,
  type EvaluationCycleManifest,
  type EvaluationFileDigest,
} from "../packages/application/src/index.ts";

interface EvaluationReport {
  readonly mode?: unknown;
  readonly split?: unknown;
  readonly rows?: unknown;
  readonly activatedDecisions?: unknown;
  readonly corpusSha256?: unknown;
  readonly provider?: unknown;
  readonly modelId?: unknown;
  readonly modelConfigId?: unknown;
  readonly promptVersion?: unknown;
  readonly promptHash?: unknown;
  readonly passed?: unknown;
}

const root = process.cwd();
const cyclesDirectory = path.join(root, "evaluation/cycles");
const names = (await readdir(cyclesDirectory))
  .filter((name) => /^v[1-9][0-9]*\.json$/u.test(name))
  .sort();
const manifests: EvaluationCycleManifest[] = [];
for (const name of names) {
  const value = JSON.parse(
    await readFile(path.join(cyclesDirectory, name), "utf8"),
  ) as unknown;
  manifests.push(parseEvaluationCycleManifest(value));
}
validateEvaluationCycleSet(manifests);

const readVerified = async (file: EvaluationFileDigest): Promise<string> => {
  const absolute = path.resolve(root, file.path);
  const relative = path.relative(root, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new TypeError(`${file.path} escapes the repository`);
  }
  const contents = await readFile(absolute, "utf8");
  const actual = createHash("sha256").update(contents).digest("hex");
  if (actual !== file.sha256) {
    throw new TypeError(`${file.path} no longer matches its frozen digest`);
  }
  return contents;
};

const readReport = async (
  file: EvaluationFileDigest,
): Promise<EvaluationReport> =>
  JSON.parse(await readVerified(file)) as EvaluationReport;

for (const manifest of manifests) {
  await readVerified(manifest.source);
  const holdout = JSON.parse(
    await readVerified(manifest.split.holdoutFile),
  ) as {
    readonly schemaVersion?: unknown;
    readonly selection?: unknown;
    readonly commentIds?: unknown;
  };
  const expectedSelection = `first ${manifest.split.holdoutCommentIds.length} IDs by SHA-256(${manifest.split.salt}:<commentId>)`;
  if (
    holdout.schemaVersion !== 1 ||
    holdout.selection !== expectedSelection ||
    JSON.stringify(holdout.commentIds) !==
      JSON.stringify(manifest.split.holdoutCommentIds)
  ) {
    throw new TypeError(
      `${manifest.cycleId} holdout file disagrees with manifest`,
    );
  }

  const annotationFiles = [
    manifest.annotations.annotatorA,
    manifest.annotations.annotatorB,
    manifest.annotations.gold,
  ];
  for (const file of annotationFiles) {
    if (file !== null) {
      await readVerified(file);
    }
  }

  if (manifest.candidate !== null) {
    const candidateReport = await readReport(
      manifest.candidate.developmentReport,
    );
    if (
      candidateReport.mode !== "benchmark" ||
      candidateReport.split !== "development" ||
      candidateReport.rows !== manifest.split.developmentCommentIds.length ||
      candidateReport.activatedDecisions !== 0 ||
      candidateReport.passed !== true ||
      candidateReport.corpusSha256 !== manifest.annotations.gold?.sha256 ||
      candidateReport.provider !== manifest.candidate.provider ||
      candidateReport.modelId !== manifest.candidate.modelId ||
      candidateReport.modelConfigId !== manifest.candidate.modelConfigId ||
      candidateReport.promptVersion !== manifest.candidate.promptVersion ||
      candidateReport.promptHash !== manifest.candidate.promptHash
    ) {
      throw new TypeError(
        `${manifest.cycleId} selected candidate disagrees with development report`,
      );
    }
  }

  if (manifest.holdoutOpening !== null) {
    if (manifest.candidate === null) {
      throw new TypeError(
        `${manifest.cycleId} holdout opening is missing its selected candidate`,
      );
    }
    const candidate = manifest.candidate;
    const report = await readReport(manifest.holdoutOpening.report);
    if (
      report.mode !== "holdout" ||
      report.split !== "holdout" ||
      report.rows !== manifest.split.holdoutCommentIds.length ||
      report.activatedDecisions !== 0 ||
      report.passed !== manifest.holdoutOpening.passed ||
      report.corpusSha256 !== manifest.annotations.gold?.sha256 ||
      report.provider !== candidate.provider ||
      report.modelId !== candidate.modelId ||
      report.modelConfigId !== candidate.modelConfigId ||
      report.promptVersion !== candidate.promptVersion ||
      report.promptHash !== candidate.promptHash
    ) {
      throw new TypeError(
        `${manifest.cycleId} holdout opening disagrees with selected candidate`,
      );
    }
  }
}

console.log(
  `Validated ${manifests.length} immutable evaluation cycle(s): ${manifests.map((manifest) => `${manifest.cycleId}:${manifest.status}`).join(", ")}`,
);
