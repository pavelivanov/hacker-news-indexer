import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import {
  parseEvaluationCycleManifest,
  prepareEvaluationCycle,
  serializeEvaluationCycleManifest,
  serializeEvaluationHoldout,
  validateEvaluationCycleSet,
  type EvaluationCycleManifest,
} from "../packages/application/src/index.ts";

const root = process.cwd();

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const cycleId = argument("--cycle");
const sourceArgument = argument("--source");
if (cycleId === undefined || sourceArgument === undefined) {
  throw new TypeError(
    "Usage: npm run evaluation:prepare-cycle -- --cycle v2 --source <fresh-source.json> [--holdout-size <count>]",
  );
}

const repositoryPath = (
  value: string,
): { absolute: string; relative: string } => {
  const absolute = path.resolve(root, value);
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  if (relative === "" || relative === ".." || relative.startsWith("../")) {
    throw new TypeError(
      "Evaluation cycle paths must stay inside the repository",
    );
  }
  return { absolute, relative };
};

const cyclesDirectory = path.join(root, "evaluation/cycles");
await mkdir(cyclesDirectory, { recursive: true });
const manifestNames = (await readdir(cyclesDirectory)).filter((name) =>
  /^v[1-9][0-9]*\.json$/u.test(name),
);
const priorManifests: EvaluationCycleManifest[] = [];
for (const name of manifestNames) {
  const value = JSON.parse(
    await readFile(path.join(cyclesDirectory, name), "utf8"),
  ) as unknown;
  priorManifests.push(parseEvaluationCycleManifest(value));
}
if (priorManifests.length > 0) {
  validateEvaluationCycleSet(priorManifests);
}

const sourcePath = repositoryPath(sourceArgument);
const sourceText = await readFile(sourcePath.absolute, "utf8");
const sourceValue = JSON.parse(sourceText) as {
  readonly documents?: readonly { readonly commentId?: unknown }[];
};
if (!Array.isArray(sourceValue.documents)) {
  throw new TypeError("Fresh source must contain a documents array");
}
const commentIds = sourceValue.documents.map((document, index) => {
  if (document === null || typeof document !== "object") {
    throw new TypeError(`documents[${index}] must be an object`);
  }
  if (!Number.isSafeInteger(document.commentId)) {
    throw new TypeError(`documents[${index}].commentId must be an integer`);
  }
  return document.commentId as number;
});

const holdoutPath = repositoryPath(`evaluation/holdout-${cycleId}.json`);
const manifestPath = repositoryPath(`evaluation/cycles/${cycleId}.json`);
const holdoutSizeArgument = argument("--holdout-size");
const holdoutSize =
  holdoutSizeArgument === undefined ? undefined : Number(holdoutSizeArgument);
const prepared = prepareEvaluationCycle({
  cycleId,
  source: {
    path: sourcePath.relative,
    sha256: createHash("sha256").update(sourceText).digest("hex"),
    commentIds,
  },
  holdoutPath: holdoutPath.relative,
  priorManifests,
  ...(holdoutSize === undefined ? {} : { holdoutSize }),
});

let holdoutHandle: FileHandle | null = null;
let manifestHandle: FileHandle | null = null;
let holdoutCreated = false;
let manifestCreated = false;
try {
  holdoutHandle = await open(holdoutPath.absolute, "wx");
  holdoutCreated = true;
  manifestHandle = await open(manifestPath.absolute, "wx");
  manifestCreated = true;
  await holdoutHandle.writeFile(serializeEvaluationHoldout(prepared.holdout));
  await manifestHandle.writeFile(
    serializeEvaluationCycleManifest(prepared.manifest),
  );
} catch (error) {
  await holdoutHandle?.close();
  await manifestHandle?.close();
  holdoutHandle = null;
  manifestHandle = null;
  if (holdoutCreated) {
    await unlink(holdoutPath.absolute).catch(() => undefined);
  }
  if (manifestCreated) {
    await unlink(manifestPath.absolute).catch(() => undefined);
  }
  throw error;
} finally {
  await holdoutHandle?.close();
  await manifestHandle?.close();
}

console.log(
  `Prepared ${cycleId}: ${prepared.manifest.split.developmentCommentIds.length} development and ${prepared.manifest.split.holdoutCommentIds.length} sealed holdout rows`,
);
