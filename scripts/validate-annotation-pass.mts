import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
  parseEvaluationCycleManifest,
  validateEvaluationAnnotationPass,
  validateEvaluationCycleSet,
  type EvaluationAnnotationSourceDocument,
  type EvaluationAnnotatorId,
} from "../packages/application/src/index.ts";

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const cycleId = argument("--cycle");
const annotatorValue = argument("--annotator");
const inputArgument = argument("--input");
if (
  cycleId === undefined ||
  (annotatorValue !== "A" && annotatorValue !== "B") ||
  inputArgument === undefined
) {
  throw new TypeError(
    "Usage: npm run evaluation:validate-annotation -- --cycle v2 --annotator A|B --input <annotation-pass.jsonl>",
  );
}
const annotatorId: EvaluationAnnotatorId = annotatorValue;
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
const sourceText = await readFile(
  path.resolve(root, manifest.source.path),
  "utf8",
);
const sourceSha256 = createHash("sha256").update(sourceText).digest("hex");
if (sourceSha256 !== manifest.source.sha256) {
  throw new Error(`${cycleId} source digest differs from its frozen manifest`);
}
const source = JSON.parse(sourceText) as {
  readonly documents?: readonly EvaluationAnnotationSourceDocument[];
};
if (!Array.isArray(source.documents)) {
  throw new TypeError(`${cycleId} source must contain a documents array`);
}
const inputPath = path.resolve(inputArgument);
const inputText = await readFile(inputPath, "utf8");
const rows = inputText
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new TypeError(`Input row ${index + 1} is not valid JSON`);
    }
  });
const summary = validateEvaluationAnnotationPass({
  cycleId,
  annotatorId,
  documents: source.documents,
  expectedCommentIds: manifest.source.commentIds,
  rows,
});

console.log(
  JSON.stringify(
    {
      cycleId,
      annotatorId,
      inputSha256: createHash("sha256").update(inputText).digest("hex"),
      ...summary,
    },
    null,
    2,
  ),
);
