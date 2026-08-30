import { createHash } from "node:crypto";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { MINIMUM_ANNOTATION_COHENS_KAPPA } from "./annotation-packet.js";

export const EVALUATION_CYCLE_SCHEMA_VERSION = "evaluation-cycle.v1";
export const EVALUATION_SPLIT_ALGORITHM = "SHA256_SORT_V1";
export const MINIMUM_EVALUATION_CYCLE_ROWS = 90;
export const CLASSIFICATION_EVALUATION_REPORT_VERSION = 5;

export type EvaluationCycleStatus =
  | "SPLIT_FROZEN"
  | "ANNOTATION_FAILED"
  | "ANNOTATED"
  | "CANDIDATE_SELECTED"
  | "HOLDOUT_CLAIMED"
  | "OPENED_FAILED"
  | "OPENED_PASSED";

export interface EvaluationFileDigest {
  readonly path: string;
  readonly sha256: string;
}

export interface EvaluationCycleManifest {
  readonly schemaVersion: typeof EVALUATION_CYCLE_SCHEMA_VERSION;
  readonly cycleId: string;
  readonly status: EvaluationCycleStatus;
  readonly source: EvaluationFileDigest & {
    readonly commentIds: readonly number[];
    readonly window: {
      readonly firstCommentId: number;
      readonly lastCommentId: number;
    };
  };
  readonly split: {
    readonly algorithm: typeof EVALUATION_SPLIT_ALGORITHM;
    readonly salt: string;
    readonly developmentCommentIds: readonly number[];
    readonly holdoutCommentIds: readonly number[];
    readonly holdoutFile: EvaluationFileDigest;
  };
  readonly annotations: {
    readonly annotatorA: EvaluationFileDigest | null;
    readonly annotatorB: EvaluationFileDigest | null;
    readonly gold: EvaluationFileDigest | null;
  };
  readonly annotationFailure: null | {
    readonly report: EvaluationFileDigest;
    readonly rows: number;
    readonly exactDecisionAgreementRows: number;
    readonly primaryClassKappa: number;
    readonly materialRelevanceKappa: number;
    readonly requiredKappa: number;
  };
  readonly candidate: null | {
    readonly provider: string;
    readonly modelId: string;
    readonly modelConfigId: string;
    readonly promptVersion: string;
    readonly promptHash: string;
    readonly developmentReport: EvaluationFileDigest;
  };
  readonly holdoutOpening: null | {
    readonly report: EvaluationFileDigest;
    readonly passed: boolean;
  };
  readonly claimAbandonedAt?: string;
}

export interface EvaluationHoldoutFile {
  readonly schemaVersion: 1;
  readonly selection: string;
  readonly commentIds: readonly number[];
}

export interface PrepareEvaluationCycleInput {
  readonly cycleId: string;
  readonly source: EvaluationFileDigest & {
    readonly commentIds: readonly number[];
  };
  readonly holdoutPath: string;
  readonly priorManifests: readonly EvaluationCycleManifest[];
  readonly holdoutSize?: number;
}

export interface EvaluationHoldoutCandidateInput {
  readonly corpusSha256: string;
  readonly sourceSha256: string;
  readonly provider: string;
  readonly modelId: string;
  readonly modelConfigId: string;
  readonly promptVersion: string;
  readonly promptHash: string;
}

export interface RecordEvaluationAnnotationFailureInput {
  readonly cycleId: string;
  readonly rows: number;
  readonly exactDecisionAgreementRows: number;
  readonly primaryClassKappa: number;
  readonly materialRelevanceKappa: number;
  readonly requiredKappa: number;
  readonly annotatorA: EvaluationFileDigest;
  readonly annotatorB: EvaluationFileDigest;
  readonly report: EvaluationFileDigest;
}

export type EvaluationCycleRunMode = "benchmark" | "holdout";

export interface EvaluationCycleArtifactsInput {
  readonly corpusSha256: string;
  readonly sourceSha256: string;
}

export interface SelectEvaluationCandidateInput extends EvaluationCycleArtifactsInput {
  readonly cycleId: string;
  readonly mode: string;
  readonly split: string;
  readonly rows: number;
  readonly terminalRuns: number;
  readonly activatedDecisions: number;
  readonly passed: boolean;
  readonly provider: string;
  readonly modelId: string;
  readonly modelConfigId: string;
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly developmentReport: EvaluationFileDigest;
}

export interface RecordEvaluationHoldoutInput extends EvaluationHoldoutCandidateInput {
  readonly cycleId: string;
  readonly mode: string;
  readonly split: string;
  readonly rows: number;
  readonly terminalRuns: number;
  readonly activatedDecisions: number;
  readonly passed: boolean;
  readonly report: EvaluationFileDigest;
}

const HASH = /^[0-9a-f]{64}$/u;
const CYCLE_ID = /^v([1-9][0-9]*)$/u;
const STATUSES = new Set<EvaluationCycleStatus>([
  "SPLIT_FROZEN",
  "ANNOTATION_FAILED",
  "ANNOTATED",
  "CANDIDATE_SELECTED",
  "HOLDOUT_CLAIMED",
  "OPENED_FAILED",
  "OPENED_PASSED",
]);

const fail = (message: string): never => {
  throw new TypeError(message);
};

const MANIFEST_KEYS = [
  "schemaVersion",
  "cycleId",
  "status",
  "source",
  "split",
  "annotations",
  "annotationFailure",
  "candidate",
  "holdoutOpening",
] as const;

const object = (value: unknown, location: string): Record<string, unknown> => {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return fail(`${location} must be an object`);
  }
  return value as Record<string, unknown>;
};

const exactKeys = (
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  location: string,
): void => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("\u0000") !== wanted.join("\u0000")) {
    fail(`${location} has unexpected or missing fields`);
  }
};

const nonEmptyString = (value: unknown, location: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    return fail(`${location} must be a non-empty string`);
  }
  return value;
};

const safeRelativePath = (value: unknown, location: string): string => {
  const result = nonEmptyString(value, location);
  if (
    result.startsWith("/") ||
    result.includes("\\") ||
    result.split("/").includes("..")
  ) {
    fail(`${location} must be a safe repository-relative POSIX path`);
  }
  return result;
};

const hash = (value: unknown, location: string): string => {
  if (typeof value !== "string" || !HASH.test(value)) {
    return fail(`${location} must be a lowercase SHA-256 digest`);
  }
  return value;
};

const positiveInteger = (value: unknown, location: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    return fail(`${location} must be a positive safe integer`);
  }
  return value as number;
};

const nonNegativeInteger = (value: unknown, location: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return fail(`${location} must be a non-negative safe integer`);
  }
  return value as number;
};

const kappa = (value: unknown, location: string): number => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < -1 ||
    value > 1
  ) {
    return fail(`${location} must be a finite number from -1 to 1`);
  }
  return value;
};

const integerArray = (value: unknown, location: string): number[] => {
  if (!Array.isArray(value)) {
    return fail(`${location} must be an array`);
  }
  const values = value.map((entry, index) =>
    positiveInteger(entry, `${location}[${index}]`),
  );
  if (new Set(values).size !== values.length) {
    fail(`${location} must not contain duplicate comment IDs`);
  }
  return values;
};

const parseFileDigest = (
  value: unknown,
  location: string,
): EvaluationFileDigest => {
  const item = object(value, location);
  exactKeys(item, ["path", "sha256"], location);
  return {
    path: safeRelativePath(item["path"], `${location}.path`),
    sha256: hash(item["sha256"], `${location}.sha256`),
  };
};

const parseNullableFileDigest = (
  value: unknown,
  location: string,
): EvaluationFileDigest | null =>
  value === null ? null : parseFileDigest(value, location);

const cycleNumber = (cycleId: string): number => {
  const match = CYCLE_ID.exec(cycleId);
  if (match?.[1] === undefined) {
    return fail(`cycleId must match v<positive integer>`);
  }
  return Number(match[1]);
};

export const sha256Text = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const serializeEvaluationHoldout = (
  holdout: EvaluationHoldoutFile,
): string => `${JSON.stringify(holdout, null, 2)}\n`;

export const serializeEvaluationCycleManifest = (
  manifest: EvaluationCycleManifest,
): string => `${JSON.stringify(manifest, null, 2)}\n`;

const sortedIds = (values: readonly number[]): number[] =>
  [...values].sort((left, right) => left - right);

const sameIds = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const expectedHoldoutIds = (
  commentIds: readonly number[],
  salt: string,
  count: number,
): number[] =>
  [...commentIds]
    .sort((left, right) => {
      const leftHash = sha256Text(`${salt}:${left}`);
      const rightHash = sha256Text(`${salt}:${right}`);
      return (
        (leftHash < rightHash ? -1 : leftHash > rightHash ? 1 : 0) ||
        left - right
      );
    })
    .slice(0, count)
    .sort((left, right) => left - right);

const validateManifest = (manifest: EvaluationCycleManifest): void => {
  if (
    manifest.claimAbandonedAt !== undefined &&
    manifest.status !== "CANDIDATE_SELECTED" &&
    manifest.status !== "HOLDOUT_CLAIMED" &&
    manifest.status !== "OPENED_FAILED" &&
    manifest.status !== "OPENED_PASSED"
  ) {
    fail(
      `${manifest.cycleId} claim abandonment requires a holdout-stage status`,
    );
  }
  const sourceIds = manifest.source.commentIds;
  if (sourceIds.length < MINIMUM_EVALUATION_CYCLE_ROWS) {
    fail(
      `${manifest.cycleId} must contain at least ${MINIMUM_EVALUATION_CYCLE_ROWS} rows`,
    );
  }
  if (!sameIds(sourceIds, sortedIds(sourceIds))) {
    fail(`${manifest.cycleId} source comment IDs must be sorted`);
  }
  if (new Set(sourceIds).size !== sourceIds.length) {
    fail(`${manifest.cycleId} source comment IDs must be unique`);
  }
  if (
    manifest.source.window.firstCommentId !== sourceIds[0] ||
    manifest.source.window.lastCommentId !== sourceIds[sourceIds.length - 1]
  ) {
    fail(`${manifest.cycleId} source window must bound its comment IDs`);
  }

  const developmentIds = manifest.split.developmentCommentIds;
  const holdoutIds = manifest.split.holdoutCommentIds;
  if (manifest.split.salt !== `gold-${manifest.cycleId}-holdout`) {
    fail(`${manifest.cycleId} split salt is not canonical`);
  }
  if (holdoutIds.length < 10 || developmentIds.length < 20) {
    fail(`${manifest.cycleId} split is too small for evaluation`);
  }
  if (
    !sameIds(developmentIds, sortedIds(developmentIds)) ||
    !sameIds(holdoutIds, sortedIds(holdoutIds))
  ) {
    fail(`${manifest.cycleId} split comment IDs must be sorted`);
  }
  const partition = sortedIds([...developmentIds, ...holdoutIds]);
  if (!sameIds(partition, sourceIds)) {
    fail(`${manifest.cycleId} split must partition every source comment ID`);
  }
  const expected = expectedHoldoutIds(
    sourceIds,
    manifest.split.salt,
    holdoutIds.length,
  );
  if (!sameIds(expected, holdoutIds)) {
    fail(`${manifest.cycleId} holdout does not match its deterministic split`);
  }

  const annotationFiles = [
    manifest.annotations.annotatorA,
    manifest.annotations.annotatorB,
    manifest.annotations.gold,
  ];
  const annotationCount = annotationFiles.filter(
    (entry) => entry !== null,
  ).length;
  if (
    annotationCount > 1 &&
    new Set(
      annotationFiles
        .filter((entry) => entry !== null)
        .map((entry) => entry.path),
    ).size !== annotationCount
  ) {
    fail(`${manifest.cycleId} annotation passes must use distinct files`);
  }

  const annotated = annotationCount === annotationFiles.length;
  const annotationFailed =
    manifest.annotations.annotatorA !== null &&
    manifest.annotations.annotatorB !== null &&
    manifest.annotations.gold === null;
  if (manifest.status === "SPLIT_FROZEN") {
    if (
      annotationCount !== 0 ||
      manifest.annotationFailure !== null ||
      manifest.candidate !== null ||
      manifest.holdoutOpening !== null
    ) {
      fail(
        `${manifest.cycleId} frozen split cannot contain later-stage artifacts`,
      );
    }
    return;
  }
  if (manifest.status === "ANNOTATION_FAILED") {
    const failure = manifest.annotationFailure;
    const annotatorA = manifest.annotations.annotatorA;
    const annotatorB = manifest.annotations.annotatorB;
    if (failure === null || annotatorA === null || annotatorB === null) {
      return fail(
        `${manifest.cycleId} annotation failure requires two passes and a comparison report`,
      );
    }
    if (
      !annotationFailed ||
      manifest.candidate !== null ||
      manifest.holdoutOpening !== null
    ) {
      fail(
        `${manifest.cycleId} annotation failure requires two passes and no later-stage artifacts`,
      );
    }
    if (
      failure.rows !== sourceIds.length ||
      failure.exactDecisionAgreementRows > failure.rows ||
      failure.requiredKappa !== MINIMUM_ANNOTATION_COHENS_KAPPA ||
      (failure.primaryClassKappa >= failure.requiredKappa &&
        failure.materialRelevanceKappa >= failure.requiredKappa)
    ) {
      fail(`${manifest.cycleId} annotation failure metrics are invalid`);
    }
    const failurePaths = [
      annotatorA.path,
      annotatorB.path,
      failure.report.path,
    ];
    if (new Set(failurePaths).size !== failurePaths.length) {
      fail(`${manifest.cycleId} annotation failure artifacts must differ`);
    }
    return;
  }
  if (manifest.annotationFailure !== null) {
    fail(
      `${manifest.cycleId} ${manifest.status} cannot retain an annotation failure`,
    );
  }
  if (!annotated) {
    fail(
      `${manifest.cycleId} ${manifest.status} state requires double annotation`,
    );
  }
  if (manifest.status === "ANNOTATED") {
    if (manifest.candidate !== null || manifest.holdoutOpening !== null) {
      fail(`${manifest.cycleId} annotated state cannot contain a candidate`);
    }
    return;
  }
  if (manifest.candidate === null) {
    fail(`${manifest.cycleId} ${manifest.status} state requires a candidate`);
  }
  if (
    manifest.status === "CANDIDATE_SELECTED" ||
    manifest.status === "HOLDOUT_CLAIMED"
  ) {
    if (manifest.holdoutOpening !== null) {
      fail(
        `${manifest.cycleId} candidate state cannot contain a holdout result`,
      );
    }
    return;
  }
  const holdoutOpening = manifest.holdoutOpening;
  if (holdoutOpening === null) {
    return fail(`${manifest.cycleId} terminal state requires a holdout report`);
  }
  const expectedPassed = manifest.status === "OPENED_PASSED";
  if (holdoutOpening.passed !== expectedPassed) {
    fail(`${manifest.cycleId} terminal state disagrees with holdout result`);
  }
};

export const validateEvaluationCycleSet = (
  manifests: readonly EvaluationCycleManifest[],
): void => {
  if (manifests.length === 0) {
    fail("At least one evaluation cycle manifest is required");
  }
  const ordered = [...manifests].sort(
    (left, right) => cycleNumber(left.cycleId) - cycleNumber(right.cycleId),
  );
  ordered.forEach((manifest, index) => {
    if (cycleNumber(manifest.cycleId) !== index + 1) {
      fail("Evaluation cycle IDs must be unique and contiguous from v1");
    }
    validateManifest(manifest);
    if (
      index < ordered.length - 1 &&
      manifest.status !== "ANNOTATION_FAILED" &&
      manifest.status !== "OPENED_FAILED" &&
      manifest.status !== "OPENED_PASSED"
    ) {
      fail(`${manifest.cycleId} must be terminal before a later cycle exists`);
    }
    const earlierIds = new Set(
      ordered.slice(0, index).flatMap((earlier) => earlier.source.commentIds),
    );
    if (manifest.source.commentIds.some((id) => earlierIds.has(id))) {
      fail(`${manifest.cycleId} reuses a comment from an earlier cycle`);
    }
    const priorLast = ordered[index - 1]?.source.window.lastCommentId;
    if (
      priorLast !== undefined &&
      manifest.source.window.firstCommentId <= priorLast
    ) {
      fail(`${manifest.cycleId} is not a fresh later HN comment window`);
    }
  });
};

export const prepareEvaluationCycle = (
  input: PrepareEvaluationCycleInput,
): {
  readonly manifest: EvaluationCycleManifest;
  readonly holdout: EvaluationHoldoutFile;
} => {
  const number = cycleNumber(input.cycleId);
  if (number !== input.priorManifests.length + 1) {
    fail(`${input.cycleId} must immediately follow the prior cycle set`);
  }
  const commentIds = sortedIds(input.source.commentIds);
  if (new Set(commentIds).size !== commentIds.length) {
    fail("Source comment IDs must not contain duplicates");
  }
  if (commentIds.length < MINIMUM_EVALUATION_CYCLE_ROWS) {
    fail(
      `Source must contain at least ${MINIMUM_EVALUATION_CYCLE_ROWS} comments`,
    );
  }
  const holdoutSize = input.holdoutSize ?? Math.round(commentIds.length * 0.3);
  if (
    !Number.isSafeInteger(holdoutSize) ||
    holdoutSize < 10 ||
    holdoutSize > commentIds.length - 20 ||
    holdoutSize / commentIds.length < 0.25 ||
    holdoutSize / commentIds.length > 0.35
  ) {
    fail(
      "Holdout size must be 25% to 35% and leave at least 10 holdout and 20 development rows",
    );
  }
  const salt = `gold-${input.cycleId}-holdout`;
  const holdoutCommentIds = expectedHoldoutIds(commentIds, salt, holdoutSize);
  const holdoutSet = new Set(holdoutCommentIds);
  const developmentCommentIds = commentIds.filter((id) => !holdoutSet.has(id));
  const holdout: EvaluationHoldoutFile = {
    schemaVersion: 1,
    selection: `first ${holdoutSize} IDs by SHA-256(${salt}:<commentId>)`,
    commentIds: holdoutCommentIds,
  };
  const manifest: EvaluationCycleManifest = {
    schemaVersion: EVALUATION_CYCLE_SCHEMA_VERSION,
    cycleId: input.cycleId,
    status: "SPLIT_FROZEN",
    source: {
      ...input.source,
      commentIds,
      window: {
        firstCommentId: commentIds[0] as number,
        lastCommentId: commentIds[commentIds.length - 1] as number,
      },
    },
    split: {
      algorithm: EVALUATION_SPLIT_ALGORITHM,
      salt,
      developmentCommentIds,
      holdoutCommentIds,
      holdoutFile: {
        path: input.holdoutPath,
        sha256: sha256Text(serializeEvaluationHoldout(holdout)),
      },
    },
    annotations: { annotatorA: null, annotatorB: null, gold: null },
    annotationFailure: null,
    candidate: null,
    holdoutOpening: null,
  };
  validateEvaluationCycleSet([...input.priorManifests, manifest]);
  return { manifest, holdout };
};

export const recordEvaluationAnnotationFailure = (
  manifest: EvaluationCycleManifest,
  input: RecordEvaluationAnnotationFailureInput,
): EvaluationCycleManifest => {
  if (
    manifest.status !== "SPLIT_FROZEN" ||
    manifest.annotations.annotatorA !== null ||
    manifest.annotations.annotatorB !== null ||
    manifest.annotations.gold !== null ||
    manifest.annotationFailure !== null
  ) {
    fail(`${manifest.cycleId} annotation failure requires SPLIT_FROZEN`);
  }
  if (input.cycleId !== manifest.cycleId) {
    fail(`${manifest.cycleId} annotation comparison belongs to another cycle`);
  }
  const rows = positiveInteger(input.rows, "annotationFailure.rows");
  const exactDecisionAgreementRows = nonNegativeInteger(
    input.exactDecisionAgreementRows,
    "annotationFailure.exactDecisionAgreementRows",
  );
  const primaryClassKappa = kappa(
    input.primaryClassKappa,
    "annotationFailure.primaryClassKappa",
  );
  const materialRelevanceKappa = kappa(
    input.materialRelevanceKappa,
    "annotationFailure.materialRelevanceKappa",
  );
  const requiredKappa = kappa(
    input.requiredKappa,
    "annotationFailure.requiredKappa",
  );
  if (
    rows !== manifest.source.commentIds.length ||
    exactDecisionAgreementRows > rows
  ) {
    fail(`${manifest.cycleId} annotation comparison row counts are invalid`);
  }
  if (
    requiredKappa !== MINIMUM_ANNOTATION_COHENS_KAPPA ||
    (primaryClassKappa >= requiredKappa &&
      materialRelevanceKappa >= requiredKappa)
  ) {
    fail(`${manifest.cycleId} annotation comparison did not fail its gate`);
  }
  const annotatorA: EvaluationFileDigest = {
    path: safeRelativePath(
      input.annotatorA.path,
      "annotationFailure.annotatorA.path",
    ),
    sha256: hash(
      input.annotatorA.sha256,
      "annotationFailure.annotatorA.sha256",
    ),
  };
  const annotatorB: EvaluationFileDigest = {
    path: safeRelativePath(
      input.annotatorB.path,
      "annotationFailure.annotatorB.path",
    ),
    sha256: hash(
      input.annotatorB.sha256,
      "annotationFailure.annotatorB.sha256",
    ),
  };
  if (
    annotatorA.path === annotatorB.path ||
    annotatorA.sha256 === annotatorB.sha256
  ) {
    fail(`${manifest.cycleId} failed annotation passes must be independent`);
  }
  const updated: EvaluationCycleManifest = {
    ...manifest,
    status: "ANNOTATION_FAILED",
    annotations: { annotatorA, annotatorB, gold: null },
    annotationFailure: {
      report: {
        path: safeRelativePath(
          input.report.path,
          "annotationFailure.report.path",
        ),
        sha256: hash(input.report.sha256, "annotationFailure.report.sha256"),
      },
      rows,
      exactDecisionAgreementRows,
      primaryClassKappa,
      materialRelevanceKappa,
      requiredKappa,
    },
  };
  validateManifest(updated);
  return updated;
};

export const assertEvaluationDevelopmentMayRun = (
  manifest: EvaluationCycleManifest,
): void => {
  if (manifest.status !== "ANNOTATED" || manifest.annotations.gold === null) {
    fail(`${manifest.cycleId} development evaluation requires ANNOTATED`);
  }
};

export const assertEvaluationCycleArtifactsMatch = (
  manifest: EvaluationCycleManifest,
  input: EvaluationCycleArtifactsInput,
): void => {
  if (manifest.annotations.gold?.sha256 !== input.corpusSha256) {
    fail(`${manifest.cycleId} runtime corpus does not match frozen gold`);
  }
  if (manifest.source.sha256 !== input.sourceSha256) {
    fail(`${manifest.cycleId} runtime source does not match frozen source`);
  }
};

export const assertEvaluationRowsMatchCycle = (
  manifest: EvaluationCycleManifest,
  mode: EvaluationCycleRunMode,
  commentIds: readonly number[],
): void => {
  const expected =
    mode === "benchmark"
      ? manifest.split.developmentCommentIds
      : manifest.split.holdoutCommentIds;
  if (
    new Set(commentIds).size !== commentIds.length ||
    !sameIds(sortedIds(commentIds), expected)
  ) {
    fail(`${manifest.cycleId} ${mode} rows do not match the frozen split`);
  }
};

export const selectEvaluationCandidate = (
  manifest: EvaluationCycleManifest,
  input: SelectEvaluationCandidateInput,
): EvaluationCycleManifest => {
  assertEvaluationDevelopmentMayRun(manifest);
  assertEvaluationCycleArtifactsMatch(manifest, input);
  if (input.cycleId !== manifest.cycleId) {
    fail(`${manifest.cycleId} development report belongs to another cycle`);
  }
  if (input.mode !== "benchmark" || input.split !== "development") {
    fail(`${manifest.cycleId} candidate requires a development benchmark`);
  }
  if (input.rows !== manifest.split.developmentCommentIds.length) {
    fail(`${manifest.cycleId} development report row count is invalid`);
  }
  if (input.terminalRuns !== input.rows) {
    fail(`${manifest.cycleId} development report run count is incomplete`);
  }
  if (input.activatedDecisions !== 0) {
    fail(`${manifest.cycleId} development report activated a decision`);
  }
  if (!input.passed) {
    fail(`${manifest.cycleId} development report did not pass`);
  }
  if (input.provider !== "openai") {
    fail(`${manifest.cycleId} candidate provider is unsupported`);
  }
  const updated: EvaluationCycleManifest = {
    ...manifest,
    status: "CANDIDATE_SELECTED",
    candidate: {
      provider: nonEmptyString(input.provider, "candidate.provider"),
      modelId: nonEmptyString(input.modelId, "candidate.modelId"),
      modelConfigId: nonEmptyString(
        input.modelConfigId,
        "candidate.modelConfigId",
      ),
      promptVersion: nonEmptyString(
        input.promptVersion,
        "candidate.promptVersion",
      ),
      promptHash: hash(input.promptHash, "candidate.promptHash"),
      developmentReport: {
        path: safeRelativePath(
          input.developmentReport.path,
          "candidate.developmentReport.path",
        ),
        sha256: hash(
          input.developmentReport.sha256,
          "candidate.developmentReport.sha256",
        ),
      },
    },
  };
  validateManifest(updated);
  return updated;
};

export const assertEvaluationHoldoutMayOpen = (
  manifest: EvaluationCycleManifest,
  input: EvaluationHoldoutCandidateInput,
): void => {
  if (
    manifest.status === "HOLDOUT_CLAIMED" ||
    manifest.status === "OPENED_FAILED" ||
    manifest.status === "OPENED_PASSED" ||
    manifest.holdoutOpening !== null
  ) {
    return fail(`${manifest.cycleId} holdout has already been opened`);
  }
  if (manifest.status !== "CANDIDATE_SELECTED" || manifest.candidate === null) {
    return fail(`${manifest.cycleId} holdout has no frozen passing candidate`);
  }
  assertEvaluationCycleArtifactsMatch(manifest, input);
  const candidate = manifest.candidate;
  if (
    candidate.provider !== input.provider ||
    candidate.modelId !== input.modelId ||
    candidate.modelConfigId !== input.modelConfigId ||
    candidate.promptVersion !== input.promptVersion ||
    candidate.promptHash !== input.promptHash
  ) {
    fail(`${manifest.cycleId} runtime does not match frozen candidate`);
  }
};

export const claimEvaluationHoldout = (
  manifest: EvaluationCycleManifest,
  input: EvaluationHoldoutCandidateInput,
): EvaluationCycleManifest => {
  assertEvaluationHoldoutMayOpen(manifest, input);
  const updated: EvaluationCycleManifest = {
    ...manifest,
    status: "HOLDOUT_CLAIMED",
  };
  validateManifest(updated);
  return updated;
};

export const recordEvaluationHoldoutResult = (
  manifest: EvaluationCycleManifest,
  input: RecordEvaluationHoldoutInput,
): EvaluationCycleManifest => {
  const candidate = manifest.candidate;
  if (
    manifest.status !== "HOLDOUT_CLAIMED" ||
    manifest.holdoutOpening !== null
  ) {
    fail(`${manifest.cycleId} holdout result requires HOLDOUT_CLAIMED`);
  }
  if (candidate === null) {
    return fail(`${manifest.cycleId} claimed holdout is missing its candidate`);
  }
  assertEvaluationCycleArtifactsMatch(manifest, input);
  if (input.cycleId !== manifest.cycleId) {
    fail(`${manifest.cycleId} holdout report belongs to another cycle`);
  }
  if (input.mode !== "holdout" || input.split !== "holdout") {
    fail(`${manifest.cycleId} result requires a holdout report`);
  }
  if (input.rows !== manifest.split.holdoutCommentIds.length) {
    fail(`${manifest.cycleId} holdout report row count is invalid`);
  }
  if (input.terminalRuns !== input.rows) {
    fail(`${manifest.cycleId} holdout report run count is incomplete`);
  }
  if (input.activatedDecisions !== 0) {
    fail(`${manifest.cycleId} holdout report activated a decision`);
  }
  if (input.report.path === candidate.developmentReport.path) {
    fail(`${manifest.cycleId} holdout and development reports must differ`);
  }
  if (
    candidate.provider !== input.provider ||
    candidate.modelId !== input.modelId ||
    candidate.modelConfigId !== input.modelConfigId ||
    candidate.promptVersion !== input.promptVersion ||
    candidate.promptHash !== input.promptHash
  ) {
    fail(`${manifest.cycleId} holdout report does not match frozen candidate`);
  }
  const updated: EvaluationCycleManifest = {
    ...manifest,
    status: input.passed ? "OPENED_PASSED" : "OPENED_FAILED",
    holdoutOpening: {
      report: {
        path: safeRelativePath(input.report.path, "holdout.report.path"),
        sha256: hash(input.report.sha256, "holdout.report.sha256"),
      },
      passed: input.passed,
    },
  };
  validateManifest(updated);
  return updated;
};

export interface AbandonEvaluationHoldoutClaimInput {
  readonly manifestPath: string;
  readonly manifestText: string;
  readonly attemptMarkerPaths: readonly string[];
  readonly existingHoldoutReportPaths: readonly string[];
  readonly abandonedAt: string;
  readonly companionManifests?: readonly EvaluationCycleManifest[];
}

export interface AbandonedEvaluationHoldoutClaim {
  readonly manifest: EvaluationCycleManifest;
  readonly removedAttemptMarkerPaths: readonly string[];
}

export const abandonEvaluationHoldoutClaim = async (
  manifest: EvaluationCycleManifest,
  input: AbandonEvaluationHoldoutClaimInput,
): Promise<AbandonedEvaluationHoldoutClaim> => {
  if (manifest.status !== "HOLDOUT_CLAIMED" || manifest.candidate === null) {
    fail(`${manifest.cycleId} claim abandonment requires HOLDOUT_CLAIMED`);
  }
  if (input.existingHoldoutReportPaths.length > 0) {
    fail(`${manifest.cycleId} holdout report already exists`);
  }
  if (input.attemptMarkerPaths.length === 0) {
    fail(`${manifest.cycleId} stale holdout attempt marker is missing`);
  }
  const abandonedAt = nonEmptyString(
    input.abandonedAt,
    "claimAbandonedAt.abandonedAt",
  );
  const existingMarkers: string[] = [];
  for (const markerPath of input.attemptMarkerPaths) {
    try {
      await stat(markerPath);
    } catch {
      fail(`${manifest.cycleId} stale holdout attempt marker is missing`);
    }
    existingMarkers.push(markerPath);
  }
  const updated: EvaluationCycleManifest = {
    ...manifest,
    status: "CANDIDATE_SELECTED",
    claimAbandonedAt: abandonedAt,
  };
  validateManifest(updated);
  if (input.companionManifests !== undefined) {
    validateEvaluationCycleSet([...input.companionManifests, updated]);
  }

  const directory = path.dirname(input.manifestPath);
  const temporaryPath = path.join(
    directory,
    `.${manifest.cycleId}.json.abandon-holdout-${process.pid}`,
  );
  let renamed = false;
  try {
    await writeFile(temporaryPath, serializeEvaluationCycleManifest(updated), {
      flag: "wx",
    });
    if ((await readFile(input.manifestPath, "utf8")) !== input.manifestText) {
      throw new Error(
        `${manifest.cycleId} manifest changed during holdout abandonment`,
      );
    }
    await rename(temporaryPath, input.manifestPath);
    renamed = true;
  } finally {
    if (!renamed) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
  for (const markerPath of existingMarkers) {
    await unlink(markerPath);
  }
  return {
    manifest: updated,
    removedAttemptMarkerPaths: existingMarkers,
  };
};

export const parseEvaluationCycleManifest = (
  value: unknown,
): EvaluationCycleManifest => {
  const item = object(value, "manifest");
  const manifestItem: Record<string, unknown> = { ...item };
  const claimAbandonedAtValue = manifestItem["claimAbandonedAt"];
  delete manifestItem["claimAbandonedAt"];
  exactKeys(manifestItem, [...MANIFEST_KEYS], "manifest");
  let claimAbandonedAt: string | undefined;
  if (claimAbandonedAtValue !== undefined) {
    claimAbandonedAt = nonEmptyString(
      claimAbandonedAtValue,
      "manifest.claimAbandonedAt",
    );
  }
  if (item["schemaVersion"] !== EVALUATION_CYCLE_SCHEMA_VERSION) {
    fail("manifest.schemaVersion is unsupported");
  }
  const cycleId = nonEmptyString(item["cycleId"], "manifest.cycleId");
  cycleNumber(cycleId);
  if (
    typeof item["status"] !== "string" ||
    !STATUSES.has(item["status"] as EvaluationCycleStatus)
  ) {
    fail("manifest.status is invalid");
  }
  const status = item["status"] as EvaluationCycleStatus;

  const source = object(item["source"], "manifest.source");
  exactKeys(
    source,
    ["path", "sha256", "commentIds", "window"],
    "manifest.source",
  );
  const window = object(source["window"], "manifest.source.window");
  exactKeys(
    window,
    ["firstCommentId", "lastCommentId"],
    "manifest.source.window",
  );

  const split = object(item["split"], "manifest.split");
  exactKeys(
    split,
    [
      "algorithm",
      "salt",
      "developmentCommentIds",
      "holdoutCommentIds",
      "holdoutFile",
    ],
    "manifest.split",
  );
  if (split["algorithm"] !== EVALUATION_SPLIT_ALGORITHM) {
    fail("manifest.split.algorithm is unsupported");
  }

  const annotations = object(item["annotations"], "manifest.annotations");
  exactKeys(
    annotations,
    ["annotatorA", "annotatorB", "gold"],
    "manifest.annotations",
  );

  const annotationFailureValue = item["annotationFailure"];
  let annotationFailure: EvaluationCycleManifest["annotationFailure"] = null;
  if (annotationFailureValue !== null) {
    const failure = object(
      annotationFailureValue,
      "manifest.annotationFailure",
    );
    exactKeys(
      failure,
      [
        "report",
        "rows",
        "exactDecisionAgreementRows",
        "primaryClassKappa",
        "materialRelevanceKappa",
        "requiredKappa",
      ],
      "manifest.annotationFailure",
    );
    annotationFailure = {
      report: parseFileDigest(
        failure["report"],
        "manifest.annotationFailure.report",
      ),
      rows: positiveInteger(failure["rows"], "manifest.annotationFailure.rows"),
      exactDecisionAgreementRows: nonNegativeInteger(
        failure["exactDecisionAgreementRows"],
        "manifest.annotationFailure.exactDecisionAgreementRows",
      ),
      primaryClassKappa: kappa(
        failure["primaryClassKappa"],
        "manifest.annotationFailure.primaryClassKappa",
      ),
      materialRelevanceKappa: kappa(
        failure["materialRelevanceKappa"],
        "manifest.annotationFailure.materialRelevanceKappa",
      ),
      requiredKappa: kappa(
        failure["requiredKappa"],
        "manifest.annotationFailure.requiredKappa",
      ),
    };
  }

  const candidateValue = item["candidate"];
  let candidate: EvaluationCycleManifest["candidate"] = null;
  if (candidateValue !== null) {
    const candidateObject = object(candidateValue, "manifest.candidate");
    exactKeys(
      candidateObject,
      [
        "provider",
        "modelId",
        "modelConfigId",
        "promptVersion",
        "promptHash",
        "developmentReport",
      ],
      "manifest.candidate",
    );
    candidate = {
      provider: nonEmptyString(
        candidateObject["provider"],
        "manifest.candidate.provider",
      ),
      modelId: nonEmptyString(
        candidateObject["modelId"],
        "manifest.candidate.modelId",
      ),
      modelConfigId: nonEmptyString(
        candidateObject["modelConfigId"],
        "manifest.candidate.modelConfigId",
      ),
      promptVersion: nonEmptyString(
        candidateObject["promptVersion"],
        "manifest.candidate.promptVersion",
      ),
      promptHash: hash(
        candidateObject["promptHash"],
        "manifest.candidate.promptHash",
      ),
      developmentReport: parseFileDigest(
        candidateObject["developmentReport"],
        "manifest.candidate.developmentReport",
      ),
    };
  }

  const openingValue = item["holdoutOpening"];
  let holdoutOpening: EvaluationCycleManifest["holdoutOpening"] = null;
  if (openingValue !== null) {
    const opening = object(openingValue, "manifest.holdoutOpening");
    exactKeys(opening, ["report", "passed"], "manifest.holdoutOpening");
    const passed =
      typeof opening["passed"] === "boolean"
        ? opening["passed"]
        : fail("manifest.holdoutOpening.passed must be a boolean");
    holdoutOpening = {
      report: parseFileDigest(
        opening["report"],
        "manifest.holdoutOpening.report",
      ),
      passed,
    };
  }

  return {
    schemaVersion: EVALUATION_CYCLE_SCHEMA_VERSION,
    cycleId,
    status,
    source: {
      path: safeRelativePath(source["path"], "manifest.source.path"),
      sha256: hash(source["sha256"], "manifest.source.sha256"),
      commentIds: integerArray(
        source["commentIds"],
        "manifest.source.commentIds",
      ),
      window: {
        firstCommentId: positiveInteger(
          window["firstCommentId"],
          "manifest.source.window.firstCommentId",
        ),
        lastCommentId: positiveInteger(
          window["lastCommentId"],
          "manifest.source.window.lastCommentId",
        ),
      },
    },
    split: {
      algorithm: EVALUATION_SPLIT_ALGORITHM,
      salt: nonEmptyString(split["salt"], "manifest.split.salt"),
      developmentCommentIds: integerArray(
        split["developmentCommentIds"],
        "manifest.split.developmentCommentIds",
      ),
      holdoutCommentIds: integerArray(
        split["holdoutCommentIds"],
        "manifest.split.holdoutCommentIds",
      ),
      holdoutFile: parseFileDigest(
        split["holdoutFile"],
        "manifest.split.holdoutFile",
      ),
    },
    annotations: {
      annotatorA: parseNullableFileDigest(
        annotations["annotatorA"],
        "manifest.annotations.annotatorA",
      ),
      annotatorB: parseNullableFileDigest(
        annotations["annotatorB"],
        "manifest.annotations.annotatorB",
      ),
      gold: parseNullableFileDigest(
        annotations["gold"],
        "manifest.annotations.gold",
      ),
    },
    annotationFailure,
    candidate,
    holdoutOpening,
    ...(claimAbandonedAt === undefined ? {} : { claimAbandonedAt }),
  };
};
