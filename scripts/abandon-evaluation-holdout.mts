import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
  abandonEvaluationHoldoutClaim,
  parseEvaluationCycleManifest,
  validateEvaluationCycleSet,
  type EvaluationCycleManifest,
} from "../packages/application/src/index.ts";

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const cycleId = argument("--cycle");
if (cycleId === undefined) {
  throw new TypeError(
    "Usage: npm run evaluation:abandon-holdout -- --cycle v2",
  );
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const root = process.cwd();
const cyclesDirectory = path.join(root, "evaluation/cycles");
const reportsDirectory = path.join(root, "evaluation/reports");
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
  throw new Error(`${cycleId} claim abandonment requires HOLDOUT_CLAIMED`);
}

const reportNames = (await readdir(reportsDirectory)).filter(
  (name) =>
    name.startsWith(`holdout-${cycleId}-`) &&
    name.endsWith(".json") &&
    !name.endsWith(".attempt"),
);
if (reportNames.length > 0) {
  throw new Error(
    `${cycleId} already has a holdout report; use evaluation:finalize-holdout instead`,
  );
}
const attemptMarkerPaths = (await readdir(reportsDirectory))
  .filter(
    (name) =>
      name.startsWith(`holdout-${cycleId}-`) && name.endsWith(".attempt"),
  )
  .map((name) => path.join(reportsDirectory, name));
if (attemptMarkerPaths.length === 0) {
  throw new Error(
    `${cycleId} has no stale holdout attempt marker; refusing to abandon`,
  );
}

const developmentText = await readFile(
  path.resolve(root, manifest.candidate.developmentReport.path),
  "utf8",
);
if (sha256(developmentText) !== manifest.candidate.developmentReport.sha256) {
  throw new Error("Frozen development report digest has changed");
}

const abandoned = await abandonEvaluationHoldoutClaim(manifest, {
  manifestPath: path.join(cyclesDirectory, `${cycleId}.json`),
  manifestText: manifestTexts.get(cycleId) as string,
  attemptMarkerPaths,
  existingHoldoutReportPaths: [],
  abandonedAt: new Date().toISOString(),
  companionManifests: manifests.filter(
    (candidate) => candidate.cycleId !== cycleId,
  ),
});
validateEvaluationCycleSet(
  manifests.map((candidate) =>
    candidate.cycleId === cycleId ? abandoned.manifest : candidate,
  ),
);

console.log(
  JSON.stringify(
    {
      cycleId,
      previousStatus: "HOLDOUT_CLAIMED",
      status: abandoned.manifest.status,
      claimAbandonedAt: abandoned.manifest.claimAbandonedAt,
      removedAttemptMarkers: abandoned.removedAttemptMarkerPaths.map(
        (markerPath) => path.relative(root, markerPath),
      ),
      providerCallsMade: 0,
      holdoutReportWritten: false,
    },
    null,
    2,
  ),
);
