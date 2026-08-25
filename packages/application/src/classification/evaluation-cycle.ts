import { createHash } from "node:crypto";

export const EVALUATION_CYCLE_SCHEMA_VERSION = "evaluation-cycle.v1";
export const EVALUATION_SPLIT_ALGORITHM = "SHA256_SORT_V1";
export const MINIMUM_EVALUATION_CYCLE_ROWS = 90;

export type EvaluationCycleStatus =
  | "SPLIT_FROZEN"
  | "ANNOTATED"
  | "CANDIDATE_SELECTED"
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
  readonly provider: string;
  readonly modelId: string;
  readonly modelConfigId: string;
  readonly promptVersion: string;
  readonly promptHash: string;
}

const HASH = /^[0-9a-f]{64}$/u;
const CYCLE_ID = /^v([1-9][0-9]*)$/u;
const STATUSES = new Set<EvaluationCycleStatus>([
  "SPLIT_FROZEN",
  "ANNOTATED",
  "CANDIDATE_SELECTED",
  "OPENED_FAILED",
  "OPENED_PASSED",
]);

const fail = (message: string): never => {
  throw new TypeError(message);
};

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
      return leftHash.localeCompare(rightHash) || left - right;
    })
    .slice(0, count)
    .sort((left, right) => left - right);

const validateManifest = (manifest: EvaluationCycleManifest): void => {
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
  if (annotationCount !== 0 && annotationCount !== annotationFiles.length) {
    fail(`${manifest.cycleId} annotation digests must be recorded together`);
  }
  if (
    annotationCount === annotationFiles.length &&
    new Set(annotationFiles.map((entry) => entry?.path)).size !==
      annotationFiles.length
  ) {
    fail(`${manifest.cycleId} annotation passes must use distinct files`);
  }

  const annotated = annotationCount === annotationFiles.length;
  if (manifest.status === "SPLIT_FROZEN") {
    if (
      annotated ||
      manifest.candidate !== null ||
      manifest.holdoutOpening !== null
    ) {
      fail(
        `${manifest.cycleId} frozen split cannot contain later-stage artifacts`,
      );
    }
    return;
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
  if (manifest.status === "CANDIDATE_SELECTED") {
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
    candidate: null,
    holdoutOpening: null,
  };
  validateEvaluationCycleSet([...input.priorManifests, manifest]);
  return { manifest, holdout };
};

export const assertEvaluationHoldoutMayOpen = (
  manifest: EvaluationCycleManifest,
  input: EvaluationHoldoutCandidateInput,
): void => {
  if (
    manifest.status === "OPENED_FAILED" ||
    manifest.status === "OPENED_PASSED" ||
    manifest.holdoutOpening !== null
  ) {
    return fail(`${manifest.cycleId} holdout has already been opened`);
  }
  if (manifest.status !== "CANDIDATE_SELECTED" || manifest.candidate === null) {
    return fail(`${manifest.cycleId} holdout has no frozen passing candidate`);
  }
  if (manifest.annotations.gold?.sha256 !== input.corpusSha256) {
    fail(`${manifest.cycleId} candidate corpus does not match frozen gold`);
  }
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

export const parseEvaluationCycleManifest = (
  value: unknown,
): EvaluationCycleManifest => {
  const item = object(value, "manifest");
  exactKeys(
    item,
    [
      "schemaVersion",
      "cycleId",
      "status",
      "source",
      "split",
      "annotations",
      "candidate",
      "holdoutOpening",
    ],
    "manifest",
  );
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
    candidate,
    holdoutOpening,
  };
};
