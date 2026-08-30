import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareEvaluationAnnotationPasses,
  parseEvaluationAnnotationPass,
  prepareEvaluationAnnotationPacket,
  serializeEvaluationAnnotationPacket,
} from "@hn-knowledge/application";

const calibrationRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(calibrationRoot, "../..");
const captureDirectory = path.join(calibrationRoot, "capture-33010-33099");
const threshold = 0.75;

const batches = [
  {
    directory: "v1",
    batchId: "calibration-v1",
    annotationNamespace: "v9001",
    minMessageId: 33038,
    maxMessageId: 33068,
  },
  {
    directory: "v2",
    batchId: "calibration-v2",
    annotationNamespace: "v9002",
    minMessageId: 33069,
    maxMessageId: 33099,
  },
];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;
const parseJsonLines = (text) =>
  text
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
const writeExclusive = (filePath, contents) =>
  writeFile(filePath, contents, { flag: "wx" });

const readInputs = async () => {
  const capture = JSON.parse(
    await readFile(path.join(captureDirectory, "hn-items.json"), "utf8"),
  );
  const sourceText = await readFile(
    path.join(captureDirectory, "source.json"),
    "utf8",
  );
  const source = JSON.parse(sourceText);
  if (!Array.isArray(capture.resolutions) || !Array.isArray(source.documents)) {
    throw new TypeError("Calibration capture/source shape is invalid");
  }
  return { capture, source, sourceText };
};

const historicalCommentIds = async () => {
  const manifests = await Promise.all(
    ["v1.json", "v2.json"].map(async (name) =>
      JSON.parse(
        await readFile(
          path.join(repositoryRoot, "evaluation/cycles", name),
          "utf8",
        ),
      ),
    ),
  );
  return new Set(
    manifests.flatMap((manifest) => manifest.source?.commentIds ?? []),
  );
};

const prepare = async () => {
  const { capture, source } = await readInputs();
  const sourceByCommentId = new Map(
    source.documents.map((document) => [document.commentId, document]),
  );
  const historical = await historicalCommentIds();
  const guideText = await readFile(
    path.join(repositoryRoot, "docs/annotation-guide.md"),
    "utf8",
  );

  for (const batch of batches) {
    const resolutions = capture.resolutions.filter(
      (resolution) =>
        resolution.messageId >= batch.minMessageId &&
        resolution.messageId <= batch.maxMessageId,
    );
    const commentIds = resolutions.map(
      (resolution) => resolution.selectedCommentId,
    );
    if (resolutions.length !== 31 || new Set(commentIds).size !== 31) {
      throw new Error(`${batch.batchId} must contain 31 unique comments`);
    }
    const overlap = commentIds.filter((commentId) => historical.has(commentId));
    if (overlap.length > 0) {
      throw new Error(
        `${batch.batchId} overlaps a numbered cycle: ${overlap.join(", ")}`,
      );
    }
    const documents = commentIds
      .map((commentId) => {
        const document = sourceByCommentId.get(commentId);
        if (document === undefined) {
          throw new Error(`Missing source document ${commentId}`);
        }
        return document;
      })
      .sort((left, right) => left.commentId - right.commentId);

    const batchDirectory = path.join(calibrationRoot, batch.directory);
    const packetDirectory = path.join(batchDirectory, "packets");
    await mkdir(packetDirectory, { recursive: true });
    const batchSourceText = serialize({ schemaVersion: 1, documents });
    await writeExclusive(
      path.join(batchDirectory, "source.json"),
      batchSourceText,
    );

    const packetRecords = [];
    for (const annotatorId of ["A", "B"]) {
      const rows = prepareEvaluationAnnotationPacket({
        cycleId: batch.annotationNamespace,
        annotatorId,
        documents,
        expectedCommentIds: documents.map((document) => document.commentId),
      });
      const packetText = serializeEvaluationAnnotationPacket(rows);
      const filename = `annotator-${annotatorId.toLowerCase()}.jsonl`;
      await writeExclusive(path.join(packetDirectory, filename), packetText);
      packetRecords.push({
        annotatorId,
        path: `packets/${filename}`,
        rows: rows.length,
        sha256: sha256(packetText),
      });
    }

    const manifest = {
      schemaVersion: "calibration-manifest.v1",
      batchId: batch.batchId,
      annotationNamespace: batch.annotationNamespace,
      excludedFromNumberedCycles: true,
      mayNeverEnterEvaluationCycle: true,
      guide: {
        path: "docs/annotation-guide.md",
        sha256: sha256(guideText),
      },
      capture: {
        path: "evaluation/calibration/capture-33010-33099",
        transportMessageWindow: { minId: 33010, maxId: 33099 },
        selectedMessageWindow: {
          minId: batch.minMessageId,
          maxId: batch.maxMessageId,
        },
        ignoredPrefixMessageWindow: { minId: 33010, maxId: 33037 },
      },
      source: {
        path: `evaluation/calibration/${batch.directory}/source.json`,
        sha256: sha256(batchSourceText),
        rows: documents.length,
        commentIds: documents.map((document) => document.commentId),
      },
      packets: packetRecords,
      includesHoldoutAssignment: false,
      includesModelPredictions: false,
    };
    await writeExclusive(
      path.join(batchDirectory, "manifest.json"),
      serialize(manifest),
    );
  }

  console.log(
    JSON.stringify(
      {
        prepared: batches.map((batch) => ({
          batchId: batch.batchId,
          rows: 31,
          messageWindow: `${batch.minMessageId}..${batch.maxMessageId}`,
        })),
        excludedPrefix: "33010..33037",
      },
      null,
      2,
    ),
  );
};

const compare = async (batchDirectoryName) => {
  const batch = batches.find(
    (candidate) => candidate.directory === batchDirectoryName,
  );
  if (batch === undefined) {
    throw new TypeError("Usage: harness.mjs compare v1|v2");
  }
  const batchDirectory = path.join(calibrationRoot, batch.directory);
  const sourceText = await readFile(
    path.join(batchDirectory, "source.json"),
    "utf8",
  );
  const source = JSON.parse(sourceText);
  const expectedCommentIds = source.documents.map(
    (document) => document.commentId,
  );
  const passTexts = await Promise.all(
    ["a", "b"].map((id) =>
      readFile(path.join(batchDirectory, `annotator-${id}.jsonl`), "utf8"),
    ),
  );
  if (sha256(passTexts[0]) === sha256(passTexts[1])) {
    throw new Error("Calibration annotation passes must have distinct hashes");
  }
  const annotatorA = parseEvaluationAnnotationPass({
    cycleId: batch.annotationNamespace,
    annotatorId: "A",
    documents: source.documents,
    expectedCommentIds,
    rows: parseJsonLines(passTexts[0]),
  });
  const annotatorB = parseEvaluationAnnotationPass({
    cycleId: batch.annotationNamespace,
    annotatorId: "B",
    documents: source.documents,
    expectedCommentIds,
    rows: parseJsonLines(passTexts[1]),
  });
  const comparison = compareEvaluationAnnotationPasses({
    annotatorA,
    annotatorB,
  });
  const report = {
    schemaVersion: "calibration-comparison.v1",
    batchId: batch.batchId,
    annotationNamespace: batch.annotationNamespace,
    excludedFromNumberedCycles: true,
    threshold,
    sourceSha256: sha256(sourceText),
    annotatorPasses: {
      A: { rows: annotatorA.length, sha256: sha256(passTexts[0]) },
      B: { rows: annotatorB.length, sha256: sha256(passTexts[1]) },
    },
    rows: comparison.rows,
    exactDecisionAgreementRows: comparison.exactDecisionAgreementRows,
    primaryClassKappa: comparison.primaryClassKappa,
    materialRelevanceKappa: comparison.materialRelevanceKappa,
    passed: comparison.passed,
    disagreements: comparison.disagreements.map((disagreement) => ({
      commentId: disagreement.commentId,
      materialRelevance: disagreement.materialRelevance,
      primaryClass: disagreement.primaryClass,
    })),
  };
  await writeExclusive(
    path.join(batchDirectory, "comparison.json"),
    serialize(report),
  );
  console.log(JSON.stringify(report, null, 2));
};

const command = process.argv[2];
if (command === "prepare") {
  await prepare();
} else if (command === "compare") {
  await compare(process.argv[3]);
} else {
  throw new TypeError("Usage: harness.mjs prepare | compare v1|v2");
}
