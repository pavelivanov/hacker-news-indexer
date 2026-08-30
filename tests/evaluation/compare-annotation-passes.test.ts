import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  prepareEvaluationCycle,
  serializeEvaluationCycleManifest,
} from "@hn-knowledge/application";

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const commentIds = Array.from({ length: 90 }, (_, index) => 80_000_000 + index);

const documents = commentIds.map((commentId) => ({
  commentId,
  rootId: commentId,
  comment: {
    documentId: `comment:${commentId}`,
    plainText: `Comment body ${commentId}`,
  },
  root: {
    documentId: `root:${commentId}`,
    title: `Root story ${commentId}`,
    plainText: `Root body ${commentId}`,
  },
  urlCandidates: [],
}));

const passRow = (
  annotatorId: "A" | "B",
  commentId: number,
  materialRelevance: "NOT_MATERIAL" | "UNCERTAIN",
) => ({
  schemaVersion: "annotation-pass.v2",
  cycleId: "v1",
  commentId,
  materialRelevance,
  primaryClass: "REJECTED",
  discoveries: [],
  expertNote: null,
  reviewFlags:
    materialRelevance === "UNCERTAIN" ? ["AMBIGUOUS_CLASSIFICATION"] : [],
  rejectionReason: "NON_TECHNICAL",
  annotator: { id: annotatorId, method: "independent-bounded-review" },
});

const annotatorAText = `${commentIds
  .map((commentId) => JSON.stringify(passRow("A", commentId, "NOT_MATERIAL")))
  .join("\n")}\n`;
// Annotator B disagrees on material relevance for every other row so the
// comparison fails its Cohen's kappa gate (observed agreement 0.5, kappa 0).
const annotatorBText = `${commentIds
  .map((commentId, index) =>
    JSON.stringify(
      passRow("B", commentId, index % 2 === 0 ? "NOT_MATERIAL" : "UNCERTAIN"),
    ),
  )
  .join("\n")}\n`;

const temporaryRoots: string[] = [];

const prepareRoot = async (): Promise<{
  readonly root: string;
  readonly manifestPath: string;
  readonly manifestText: string;
  readonly annotatorAPath: string;
  readonly annotatorBPath: string;
  readonly reportPath: string;
}> => {
  const root = await mkdtemp(path.join(tmpdir(), "hn-compare-annotations-"));
  temporaryRoots.push(root);
  const sourceText = `${JSON.stringify({ documents }, null, 2)}\n`;
  await mkdir(path.join(root, "evaluation/cycles"), { recursive: true });
  await mkdir(path.join(root, "evaluation/reports"), { recursive: true });
  await mkdir(path.join(root, "evaluation/annotations"), { recursive: true });
  const sourcePath = path.join(root, "evaluation/source-v1.json");
  await writeFile(sourcePath, sourceText, "utf8");
  const { manifest } = prepareEvaluationCycle({
    cycleId: "v1",
    source: {
      path: "evaluation/source-v1.json",
      sha256: sha256(sourceText),
      commentIds,
    },
    holdoutPath: "evaluation/holdout-v1.json",
    priorManifests: [],
  });
  const manifestPath = path.join(root, "evaluation/cycles/v1.json");
  const manifestText = serializeEvaluationCycleManifest(manifest);
  await writeFile(manifestPath, manifestText, "utf8");
  const annotatorAPath = path.join(root, "annotator-a.jsonl");
  const annotatorBPath = path.join(root, "annotator-b.jsonl");
  await writeFile(annotatorAPath, annotatorAText, "utf8");
  await writeFile(annotatorBPath, annotatorBText, "utf8");
  return {
    root,
    manifestPath,
    manifestText,
    annotatorAPath,
    annotatorBPath,
    reportPath: path.join(
      root,
      "evaluation/reports/annotation-comparison-v1.json",
    ),
  };
};

const runComparison = (
  root: string,
  fixtures: {
    readonly annotatorAPath: string;
    readonly annotatorBPath: string;
  },
) =>
  spawnSync(
    process.execPath,
    [
      path.resolve("node_modules/tsx/dist/cli.mjs"),
      path.resolve("scripts/compare-annotation-passes.mts"),
      "--cycle",
      "v1",
      "--annotator-a",
      fixtures.annotatorAPath,
      "--annotator-b",
      fixtures.annotatorBPath,
      "--output",
      path.join(root, "adjudication-packet.jsonl"),
    ],
    { cwd: root, encoding: "utf8" },
  );

const manifestStatus = async (manifestPath: string): Promise<string> =>
  (JSON.parse(await readFile(manifestPath, "utf8")) as { status: string })
    .status;

describe("compare-annotation-passes crash recovery", () => {
  it("records the annotation failure again over a crashed run's matching artifacts", async () => {
    const fixtures = await prepareRoot();
    const first = runComparison(fixtures.root, fixtures);
    expect(first.status).toBe(1);
    expect(await manifestStatus(fixtures.manifestPath)).toBe(
      "ANNOTATION_FAILED",
    );

    // Simulate the crash: the artifacts survived but the manifest rename
    // never happened, so a rerun meets EEXIST on every artifact.
    await writeFile(fixtures.manifestPath, fixtures.manifestText, "utf8");
    const rerun = runComparison(fixtures.root, fixtures);
    expect(rerun.status).toBe(1);
    expect(rerun.stderr).not.toMatch(/EEXIST/u);
    expect(await manifestStatus(fixtures.manifestPath)).toBe(
      "ANNOTATION_FAILED",
    );
    expect(await readFile(fixtures.reportPath, "utf8")).toContain(
      '"status": "ANNOTATION_FAILED"',
    );
    expect(await readFile(fixtures.annotatorAPath, "utf8")).toBe(
      annotatorAText,
    );
    expect(await readFile(fixtures.annotatorBPath, "utf8")).toBe(
      annotatorBText,
    );
  }, 60_000);

  it("replaces mismatched artifacts left by a crashed run", async () => {
    const fixtures = await prepareRoot();
    const leftoverDirectory = path.join(
      fixtures.root,
      "evaluation/annotations/failed/v1",
    );
    const leftoverPath = path.join(leftoverDirectory, "annotator-a.jsonl");
    await mkdir(leftoverDirectory, { recursive: true });
    await writeFile(leftoverPath, "corrupted leftover\n", "utf8");

    const result = runComparison(fixtures.root, fixtures);

    expect(result.status).toBe(1);
    expect(result.stderr).not.toMatch(/EEXIST/u);
    expect(await manifestStatus(fixtures.manifestPath)).toBe(
      "ANNOTATION_FAILED",
    );
    expect(await readFile(leftoverPath, "utf8")).toBe(annotatorAText);
  }, 60_000);
});

afterAll(() => {
  // The temp directories live in the OS temp dir; the OS reclaims them. This
  // hook exists to keep temporaryRoots referenced for debugging failures.
  void temporaryRoots;
});
