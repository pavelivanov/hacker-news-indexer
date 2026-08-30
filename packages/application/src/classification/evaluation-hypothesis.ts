export const EVALUATION_HYPOTHESIS_SCHEMA_VERSION = "evaluation-hypothesis.v1";

export interface EvaluationHypothesis {
  readonly schemaVersion: typeof EVALUATION_HYPOTHESIS_SCHEMA_VERSION;
  readonly cycleId: string;
  readonly mode: "benchmark";
  readonly provider: string;
  readonly modelId: string;
  readonly modelConfigId: string;
  readonly reasoningEffort: string;
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly decisionRouterVersion: string;
  readonly statement: string;
  readonly decisionRule: string;
}

export interface EvaluationHypothesisReference {
  readonly path: string;
  readonly sha256: string;
}

const HASH = /^[0-9a-f]{64}$/u;
const CYCLE_ID = /^v[1-9][0-9]*$/u;

const fail = (message: string): never => {
  throw new TypeError(message);
};

const object = (value: unknown): Record<string, unknown> => {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return fail("Evaluation hypothesis must be a JSON object");
  }
  return value as Record<string, unknown>;
};

const nonEmptyString = (
  value: unknown,
  location: string,
  minimumLength = 1,
): string => {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < minimumLength ||
    value.length > 2_000
  ) {
    return fail(
      `${location} must be a trimmed string between ${minimumLength} and 2000 characters`,
    );
  }
  return value;
};

export const parseEvaluationHypothesis = (
  value: unknown,
): EvaluationHypothesis => {
  const item = object(value);
  const expectedKeys = [
    "cycleId",
    "decisionRouterVersion",
    "decisionRule",
    "mode",
    "modelConfigId",
    "modelId",
    "promptHash",
    "promptVersion",
    "provider",
    "reasoningEffort",
    "schemaVersion",
    "statement",
  ];
  if (
    Object.keys(item).sort().join("\u0000") !==
    expectedKeys.sort().join("\u0000")
  ) {
    fail("Evaluation hypothesis has unexpected or missing fields");
  }
  if (item["schemaVersion"] !== EVALUATION_HYPOTHESIS_SCHEMA_VERSION) {
    fail("Evaluation hypothesis schemaVersion is invalid");
  }
  const cycleId = nonEmptyString(item["cycleId"], "cycleId");
  if (!CYCLE_ID.test(cycleId)) {
    fail("cycleId must match v<positive integer>");
  }
  if (item["mode"] !== "benchmark") {
    fail("Evaluation hypothesis mode must be benchmark");
  }
  const promptHash = nonEmptyString(item["promptHash"], "promptHash");
  if (!HASH.test(promptHash)) {
    fail("promptHash must be a lowercase SHA-256 digest");
  }

  return {
    schemaVersion: EVALUATION_HYPOTHESIS_SCHEMA_VERSION,
    cycleId,
    mode: "benchmark",
    provider: nonEmptyString(item["provider"], "provider"),
    modelId: nonEmptyString(item["modelId"], "modelId"),
    modelConfigId: nonEmptyString(item["modelConfigId"], "modelConfigId"),
    reasoningEffort: nonEmptyString(item["reasoningEffort"], "reasoningEffort"),
    promptVersion: nonEmptyString(item["promptVersion"], "promptVersion"),
    promptHash,
    decisionRouterVersion: nonEmptyString(
      item["decisionRouterVersion"],
      "decisionRouterVersion",
    ),
    statement: nonEmptyString(item["statement"], "statement", 40),
    decisionRule: nonEmptyString(item["decisionRule"], "decisionRule", 40),
  };
};

export const parseEvaluationHypothesisReference = (
  value: unknown,
): EvaluationHypothesisReference => {
  const item = object(value);
  if (Object.keys(item).sort().join("\u0000") !== "path\u0000sha256") {
    fail("Evaluation hypothesis reference has unexpected or missing fields");
  }
  const hypothesisPath = nonEmptyString(item["path"], "hypothesis.path");
  if (
    !hypothesisPath.startsWith("evaluation/hypotheses/") ||
    !hypothesisPath.endsWith(".json") ||
    hypothesisPath.includes("\\") ||
    hypothesisPath.split("/").includes("..")
  ) {
    fail("hypothesis.path must be a JSON file under evaluation/hypotheses");
  }
  const hypothesisHash = nonEmptyString(item["sha256"], "hypothesis.sha256");
  if (!HASH.test(hypothesisHash)) {
    fail("hypothesis.sha256 must be a lowercase SHA-256 digest");
  }
  return { path: hypothesisPath, sha256: hypothesisHash };
};

export const assertEvaluationHypothesisMatches = (
  hypothesis: EvaluationHypothesis,
  expected: Omit<
    EvaluationHypothesis,
    "schemaVersion" | "statement" | "decisionRule"
  >,
): void => {
  for (const [key, value] of Object.entries(expected)) {
    if (hypothesis[key as keyof EvaluationHypothesis] !== value) {
      fail(`Evaluation hypothesis ${key} does not match the requested run`);
    }
  }
};
