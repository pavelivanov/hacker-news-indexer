import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  parseEvaluationCycleManifest,
  prepareEvaluationAnnotationPacket,
  serializeEvaluationAnnotationPacket,
  validateEvaluationCycleSet,
  type EvaluationAnnotationSourceDocument,
  type EvaluationAnnotatorId,
} from "../packages/application/src/index.ts";

const root = process.cwd();

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const cycleId = argument("--cycle");
if (cycleId === undefined) {
  throw new TypeError(
    "Usage: npm run evaluation:prepare-annotations -- --cycle v2 [--output-dir /tmp/hn-v2-annotation-packets] [--chunk-size 15]",
  );
}
const chunkSize = Number(argument("--chunk-size") ?? 15);
if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 30) {
  throw new TypeError("--chunk-size must be an integer from 1 to 30");
}
const outputDirectory = path.resolve(
  argument("--output-dir") ?? `/tmp/hn-${cycleId}-annotation-packets`,
);

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
  throw new Error(`${cycleId} must be SPLIT_FROZEN before packet preparation`);
}
if (
  manifest.annotations.annotatorA !== null ||
  manifest.annotations.annotatorB !== null ||
  manifest.annotations.gold !== null
) {
  throw new Error(`${cycleId} already records annotation artifacts`);
}

const sourcePath = path.resolve(root, manifest.source.path);
const sourceText = await readFile(sourcePath, "utf8");
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

await mkdir(outputDirectory);

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const packetRecords: {
  readonly annotatorId: EvaluationAnnotatorId;
  readonly files: {
    readonly path: string;
    readonly rows: number;
    readonly sha256: string;
  }[];
}[] = [];

for (const annotatorId of ["A", "B"] as const) {
  const annotatorDirectoryName = `annotator-${annotatorId.toLowerCase()}`;
  const annotatorDirectory = path.join(outputDirectory, annotatorDirectoryName);
  await mkdir(annotatorDirectory);
  const rows = prepareEvaluationAnnotationPacket({
    cycleId,
    annotatorId,
    documents: source.documents,
    expectedCommentIds: manifest.source.commentIds,
  });
  const files: {
    path: string;
    rows: number;
    sha256: string;
  }[] = [];
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const filename = `packet-${String(files.length + 1).padStart(2, "0")}.jsonl`;
    const relativePath = `${annotatorDirectoryName}/${filename}`;
    const serialized = serializeEvaluationAnnotationPacket(chunk);
    await writeFile(path.join(outputDirectory, relativePath), serialized, {
      flag: "wx",
    });
    files.push({
      path: relativePath,
      rows: chunk.length,
      sha256: sha256(serialized),
    });
  }
  packetRecords.push({ annotatorId, files });
}

const packetManifest = {
  schemaVersion: "annotation-packet-manifest.v1",
  cycleId,
  source: {
    path: manifest.source.path,
    sha256: manifest.source.sha256,
    rows: manifest.source.commentIds.length,
  },
  guide: "docs/annotation-guide.md",
  passSchema: "evaluation/annotation-pass-schema-v2.json",
  chunkSize,
  annotators: packetRecords,
};
await writeFile(
  path.join(outputDirectory, "manifest.json"),
  `${JSON.stringify(packetManifest, null, 2)}\n`,
  { flag: "wx" },
);

console.log(
  JSON.stringify(
    {
      cycleId,
      outputDirectory,
      rows: manifest.source.commentIds.length,
      chunksPerAnnotator: packetRecords.map((entry) => entry.files.length),
      sourceSha256: manifest.source.sha256,
      includesHoldoutAssignment: false,
      includesModelPredictions: false,
    },
    null,
    2,
  ),
);
