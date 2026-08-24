import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

type PrimaryClass = "DISCOVERY" | "EXPERT_NOTE" | "REJECTED";
type EvidenceOrigin = "COMMENT" | "ROOT_STORY" | "BOTH";

interface EvaluationSource {
  readonly documents: readonly {
    readonly commentId: number;
    readonly comment: {
      readonly documentId: string;
      readonly plainText: string;
    };
    readonly root: { readonly documentId: string; readonly plainText: string };
    readonly urlCandidates: readonly { readonly id: string }[];
  }[];
}

interface HoldoutFile {
  readonly commentIds: readonly number[];
}

interface EvidenceSpan {
  readonly id: string;
  readonly documentId: string;
  readonly origin: "COMMENT" | "ROOT_STORY";
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly textSha256: string;
}

interface GoldRow {
  readonly schemaVersion: "gold.v1";
  readonly commentId: number;
  readonly primaryClass: PrimaryClass;
  readonly evidenceSpans: readonly EvidenceSpan[];
  readonly discoveries: readonly {
    readonly subjectType: string;
    readonly name: string;
    readonly aliases: readonly string[];
    readonly description: string;
    readonly evidenceOrigin: EvidenceOrigin;
    readonly evidenceSpanIds: readonly string[];
    readonly urlCandidateIds: readonly string[];
    readonly rootOnly: boolean;
  }[];
  readonly expertNote: null | {
    readonly noteType: string;
    readonly title: string;
    readonly summary: string;
    readonly evidenceOrigin: EvidenceOrigin;
    readonly evidenceSpanIds: readonly string[];
    readonly relatedSubjectNames: readonly string[];
    readonly qualifiers: readonly string[];
  };
  readonly reviewFlags: readonly string[];
  readonly rejectionReason: string | null;
  readonly holdout: boolean;
  readonly annotation: {
    readonly annotatorA: {
      readonly id: "A";
      readonly primaryClass: PrimaryClass;
    };
    readonly annotatorB: {
      readonly id: "B";
      readonly primaryClass: PrimaryClass;
    };
    readonly adjudication: {
      readonly adjudicator: "codex-root";
      readonly disagreement: boolean;
      readonly rationale: string;
    };
  };
}

const PRIMARY_CLASSES = new Set<PrimaryClass>([
  "DISCOVERY",
  "EXPERT_NOTE",
  "REJECTED",
]);
const SUBJECT_TYPES = new Set([
  "PROJECT",
  "TOOL",
  "LIBRARY",
  "SERVICE",
  "PRODUCT",
  "FEATURE",
  "PLUGIN",
  "AGENT_SKILL",
  "GUIDE",
  "RESOURCE",
]);
const NOTE_TYPES = new Set([
  "TECHNICAL_EXPLANATION",
  "CORRECTION",
  "PRODUCT_EXPERIENCE",
  "IMPLEMENTATION_CAVEAT",
  "SECURITY",
  "OPERATIONS",
  "COMPARISON",
  "GUIDE",
]);
const REVIEW_FLAGS = new Set([
  "MISSING_CANONICAL_URL",
  "AMBIGUOUS_CANONICAL_URL",
  "ROOT_ONLY_DISCOVERY",
  "LEGAL_RECOMMENDATION",
  "MEDICAL_RECOMMENDATION",
  "SECURITY_RECOMMENDATION",
  "DESTRUCTIVE_OR_EVASION_ADVICE",
  "LOW_CONFIDENCE",
  "PROMPT_INJECTION",
  "UNAVAILABLE_CONTENT",
  "TELEGRAM_HN_DIVERGENCE",
  "CONFLICTING_EVIDENCE_ORIGIN",
  "INVALID_EVIDENCE_SPAN",
  "UNSUPPORTED_URL",
  "AMBIGUOUS_CLASSIFICATION",
]);
const REJECTION_REASONS = new Set([
  "NON_TECHNICAL",
  "JOKE_OR_ONE_LINER",
  "GENERIC_OPINION",
  "PERSONAL_STORY",
  "INCIDENTAL_MENTION",
  "NEWS_WITHOUT_REUSABLE_DETAIL",
  "UNAVAILABLE_CONTENT",
  "LOW_INFORMATION",
]);
const RAW_URL = /https?:\/\//iu;

const goldPath = path.resolve(process.argv[2] ?? "evaluation/gold-v1.jsonl");
const sourcePath = path.resolve(
  process.argv[3] ?? "/tmp/hn-evaluation-source.json",
);
const holdoutPath = path.resolve(
  process.argv[4] ?? "evaluation/holdout-v1.json",
);

const fail = (message: string): never => {
  throw new TypeError(message);
};

const record = (value: unknown, location: string): Record<string, unknown> => {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(`${location} must be an object`);
  }
  return value as Record<string, unknown>;
};

const exactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
  location: string,
): void => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.join("\u0000") !== expected.join("\u0000")) {
    fail(`${location} has unexpected or missing fields`);
  }
};

const text = (
  value: unknown,
  location: string,
  minimum: number,
  maximum: number,
  forbidRawUrl = false,
): string => {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum
  ) {
    fail(`${location} must contain ${minimum} to ${maximum} characters`);
  }
  if (forbidRawUrl && RAW_URL.test(value)) {
    fail(`${location} must reference opaque URL candidate IDs, not raw URLs`);
  }
  return value;
};

const integer = (value: unknown, location: string, minimum = 0): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail(`${location} must be an integer at least ${minimum}`);
  }
  return value as number;
};

const boolean = (value: unknown, location: string): boolean => {
  if (typeof value !== "boolean") {
    fail(`${location} must be a boolean`);
  }
  return value;
};

const array = (
  value: unknown,
  location: string,
  maximum: number,
): unknown[] => {
  if (!Array.isArray(value) || value.length > maximum) {
    fail(`${location} must be an array with at most ${maximum} entries`);
  }
  return value;
};

const unique = (values: readonly string[], location: string): void => {
  if (new Set(values).size !== values.length) {
    fail(`${location} must not contain duplicates`);
  }
};

const enumValue = <T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  location: string,
): T => {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    fail(`${location} is not an allowed value`);
  }
  return value as T;
};

const stringArray = (
  value: unknown,
  location: string,
  maximumItems: number,
  maximumLength: number,
  pattern?: RegExp,
): string[] => {
  const values = array(value, location, maximumItems).map((entry, index) => {
    const result = text(entry, `${location}[${index}]`, 1, maximumLength, true);
    if (pattern !== undefined && !pattern.test(result)) {
      fail(`${location}[${index}] has an invalid format`);
    }
    return result;
  });
  unique(values, location);
  return values;
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const parseEvidenceSpan = (value: unknown, location: string): EvidenceSpan => {
  const item = record(value, location);
  exactKeys(
    item,
    ["id", "documentId", "origin", "start", "end", "text", "textSha256"],
    location,
  );
  const origin = enumValue(
    item["origin"],
    new Set(["COMMENT", "ROOT_STORY"] as const),
    `${location}.origin`,
  );
  return {
    id: text(item["id"], `${location}.id`, 1, 64),
    documentId: text(item["documentId"], `${location}.documentId`, 1, 64),
    origin,
    start: integer(item["start"], `${location}.start`),
    end: integer(item["end"], `${location}.end`, 1),
    text: text(item["text"], `${location}.text`, 1, 4096),
    textSha256: text(item["textSha256"], `${location}.textSha256`, 64, 64),
  };
};

const parseDecision = (
  value: unknown,
  expectedId: "A" | "B",
  location: string,
): { id: "A" | "B"; primaryClass: PrimaryClass } => {
  const item = record(value, location);
  exactKeys(item, ["id", "primaryClass"], location);
  if (item["id"] !== expectedId) {
    fail(`${location}.id must be ${expectedId}`);
  }
  return {
    id: expectedId,
    primaryClass: enumValue(
      item["primaryClass"],
      PRIMARY_CLASSES,
      `${location}.primaryClass`,
    ),
  };
};

const parseGoldRow = (value: unknown, index: number): GoldRow => {
  const location = `row ${index + 1}`;
  const item = record(value, location);
  exactKeys(
    item,
    [
      "schemaVersion",
      "commentId",
      "primaryClass",
      "evidenceSpans",
      "discoveries",
      "expertNote",
      "reviewFlags",
      "rejectionReason",
      "holdout",
      "annotation",
    ],
    location,
  );
  if (item["schemaVersion"] !== "gold.v1") {
    fail(`${location}.schemaVersion must be gold.v1`);
  }
  const evidenceSpans = array(
    item["evidenceSpans"],
    `${location}.evidenceSpans`,
    32,
  ).map((span, spanIndex) =>
    parseEvidenceSpan(span, `${location}.evidenceSpans[${spanIndex}]`),
  );
  const discoveries = array(
    item["discoveries"],
    `${location}.discoveries`,
    5,
  ).map((discovery, discoveryIndex) => {
    const childLocation = `${location}.discoveries[${discoveryIndex}]`;
    const child = record(discovery, childLocation);
    exactKeys(
      child,
      [
        "subjectType",
        "name",
        "aliases",
        "description",
        "evidenceOrigin",
        "evidenceSpanIds",
        "urlCandidateIds",
        "rootOnly",
      ],
      childLocation,
    );
    return {
      subjectType: enumValue(
        child["subjectType"],
        SUBJECT_TYPES,
        `${childLocation}.subjectType`,
      ),
      name: text(child["name"], `${childLocation}.name`, 1, 160, true),
      aliases: stringArray(
        child["aliases"],
        `${childLocation}.aliases`,
        10,
        160,
      ),
      description: text(
        child["description"],
        `${childLocation}.description`,
        1,
        1000,
        true,
      ),
      evidenceOrigin: enumValue(
        child["evidenceOrigin"],
        new Set(["COMMENT", "ROOT_STORY", "BOTH"] as const),
        `${childLocation}.evidenceOrigin`,
      ),
      evidenceSpanIds: stringArray(
        child["evidenceSpanIds"],
        `${childLocation}.evidenceSpanIds`,
        12,
        64,
        /^span:[a-z]+:[0-9]+$/u,
      ),
      urlCandidateIds: stringArray(
        child["urlCandidateIds"],
        `${childLocation}.urlCandidateIds`,
        12,
        32,
        /^url:[0-9]+$/u,
      ),
      rootOnly: boolean(child["rootOnly"], `${childLocation}.rootOnly`),
    };
  });
  let expertNote: GoldRow["expertNote"] = null;
  if (item["expertNote"] !== null) {
    const childLocation = `${location}.expertNote`;
    const child = record(item["expertNote"], childLocation);
    exactKeys(
      child,
      [
        "noteType",
        "title",
        "summary",
        "evidenceOrigin",
        "evidenceSpanIds",
        "relatedSubjectNames",
        "qualifiers",
      ],
      childLocation,
    );
    expertNote = {
      noteType: enumValue(
        child["noteType"],
        NOTE_TYPES,
        `${childLocation}.noteType`,
      ),
      title: text(child["title"], `${childLocation}.title`, 1, 200, true),
      summary: text(
        child["summary"],
        `${childLocation}.summary`,
        1,
        2000,
        true,
      ),
      evidenceOrigin: enumValue(
        child["evidenceOrigin"],
        new Set(["COMMENT", "ROOT_STORY", "BOTH"] as const),
        `${childLocation}.evidenceOrigin`,
      ),
      evidenceSpanIds: stringArray(
        child["evidenceSpanIds"],
        `${childLocation}.evidenceSpanIds`,
        16,
        64,
        /^span:[a-z]+:[0-9]+$/u,
      ),
      relatedSubjectNames: stringArray(
        child["relatedSubjectNames"],
        `${childLocation}.relatedSubjectNames`,
        12,
        160,
      ),
      qualifiers: stringArray(
        child["qualifiers"],
        `${childLocation}.qualifiers`,
        12,
        300,
      ),
    };
  }
  const annotation = record(item["annotation"], `${location}.annotation`);
  exactKeys(
    annotation,
    ["annotatorA", "annotatorB", "adjudication"],
    `${location}.annotation`,
  );
  const adjudication = record(
    annotation["adjudication"],
    `${location}.annotation.adjudication`,
  );
  exactKeys(
    adjudication,
    ["adjudicator", "disagreement", "rationale"],
    `${location}.annotation.adjudication`,
  );
  if (adjudication["adjudicator"] !== "codex-root") {
    fail(`${location}.annotation.adjudication.adjudicator is invalid`);
  }
  const reviewFlags = array(
    item["reviewFlags"],
    `${location}.reviewFlags`,
    12,
  ).map((flag, flagIndex) =>
    enumValue(flag, REVIEW_FLAGS, `${location}.reviewFlags[${flagIndex}]`),
  );
  unique(reviewFlags, `${location}.reviewFlags`);
  const rejectionReason =
    item["rejectionReason"] === null
      ? null
      : enumValue(
          item["rejectionReason"],
          REJECTION_REASONS,
          `${location}.rejectionReason`,
        );
  return {
    schemaVersion: "gold.v1",
    commentId: integer(item["commentId"], `${location}.commentId`, 1),
    primaryClass: enumValue(
      item["primaryClass"],
      PRIMARY_CLASSES,
      `${location}.primaryClass`,
    ),
    evidenceSpans,
    discoveries,
    expertNote,
    reviewFlags,
    rejectionReason,
    holdout: boolean(item["holdout"], `${location}.holdout`),
    annotation: {
      annotatorA: parseDecision(
        annotation["annotatorA"],
        "A",
        `${location}.annotation.annotatorA`,
      ),
      annotatorB: parseDecision(
        annotation["annotatorB"],
        "B",
        `${location}.annotation.annotatorB`,
      ),
      adjudication: {
        adjudicator: "codex-root",
        disagreement: boolean(
          adjudication["disagreement"],
          `${location}.annotation.adjudication.disagreement`,
        ),
        rationale: text(
          adjudication["rationale"],
          `${location}.annotation.adjudication.rationale`,
          1,
          1000,
          true,
        ),
      },
    },
  };
};

const originOf = (
  spanIds: readonly string[],
  spans: ReadonlyMap<string, EvidenceSpan>,
  location: string,
): EvidenceOrigin => {
  if (spanIds.length === 0) {
    fail(`${location} must reference at least one evidence span`);
  }
  const origins = new Set(
    spanIds.map((id) => {
      const span = spans.get(id);
      if (span === undefined) {
        fail(`${location} references unknown evidence span ${id}`);
      }
      return span.origin;
    }),
  );
  return origins.size === 2
    ? "BOTH"
    : origins.has("COMMENT")
      ? "COMMENT"
      : "ROOT_STORY";
};

const kappa = (rows: readonly GoldRow[]): number => {
  const agreement = rows.filter(
    (row) =>
      row.annotation.annotatorA.primaryClass ===
      row.annotation.annotatorB.primaryClass,
  ).length;
  const expected = [...PRIMARY_CLASSES].reduce((sum, primaryClass) => {
    const a = rows.filter(
      (row) => row.annotation.annotatorA.primaryClass === primaryClass,
    ).length;
    const b = rows.filter(
      (row) => row.annotation.annotatorB.primaryClass === primaryClass,
    ).length;
    return sum + (a / rows.length) * (b / rows.length);
  }, 0);
  return (agreement / rows.length - expected) / (1 - expected);
};

const [goldJsonl, sourceJson, holdoutJson] = await Promise.all([
  readFile(goldPath, "utf8"),
  readFile(sourcePath, "utf8"),
  readFile(holdoutPath, "utf8"),
]);
const rows = goldJsonl
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line, index) => parseGoldRow(JSON.parse(line) as unknown, index));
const source = JSON.parse(sourceJson) as EvaluationSource;
const holdout = JSON.parse(holdoutJson) as HoldoutFile;
if (rows.length !== 98) {
  fail(`Gold corpus must contain 98 rows, received ${rows.length}`);
}
const rowIds = rows.map((row) => row.commentId);
if (new Set(rowIds).size !== rows.length) {
  fail("Gold corpus comment IDs must be unique");
}
const expectedIds = source.documents.map((document) => document.commentId);
if ([...rowIds].sort().join(",") !== [...expectedIds].sort().join(",")) {
  fail("Gold corpus IDs differ from the frozen selected-comment corpus");
}
const holdoutIds = new Set(holdout.commentIds);
if (holdoutIds.size !== 29) {
  fail("Holdout must contain exactly 29 unique comment IDs");
}
const sourceById = new Map(
  source.documents.map((document) => [document.commentId, document]),
);
for (const [index, row] of rows.entries()) {
  const location = `row ${index + 1}`;
  const document = sourceById.get(row.commentId);
  if (document === undefined) {
    fail(`${location} has no source document`);
  }
  if (row.holdout !== holdoutIds.has(row.commentId)) {
    fail(`${location}.holdout differs from holdout-v1.json`);
  }
  const spans = new Map<string, EvidenceSpan>();
  for (const span of row.evidenceSpans) {
    if (spans.has(span.id)) {
      fail(`${location} contains duplicate evidence span ${span.id}`);
    }
    const expectedDocument =
      span.origin === "COMMENT" ? document.comment : document.root;
    if (span.documentId !== expectedDocument.documentId) {
      fail(`${location} evidence span ${span.id} has the wrong document ID`);
    }
    if (
      span.end <= span.start ||
      span.end > expectedDocument.plainText.length
    ) {
      fail(`${location} evidence span ${span.id} has invalid offsets`);
    }
    if (expectedDocument.plainText.slice(span.start, span.end) !== span.text) {
      fail(`${location} evidence span ${span.id} does not reproduce source`);
    }
    if (span.textSha256 !== sha256(span.text)) {
      fail(`${location} evidence span ${span.id} has the wrong SHA-256`);
    }
    spans.set(span.id, span);
  }
  const candidateIds = new Set(
    document.urlCandidates.map((candidate) => candidate.id),
  );
  for (const [discoveryIndex, discovery] of row.discoveries.entries()) {
    const childLocation = `${location}.discoveries[${discoveryIndex}]`;
    const actualOrigin = originOf(
      discovery.evidenceSpanIds,
      spans,
      `${childLocation}.evidenceSpanIds`,
    );
    if (actualOrigin !== discovery.evidenceOrigin) {
      fail(`${childLocation}.evidenceOrigin differs from its spans`);
    }
    if (discovery.rootOnly !== (actualOrigin === "ROOT_STORY")) {
      fail(`${childLocation}.rootOnly differs from its evidence origin`);
    }
    if (
      !discovery.evidenceSpanIds.some((id) => {
        const evidence = spans.get(id)?.text.toLocaleLowerCase() ?? "";
        return [discovery.name, ...discovery.aliases].some((name) =>
          evidence.includes(name.toLocaleLowerCase()),
        );
      })
    ) {
      fail(`${childLocation}.name is not reproduced by supporting evidence`);
    }
    for (const candidateId of discovery.urlCandidateIds) {
      if (!candidateIds.has(candidateId)) {
        fail(
          `${childLocation} references unknown URL candidate ${candidateId}`,
        );
      }
    }
  }
  if (row.expertNote !== null) {
    const actualOrigin = originOf(
      row.expertNote.evidenceSpanIds,
      spans,
      `${location}.expertNote.evidenceSpanIds`,
    );
    if (actualOrigin !== row.expertNote.evidenceOrigin) {
      fail(`${location}.expertNote.evidenceOrigin differs from its spans`);
    }
  }
  if (row.primaryClass === "DISCOVERY") {
    if (row.discoveries.length === 0 || row.rejectionReason !== null) {
      fail(`${location} DISCOVERY content is inconsistent`);
    }
  } else if (row.primaryClass === "EXPERT_NOTE") {
    if (
      row.discoveries.length !== 0 ||
      row.expertNote === null ||
      row.rejectionReason !== null
    ) {
      fail(`${location} EXPERT_NOTE content is inconsistent`);
    }
  } else if (
    row.discoveries.length !== 0 ||
    row.expertNote !== null ||
    row.rejectionReason === null ||
    row.evidenceSpans.length !== 0
  ) {
    fail(`${location} REJECTED content is inconsistent`);
  }
  const disagreement =
    row.annotation.annotatorA.primaryClass !==
    row.annotation.annotatorB.primaryClass;
  if (row.annotation.adjudication.disagreement !== disagreement) {
    fail(`${location} disagreement metadata is inconsistent`);
  }
}

const counts = Object.fromEntries(
  [...PRIMARY_CLASSES].map((primaryClass) => [
    primaryClass,
    rows.filter((row) => row.primaryClass === primaryClass).length,
  ]),
) as Record<PrimaryClass, number>;
if (
  counts.DISCOVERY !== 13 ||
  counts.EXPERT_NOTE !== 22 ||
  counts.REJECTED !== 63
) {
  fail(
    `Gold totals differ from the frozen research totals: ${JSON.stringify(counts)}`,
  );
}
const measuredKappa = kappa(rows);
if (!Number.isFinite(measuredKappa) || measuredKappa < 0.75) {
  fail(`Cohen's kappa ${measuredKappa.toFixed(4)} is below 0.75`);
}

console.log(
  JSON.stringify(
    {
      schemaVersion: "gold.v1",
      rows: rows.length,
      counts,
      holdout: holdoutIds.size,
      annotatorDisagreements: rows.filter(
        (row) => row.annotation.adjudication.disagreement,
      ).length,
      cohensKappa: Number(measuredKappa.toFixed(4)),
      evidenceSpans: rows.reduce(
        (total, row) => total + row.evidenceSpans.length,
        0,
      ),
      rawUrlFields: 0,
    },
    null,
    2,
  ),
);
