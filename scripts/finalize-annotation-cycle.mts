import { createHash } from "node:crypto";
import { readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  finalizeEvaluationAnnotations,
  parseEvaluationAnnotationPass,
  parseEvaluationCycleManifest,
  serializeEvaluationCycleManifest,
  serializeEvaluationGoldV2,
  validateEvaluationCycleSet,
  type EvaluationAnnotationSourceDocument,
  type EvaluationCycleManifest,
} from "../packages/application/src/index.ts";

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const cycleId = argument("--cycle");
const annotatorAArgument = argument("--annotator-a");
const annotatorBArgument = argument("--annotator-b");
const adjudicationArgument = argument("--adjudication");
if (
  cycleId === undefined ||
  annotatorAArgument === undefined ||
  annotatorBArgument === undefined ||
  adjudicationArgument === undefined
) {
  throw new TypeError(
    "Usage: npm run evaluation:finalize-annotations -- --cycle v2 --annotator-a <a.jsonl> --annotator-b <b.jsonl> --adjudication <responses.jsonl>",
  );
}

const root = process.cwd();
const cyclesDirectory = path.join(root, "evaluation/cycles");
const cycleManifestNames = (await readdir(cyclesDirectory)).filter((name) =>
  /^v[1-9][0-9]*\.json$/u.test(name),
);
const manifests = await Promise.all(
  cycleManifestNames.map(async (name) =>
    parseEvaluationCycleManifest(
      JSON.parse(
        await readFile(path.join(cyclesDirectory, name), "utf8"),
      ) as unknown,
    ),
  ),
);
validateEvaluationCycleSet(manifests);
const manifest = manifests.find((candidate) => candidate.cycleId === cycleId);
if (manifest === undefined) {
  throw new Error(`Unknown evaluation cycle ${cycleId}`);
}
if (manifest.status !== "SPLIT_FROZEN") {
  throw new Error(`${cycleId} must be SPLIT_FROZEN before finalization`);
}
if (
  manifest.annotations.annotatorA !== null ||
  manifest.annotations.annotatorB !== null ||
  manifest.annotations.gold !== null
) {
  throw new Error(`${cycleId} already records annotation artifacts`);
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const parseJsonl = (value: string, label: string): unknown[] =>
  value
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new TypeError(`${label} row ${index + 1} is not valid JSON`);
      }
    });

const sourcePath = path.resolve(root, manifest.source.path);
const holdoutPath = path.resolve(root, manifest.split.holdoutFile.path);
const [
  sourceText,
  holdoutText,
  annotatorAText,
  annotatorBText,
  adjudicationText,
] = await Promise.all([
  readFile(sourcePath, "utf8"),
  readFile(holdoutPath, "utf8"),
  readFile(path.resolve(annotatorAArgument), "utf8"),
  readFile(path.resolve(annotatorBArgument), "utf8"),
  readFile(path.resolve(adjudicationArgument), "utf8"),
]);
if (sha256(sourceText) !== manifest.source.sha256) {
  throw new Error(`${cycleId} source digest differs from its frozen manifest`);
}
if (sha256(holdoutText) !== manifest.split.holdoutFile.sha256) {
  throw new Error(`${cycleId} holdout digest differs from its frozen manifest`);
}
if (sha256(annotatorAText) === sha256(annotatorBText)) {
  throw new Error(
    "Independent annotation pass files must have distinct hashes",
  );
}

const source = JSON.parse(sourceText) as {
  readonly documents?: readonly EvaluationAnnotationSourceDocument[];
};
if (!Array.isArray(source.documents)) {
  throw new TypeError(`${cycleId} source must contain a documents array`);
}
const holdout = JSON.parse(holdoutText) as Record<string, unknown>;
if (
  Object.keys(holdout).sort().join("\u0000") !==
    ["commentIds", "schemaVersion", "selection"].sort().join("\u0000") ||
  holdout["schemaVersion"] !== 1 ||
  typeof holdout["selection"] !== "string" ||
  !Array.isArray(holdout["commentIds"]) ||
  holdout["commentIds"].some(
    (commentId) => !Number.isSafeInteger(commentId) || commentId <= 0,
  ) ||
  holdout["commentIds"].join(",") !== manifest.split.holdoutCommentIds.join(",")
) {
  throw new TypeError(`${cycleId} holdout content is invalid`);
}
const holdoutCommentIds = holdout["commentIds"] as number[];

const annotatorA = parseEvaluationAnnotationPass({
  cycleId,
  annotatorId: "A",
  documents: source.documents,
  expectedCommentIds: manifest.source.commentIds,
  rows: parseJsonl(annotatorAText, "Annotator A"),
});
const annotatorB = parseEvaluationAnnotationPass({
  cycleId,
  annotatorId: "B",
  documents: source.documents,
  expectedCommentIds: manifest.source.commentIds,
  rows: parseJsonl(annotatorBText, "Annotator B"),
});
const finalization = finalizeEvaluationAnnotations({
  cycleId,
  annotatorA,
  annotatorB,
  rootIdsByCommentId: new Map(
    source.documents.map((document) => [document.commentId, document.rootId]),
  ),
  holdoutCommentIds,
  adjudicationRows: parseJsonl(adjudicationText, "Adjudication"),
});

const annotatorARelativePath = `evaluation/annotations/annotator-a-${cycleId}.jsonl`;
const annotatorBRelativePath = `evaluation/annotations/annotator-b-${cycleId}.jsonl`;
const adjudicationRelativePath = `evaluation/annotations/adjudication-${cycleId}.jsonl`;
const goldRelativePath = `evaluation/gold-${cycleId}.jsonl`;
const goldText = serializeEvaluationGoldV2(finalization.gold);
const updatedManifest: EvaluationCycleManifest = {
  ...manifest,
  status: "ANNOTATED",
  annotations: {
    annotatorA: {
      path: annotatorARelativePath,
      sha256: sha256(annotatorAText),
    },
    annotatorB: {
      path: annotatorBRelativePath,
      sha256: sha256(annotatorBText),
    },
    gold: { path: goldRelativePath, sha256: sha256(goldText) },
  },
};
validateEvaluationCycleSet(
  manifests.map((candidate) =>
    candidate.cycleId === cycleId ? updatedManifest : candidate,
  ),
);

const manifestPath = path.join(cyclesDirectory, `${cycleId}.json`);
const manifestTemporaryPath = path.join(
  cyclesDirectory,
  `.${cycleId}.json.finalize-${process.pid}`,
);
const artifacts = [
  [path.resolve(root, annotatorARelativePath), annotatorAText],
  [path.resolve(root, annotatorBRelativePath), annotatorBText],
  [path.resolve(root, adjudicationRelativePath), adjudicationText],
  [path.resolve(root, goldRelativePath), goldText],
] as const;
const createdPaths: string[] = [];
let manifestUpdated = false;
try {
  for (const [artifactPath, contents] of artifacts) {
    await writeFile(artifactPath, contents, { flag: "wx" });
    createdPaths.push(artifactPath);
  }
  await writeFile(
    manifestTemporaryPath,
    serializeEvaluationCycleManifest(updatedManifest),
    { flag: "wx" },
  );
  createdPaths.push(manifestTemporaryPath);
  if (
    (await readFile(manifestPath, "utf8")) !==
    serializeEvaluationCycleManifest(manifest)
  ) {
    throw new Error(`${cycleId} manifest changed during finalization`);
  }
  await rename(manifestTemporaryPath, manifestPath);
  createdPaths.pop();
  manifestUpdated = true;
} catch (error) {
  if (!manifestUpdated) {
    await Promise.all(
      createdPaths.map((createdPath) => unlink(createdPath).catch(() => {})),
    );
  }
  throw error;
}

console.log(
  JSON.stringify(
    {
      cycleId,
      status: updatedManifest.status,
      rows: finalization.gold.length,
      adjudicationRows: finalization.adjudications.length,
      exactDecisionAgreementRows:
        finalization.comparison.exactDecisionAgreementRows,
      primaryClassKappa: Number(
        finalization.comparison.primaryClassKappa.toFixed(4),
      ),
      materialRelevanceKappa: Number(
        finalization.comparison.materialRelevanceKappa.toFixed(4),
      ),
      annotatorASha256: updatedManifest.annotations.annotatorA?.sha256,
      annotatorBSha256: updatedManifest.annotations.annotatorB?.sha256,
      goldSha256: updatedManifest.annotations.gold?.sha256,
      goldPath: goldRelativePath,
      includesSourceBodiesInOutput: false,
      includesHoldoutIdsInOutput: false,
    },
    null,
    2,
  ),
);
