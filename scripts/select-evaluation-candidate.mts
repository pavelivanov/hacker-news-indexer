import { createHash } from "node:crypto";
import { readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CLASSIFICATION_DECISION_ROUTER_VERSION,
  CLASSIFICATION_EVALUATION_REPORT_VERSION,
  CLASSIFICATION_PROMPT_VERSION,
  CLASSIFICATION_SYSTEM_PROMPT,
  assertEvaluationDevelopmentMayRun,
  assertEvaluationHypothesisMatches,
  parseEvaluationCycleManifest,
  parseEvaluationHypothesis,
  parseEvaluationHypothesisReference,
  selectEvaluationCandidate,
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
    "Usage: npm run evaluation:select-candidate -- --cycle v2 --report evaluation/reports/<development-report>.json",
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
assertEvaluationDevelopmentMayRun(manifest);

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
    "Candidate report must be a JSON file under evaluation/reports",
  );
}
const reportText = await readFile(reportPath, "utf8");
const reportValue = JSON.parse(reportText) as unknown;
if (
  reportValue === null ||
  Array.isArray(reportValue) ||
  typeof reportValue !== "object"
) {
  throw new TypeError("Candidate report must be a JSON object");
}
const report = reportValue as Record<string, unknown>;
const stringField = (name: string): string => {
  const value = report[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`Candidate report ${name} is invalid`);
  }
  return value;
};
const numberField = (name: string): number => {
  const value = report[name];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`Candidate report ${name} is invalid`);
  }
  return value as number;
};
const booleanField = (name: string): boolean => {
  const value = report[name];
  if (typeof value !== "boolean") {
    throw new TypeError(`Candidate report ${name} is invalid`);
  }
  return value;
};
const objectField = (name: string): Record<string, unknown> => {
  const value = report[name];
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`Candidate report ${name} is invalid`);
  }
  return value as Record<string, unknown>;
};

const reportCycleId = stringField("cycleId");
const reportProvider = stringField("provider");
const reportModelId = stringField("modelId");
const reportModelConfigId = stringField("modelConfigId");
const reportPromptVersion = stringField("promptVersion");
const reportPromptHash = stringField("promptHash");
const configuration = objectField("configuration");
const reasoningEffort = configuration["reasoningEffort"];
if (typeof reasoningEffort !== "string" || reasoningEffort.trim() === "") {
  throw new TypeError(
    "Candidate report configuration.reasoningEffort is invalid",
  );
}

if (
  report["reportVersion"] !== CLASSIFICATION_EVALUATION_REPORT_VERSION ||
  report["decisionRouterVersion"] !== CLASSIFICATION_DECISION_ROUTER_VERSION ||
  report["promptVersion"] !== CLASSIFICATION_PROMPT_VERSION ||
  report["promptHash"] !== sha256(CLASSIFICATION_SYSTEM_PROMPT) ||
  report["schemaVersion"] !== "classification.v1"
) {
  throw new TypeError(
    "Candidate report does not match the current classification compatibility set",
  );
}

const hypothesisReference = parseEvaluationHypothesisReference(
  report["hypothesis"],
);
const hypothesisText = await readFile(
  path.resolve(root, hypothesisReference.path),
  "utf8",
);
if (sha256(hypothesisText) !== hypothesisReference.sha256) {
  throw new Error("Candidate evaluation hypothesis digest has changed");
}
const hypothesis = parseEvaluationHypothesis(
  JSON.parse(hypothesisText) as unknown,
);
assertEvaluationHypothesisMatches(hypothesis, {
  cycleId: reportCycleId,
  mode: "benchmark",
  provider: reportProvider,
  modelId: reportModelId,
  modelConfigId: reportModelConfigId,
  reasoningEffort,
  promptVersion: reportPromptVersion,
  promptHash: reportPromptHash,
  decisionRouterVersion: CLASSIFICATION_DECISION_ROUTER_VERSION,
});

const updatedManifest = selectEvaluationCandidate(manifest, {
  cycleId: reportCycleId,
  mode: stringField("mode"),
  split: stringField("split"),
  rows: numberField("rows"),
  terminalRuns: numberField("terminalRuns"),
  activatedDecisions: numberField("activatedDecisions"),
  passed: booleanField("passed"),
  corpusSha256: stringField("corpusSha256"),
  sourceSha256: stringField("sourceSha256"),
  provider: reportProvider,
  modelId: reportModelId,
  modelConfigId: reportModelConfigId,
  promptVersion: reportPromptVersion,
  promptHash: reportPromptHash,
  developmentReport: {
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
  `.${cycleId}.json.select-${process.pid}`,
);
let renamed = false;
try {
  await writeFile(
    temporaryPath,
    serializeEvaluationCycleManifest(updatedManifest),
    { flag: "wx" },
  );
  if ((await readFile(manifestPath, "utf8")) !== manifestTexts.get(cycleId)) {
    throw new Error(`${cycleId} manifest changed during candidate selection`);
  }
  await rename(temporaryPath, manifestPath);
  renamed = true;
} finally {
  if (!renamed) {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

console.log(
  JSON.stringify(
    {
      cycleId,
      status: updatedManifest.status,
      provider: updatedManifest.candidate?.provider,
      modelId: updatedManifest.candidate?.modelId,
      developmentReport: updatedManifest.candidate?.developmentReport,
      activatedDecisions: 0,
    },
    null,
    2,
  ),
);
