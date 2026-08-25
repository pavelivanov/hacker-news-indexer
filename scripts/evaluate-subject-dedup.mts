import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  compareSubjectIdentities,
  createSubjectIdentity,
  hnItemId,
  SUBJECT_TYPES,
  type SubjectMatchKind,
  type SubjectType,
} from "../packages/domain/src/index.ts";

const CORPUS_PATH = "evaluation/subjects/subject-pairs-v1.json";
const REPORT_PATH = "evaluation/reports/subject-dedup-v1.json";
const PRECISION_GATE = 0.97;
const RECALL_GATE = 0.9;

interface FixtureSubject {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly subjectType: SubjectType;
  readonly canonicalUrl: string | null;
  readonly officialDomain: string | null;
  readonly rootId: number | null;
}

interface FixturePair {
  readonly id: string;
  readonly expectedSameSubject: boolean;
  readonly expectedOutcome: SubjectMatchKind;
  readonly rationale: string;
  readonly left: FixtureSubject;
  readonly right: FixtureSubject;
}

interface Fixture {
  readonly schemaVersion: "subject-pairs.v1";
  readonly corpus: string;
  readonly adjudication: {
    readonly adjudicator: string;
    readonly policyVersion: string;
    readonly scope: string;
  };
  readonly pairs: readonly FixturePair[];
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const assertSubject = (value: unknown, path: string): FixtureSubject => {
  if (
    !isRecord(value) ||
    typeof value["name"] !== "string" ||
    !Array.isArray(value["aliases"]) ||
    !value["aliases"].every((alias) => typeof alias === "string") ||
    typeof value["subjectType"] !== "string" ||
    !SUBJECT_TYPES.includes(value["subjectType"] as SubjectType) ||
    (value["canonicalUrl"] !== null &&
      typeof value["canonicalUrl"] !== "string") ||
    (value["officialDomain"] !== null &&
      typeof value["officialDomain"] !== "string") ||
    (value["rootId"] !== null &&
      (typeof value["rootId"] !== "number" ||
        !Number.isSafeInteger(value["rootId"]) ||
        value["rootId"] <= 0))
  ) {
    throw new TypeError(`Invalid subject fixture at ${path}`);
  }
  return value as unknown as FixtureSubject;
};

const assertFixture = (value: unknown): Fixture => {
  if (
    !isRecord(value) ||
    value["schemaVersion"] !== "subject-pairs.v1" ||
    typeof value["corpus"] !== "string" ||
    !isRecord(value["adjudication"]) ||
    typeof value["adjudication"]["adjudicator"] !== "string" ||
    typeof value["adjudication"]["policyVersion"] !== "string" ||
    typeof value["adjudication"]["scope"] !== "string" ||
    !Array.isArray(value["pairs"]) ||
    value["pairs"].length === 0
  ) {
    throw new TypeError("Invalid subject-pair corpus metadata");
  }
  const ids = new Set<string>();
  const pairs = value["pairs"].map((pair, index): FixturePair => {
    if (
      !isRecord(pair) ||
      typeof pair["id"] !== "string" ||
      pair["id"].length === 0 ||
      typeof pair["expectedSameSubject"] !== "boolean" ||
      !["AUTO_MERGE", "REVIEW", "DISTINCT"].includes(
        String(pair["expectedOutcome"]),
      ) ||
      typeof pair["rationale"] !== "string" ||
      pair["rationale"].length === 0
    ) {
      throw new TypeError(`Invalid subject pair at index ${index}`);
    }
    if (ids.has(pair["id"])) {
      throw new TypeError(`Duplicate subject-pair ID: ${pair["id"]}`);
    }
    ids.add(pair["id"]);
    return {
      id: pair["id"],
      expectedSameSubject: pair["expectedSameSubject"],
      expectedOutcome: pair["expectedOutcome"] as SubjectMatchKind,
      rationale: pair["rationale"],
      left: assertSubject(pair["left"], `pairs[${index}].left`),
      right: assertSubject(pair["right"], `pairs[${index}].right`),
    };
  });
  return {
    schemaVersion: "subject-pairs.v1",
    corpus: value["corpus"],
    adjudication: {
      adjudicator: value["adjudication"]["adjudicator"],
      policyVersion: value["adjudication"]["policyVersion"],
      scope: value["adjudication"]["scope"],
    },
    pairs,
  };
};

const ratio = (numerator: number, denominator: number): number =>
  denominator === 0 ? 1 : numerator / denominator;

const inputFor = (pair: FixturePair, side: "left" | "right") => {
  const value = pair[side];
  return {
    name: value.name,
    aliases: value.aliases,
    subjectType: value.subjectType,
    canonicalUrl: value.canonicalUrl,
    verifiedOfficialDomain: value.officialDomain,
    disambiguatingRootId: value.rootId === null ? null : hnItemId(value.rootId),
    provenanceKey: `subject-pair:${pair.id}:${side}`,
  };
};

const raw = await readFile(resolve(process.cwd(), CORPUS_PATH), "utf8");
const fixture = assertFixture(JSON.parse(raw) as unknown);
const cases = fixture.pairs.map((pair) => {
  const left = createSubjectIdentity(inputFor(pair, "left"), { sha256 });
  const right = createSubjectIdentity(inputFor(pair, "right"), { sha256 });
  const predicted = compareSubjectIdentities(left, right).kind;
  return {
    id: pair.id,
    expectedSameSubject: pair.expectedSameSubject,
    expectedOutcome: pair.expectedOutcome,
    predictedOutcome: predicted,
    passed: predicted === pair.expectedOutcome,
  };
});

const truePositives = cases.filter(
  (value) =>
    value.expectedSameSubject && value.predictedOutcome === "AUTO_MERGE",
).length;
const falsePositives = cases.filter(
  (value) =>
    !value.expectedSameSubject && value.predictedOutcome === "AUTO_MERGE",
).length;
const falseNegatives = cases.filter(
  (value) =>
    value.expectedSameSubject && value.predictedOutcome !== "AUTO_MERGE",
).length;
const precision = ratio(truePositives, truePositives + falsePositives);
const recall = ratio(truePositives, truePositives + falseNegatives);
const outcomeAccuracy = ratio(
  cases.filter((value) => value.passed).length,
  cases.length,
);
const passed =
  precision >= PRECISION_GATE && recall >= RECALL_GATE && outcomeAccuracy === 1;
const report = {
  reportVersion: "subject-dedup-report.v1",
  corpus: fixture.corpus,
  corpusPath: CORPUS_PATH,
  corpusSha256: sha256(raw),
  policyVersion: fixture.adjudication.policyVersion,
  rows: cases.length,
  confusion: { truePositives, falsePositives, falseNegatives },
  precision,
  recall,
  outcomeAccuracy,
  acceptance: {
    minimumPrecision: PRECISION_GATE,
    minimumRecall: RECALL_GATE,
    exactPolicyOutcomeRequired: true,
  },
  passed,
  cases,
};

await writeFile(
  resolve(process.cwd(), REPORT_PATH),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
console.log(
  `Subject dedup: ${cases.length} pairs, precision=${precision.toFixed(4)}, recall=${recall.toFixed(4)}, outcomes=${outcomeAccuracy.toFixed(4)}, passed=${passed}`,
);
if (!passed) {
  process.exitCode = 1;
}
