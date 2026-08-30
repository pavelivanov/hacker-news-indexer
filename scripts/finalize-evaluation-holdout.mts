import { createHash } from "node:crypto";
import { readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertEvaluationHypothesisMatches,
  parseEvaluationCycleManifest,
  parseEvaluationHypothesis,
  parseEvaluationHypothesisReference,
  recordEvaluationHoldoutResult,
  serializeEvaluationCycleManifest,
  validateEvaluationCycleSet,
  type EvaluationCycleManifest,
} from "../packages/application/src/index.ts";

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const cycleId = argument("--cycle");
const reportArgument = argument("--report");
if (cycleId === undefined || reportArgument === undefined) {
  throw new TypeError(
    "Usage: npm run evaluation:finalize-holdout -- --cycle v2 --report evaluation/reports/<holdout-report>.json",
  );
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const root = process.cwd();
const cyclesDirectory = path.join(root, "evaluation/cycles");
const manifestNames = (await readdir(cyclesDirectory))
  .filter((name) => /^v[1-9][0-9]*\.json$/u.test(name))
  .sort();
const manifestTexts = new Map<string, string>();
const manifests: EvaluationCycleManifest[] = [];
for (const name of manifestNames) {
  const text = await readFile(path.join(cyclesDirectory, name), "utf8");
  const manifest = parseEvaluationCycleManifest(JSON.parse(text) as unknown);
  manifestTexts.set(manifest.cycleId, text);
  manifests.push(manifest);
}
validateEvaluationCycleSet(manifests);
const manifest = manifests.find((candidate) => candidate.cycleId === cycleId);
if (manifest === undefined) {
  throw new Error(`Unknown evaluation cycle ${cycleId}`);
}
if (manifest.status !== "HOLDOUT_CLAIMED" || manifest.candidate === null) {
  throw new Error(`${cycleId} holdout finalization requires HOLDOUT_CLAIMED`);
}

const reportPath = path.resolve(root, reportArgument);
const reportRelativePath = path
  .relative(root, reportPath)
  .split(path.sep)
  .join("/");
if (
  !reportRelativePath.startsWith("evaluation/reports/") ||
  !reportRelativePath.endsWith(".json")
) {
  throw new TypeError(
    "Holdout report must be a JSON file under evaluation/reports",
  );
}
const [reportText, developmentText] = await Promise.all([
  readFile(reportPath, "utf8"),
  readFile(
    path.resolve(root, manifest.candidate.developmentReport.path),
    "utf8",
  ),
]);
if (sha256(developmentText) !== manifest.candidate.developmentReport.sha256) {
  throw new Error("Frozen development report digest has changed");
}
const object = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
};
const report = object(JSON.parse(reportText) as unknown, "Holdout report");
const development = object(
  JSON.parse(developmentText) as unknown,
  "Development report",
);
const stringField = (name: string): string => {
  const value = report[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`Holdout report ${name} is invalid`);
  }
  return value;
};
const numberField = (name: string): number => {
  const value = report[name];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`Holdout report ${name} is invalid`);
  }
  return value as number;
};
const booleanField = (name: string): boolean => {
  const value = report[name];
  if (typeof value !== "boolean") {
    throw new TypeError(`Holdout report ${name} is invalid`);
  }
  return value;
};

if (
  development["cycleId"] !== manifest.cycleId ||
  development["mode"] !== "benchmark" ||
  development["split"] !== "development" ||
  development["rows"] !== manifest.split.developmentCommentIds.length ||
  development["terminalRuns"] !== development["rows"] ||
  development["activatedDecisions"] !== 0 ||
  development["passed"] !== true ||
  development["corpusSha256"] !== manifest.annotations.gold?.sha256 ||
  development["sourceSha256"] !== manifest.source.sha256 ||
  development["provider"] !== manifest.candidate.provider ||
  development["modelId"] !== manifest.candidate.modelId ||
  development["modelConfigId"] !== manifest.candidate.modelConfigId ||
  development["promptVersion"] !== manifest.candidate.promptVersion ||
  development["promptHash"] !== manifest.candidate.promptHash ||
  !Number.isSafeInteger(development["reportVersion"]) ||
  (development["reportVersion"] as number) <= 0 ||
  typeof development["decisionRouterVersion"] !== "string" ||
  development["schemaVersion"] !== "classification.v1" ||
  report["reportVersion"] !== development["reportVersion"] ||
  report["decisionRouterVersion"] !== development["decisionRouterVersion"] ||
  report["schemaVersion"] !== development["schemaVersion"]
) {
  throw new TypeError(
    "Holdout report does not match the frozen development compatibility set",
  );
}

const developmentHypothesis = parseEvaluationHypothesisReference(
  development["hypothesis"],
);
const holdoutHypothesis = parseEvaluationHypothesisReference(
  report["hypothesis"],
);
if (
  holdoutHypothesis.path !== developmentHypothesis.path ||
  holdoutHypothesis.sha256 !== developmentHypothesis.sha256
) {
  throw new TypeError(
    "Holdout report does not preserve the development hypothesis",
  );
}
const hypothesisText = await readFile(
  path.resolve(root, developmentHypothesis.path),
  "utf8",
);
if (sha256(hypothesisText) !== developmentHypothesis.sha256) {
  throw new Error("Frozen evaluation hypothesis digest has changed");
}
const configuration = object(
  development["configuration"],
  "Development report configuration",
);
const reasoningEffort = configuration["reasoningEffort"];
if (typeof reasoningEffort !== "string" || reasoningEffort.trim() === "") {
  throw new TypeError(
    "Development report configuration.reasoningEffort is invalid",
  );
}
const hypothesis = parseEvaluationHypothesis(
  JSON.parse(hypothesisText) as unknown,
);
assertEvaluationHypothesisMatches(hypothesis, {
  cycleId: manifest.cycleId,
  mode: "benchmark",
  provider: manifest.candidate.provider,
  modelId: manifest.candidate.modelId,
  modelConfigId: manifest.candidate.modelConfigId,
  reasoningEffort,
  promptVersion: manifest.candidate.promptVersion,
  promptHash: manifest.candidate.promptHash,
  decisionRouterVersion: development["decisionRouterVersion"] as string,
});

const updatedManifest = recordEvaluationHoldoutResult(manifest, {
  cycleId: stringField("cycleId"),
  mode: stringField("mode"),
  split: stringField("split"),
  rows: numberField("rows"),
  terminalRuns: numberField("terminalRuns"),
  activatedDecisions: numberField("activatedDecisions"),
  passed: booleanField("passed"),
  corpusSha256: stringField("corpusSha256"),
  sourceSha256: stringField("sourceSha256"),
  provider: stringField("provider"),
  modelId: stringField("modelId"),
  modelConfigId: stringField("modelConfigId"),
  promptVersion: stringField("promptVersion"),
  promptHash: stringField("promptHash"),
  report: {
    path: reportRelativePath,
    sha256: sha256(reportText),
  },
});
validateEvaluationCycleSet(
  manifests.map((candidate) =>
    candidate.cycleId === cycleId ? updatedManifest : candidate,
  ),
);

const manifestPath = path.join(cyclesDirectory, `${cycleId}.json`);
const temporaryPath = path.join(
  cyclesDirectory,
  `.${cycleId}.json.finalize-holdout-${process.pid}`,
);
let renamed = false;
try {
  await writeFile(
    temporaryPath,
    serializeEvaluationCycleManifest(updatedManifest),
    { flag: "wx" },
  );
  if ((await readFile(manifestPath, "utf8")) !== manifestTexts.get(cycleId)) {
    throw new Error(`${cycleId} manifest changed during holdout finalization`);
  }
  await rename(temporaryPath, manifestPath);
  renamed = true;
} finally {
  if (!renamed) {
    await unlink(temporaryPath).catch(() => undefined);
  }
}
await unlink(`${reportPath}.attempt`).catch(() => undefined);

console.log(
  JSON.stringify(
    {
      cycleId,
      status: updatedManifest.status,
      passed: updatedManifest.holdoutOpening?.passed,
      report: updatedManifest.holdoutOpening?.report,
      activatedDecisions: 0,
    },
    null,
    2,
  ),
);
