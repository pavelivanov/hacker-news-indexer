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
  readonly reportVersion?: unknown;
  readonly cycleId?: unknown;
  readonly sourceSha256?: unknown;
  readonly mode?: unknown;
  readonly split?: unknown;
  readonly rows?: unknown;
  readonly terminalRuns?: unknown;
  readonly activatedDecisions?: unknown;
  readonly corpusSha256?: unknown;
  readonly provider?: unknown;
  readonly modelId?: unknown;
  readonly modelConfigId?: unknown;
  readonly promptVersion?: unknown;
  readonly promptHash?: unknown;
  readonly decisionRouterVersion?: unknown;
  readonly passed?: unknown;
}

interface AnnotationComparisonReport {
  readonly schemaVersion?: unknown;
  readonly cycleId?: unknown;
  readonly status?: unknown;
  readonly rows?: unknown;
  readonly exactDecisionAgreementRows?: unknown;
  readonly primaryClassKappa?: unknown;
  readonly materialRelevanceKappa?: unknown;
  readonly requiredKappa?: unknown;
  readonly passed?: unknown;
  readonly annotatorA?: unknown;
  readonly annotatorB?: unknown;
  readonly includesSourceBodies?: unknown;
  readonly includesRowIds?: unknown;
  readonly includesHoldoutAssignments?: unknown;
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

  if (manifest.annotationFailure !== null) {
    const failure = manifest.annotationFailure;
    const report = JSON.parse(
      await readVerified(failure.report),
    ) as AnnotationComparisonReport;
    if (
      report.schemaVersion !== "annotation-comparison.v1" ||
      report.cycleId !== manifest.cycleId ||
      report.status !== "ANNOTATION_FAILED" ||
      report.rows !== failure.rows ||
      report.exactDecisionAgreementRows !==
        failure.exactDecisionAgreementRows ||
      report.primaryClassKappa !== failure.primaryClassKappa ||
      report.materialRelevanceKappa !== failure.materialRelevanceKappa ||
      report.requiredKappa !== failure.requiredKappa ||
      report.passed !== false ||
      JSON.stringify(report.annotatorA) !==
        JSON.stringify(manifest.annotations.annotatorA) ||
      JSON.stringify(report.annotatorB) !==
        JSON.stringify(manifest.annotations.annotatorB) ||
      report.includesSourceBodies !== false ||
      report.includesRowIds !== false ||
      report.includesHoldoutAssignments !== false
    ) {
      throw new TypeError(
        `${manifest.cycleId} annotation failure disagrees with comparison report`,
      );
    }
  }

  let candidateReport: EvaluationReport | null = null;
  if (manifest.candidate !== null) {
    candidateReport = await readReport(manifest.candidate.developmentReport);
    if (
      (manifest.cycleId !== "v1" &&
        candidateReport.cycleId !== manifest.cycleId) ||
      (manifest.cycleId !== "v1" &&
        candidateReport.sourceSha256 !== manifest.source.sha256) ||
      candidateReport.mode !== "benchmark" ||
      candidateReport.split !== "development" ||
      candidateReport.rows !== manifest.split.developmentCommentIds.length ||
      candidateReport.terminalRuns !== candidateReport.rows ||
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
      (manifest.cycleId !== "v1" && report.cycleId !== manifest.cycleId) ||
      (manifest.cycleId !== "v1" &&
        report.sourceSha256 !== manifest.source.sha256) ||
      report.mode !== "holdout" ||
      report.split !== "holdout" ||
      report.rows !== manifest.split.holdoutCommentIds.length ||
      report.terminalRuns !== report.rows ||
      report.activatedDecisions !== 0 ||
      report.passed !== manifest.holdoutOpening.passed ||
      report.corpusSha256 !== manifest.annotations.gold?.sha256 ||
      report.provider !== candidate.provider ||
      report.modelId !== candidate.modelId ||
      report.modelConfigId !== candidate.modelConfigId ||
      report.promptVersion !== candidate.promptVersion ||
      report.promptHash !== candidate.promptHash ||
      report.reportVersion !== candidateReport?.reportVersion ||
      report.decisionRouterVersion !== candidateReport?.decisionRouterVersion
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
