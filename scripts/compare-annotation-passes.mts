import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  compareEvaluationAnnotationPasses,
  MINIMUM_ANNOTATION_COHENS_KAPPA,
  parseEvaluationAnnotationPass,
  parseEvaluationCycleManifest,
  serializeEvaluationAdjudicationPacket,
  validateEvaluationCycleSet,
  type EvaluationAnnotationSourceDocument,
} from "../packages/application/src/index.ts";

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const cycleId = argument("--cycle");
const annotatorAArgument = argument("--annotator-a");
const annotatorBArgument = argument("--annotator-b");
const outputArgument = argument("--output");
if (
  cycleId === undefined ||
  annotatorAArgument === undefined ||
  annotatorBArgument === undefined ||
  outputArgument === undefined
) {
  throw new TypeError(
    "Usage: npm run evaluation:compare-annotations -- --cycle v2 --annotator-a <a.jsonl> --annotator-b <b.jsonl> --output <adjudication-packet.jsonl>",
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
  throw new Error(`${cycleId} must remain SPLIT_FROZEN during comparison`);
}

const sourceText = await readFile(
  path.resolve(root, manifest.source.path),
  "utf8",
);
const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
if (sha256(sourceText) !== manifest.source.sha256) {
  throw new Error(`${cycleId} source digest differs from its frozen manifest`);
}
const source = JSON.parse(sourceText) as {
  readonly documents?: readonly EvaluationAnnotationSourceDocument[];
};
if (!Array.isArray(source.documents)) {
  throw new TypeError(`${cycleId} source must contain a documents array`);
}

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

const [annotatorAText, annotatorBText] = await Promise.all([
  readFile(path.resolve(annotatorAArgument), "utf8"),
  readFile(path.resolve(annotatorBArgument), "utf8"),
]);
const annotatorASha256 = sha256(annotatorAText);
const annotatorBSha256 = sha256(annotatorBText);
if (annotatorASha256 === annotatorBSha256) {
  throw new Error(
    "Independent annotation pass files must have distinct hashes",
  );
}
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
const comparison = compareEvaluationAnnotationPasses({
  annotatorA,
  annotatorB,
});
if (!comparison.passed) {
  throw new Error(
    `Inter-annotator kappa gate failed: primary=${comparison.primaryClassKappa.toFixed(4)}, material=${comparison.materialRelevanceKappa.toFixed(4)}, required=${MINIMUM_ANNOTATION_COHENS_KAPPA.toFixed(2)}`,
  );
}

const outputPath = path.resolve(outputArgument);
await writeFile(
  outputPath,
  serializeEvaluationAdjudicationPacket(comparison, source.documents),
  { flag: "wx" },
);
console.log(
  JSON.stringify(
    {
      cycleId,
      rows: comparison.rows,
      exactDecisionAgreementRows: comparison.exactDecisionAgreementRows,
      adjudicationRows: comparison.disagreements.length,
      primaryClassKappa: Number(comparison.primaryClassKappa.toFixed(4)),
      materialRelevanceKappa: Number(
        comparison.materialRelevanceKappa.toFixed(4),
      ),
      requiredKappa: MINIMUM_ANNOTATION_COHENS_KAPPA,
      annotatorASha256,
      annotatorBSha256,
      outputPath,
      includesHoldoutAssignment: false,
    },
    null,
    2,
  ),
);
