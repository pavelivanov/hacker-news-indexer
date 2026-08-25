import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import pg from "pg";

const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const STATES = ["OPEN", "APPROVED", "REJECTED", "SUPERSEDED"];
const KINDS = ["CONTENT_DECISION", "SUBJECT_MERGE", "URL_RESOLUTION"];
const REASONS = [
  "PROMPT_INJECTION",
  "DESTRUCTIVE_OR_EVASION_ADVICE",
  "DELETED_OR_FLAGGED_CONTENT",
  "SECURITY_RECOMMENDATION",
  "MEDICAL_RECOMMENDATION",
  "LEGAL_RECOMMENDATION",
  "TELEGRAM_HN_DIVERGENCE",
  "CONFLICTING_EVIDENCE_ORIGIN",
  "FINDTHATPROJECT_INITIAL_ROLLOUT",
  "NAME_ONLY_MERGE_SUGGESTION",
  "AMBIGUOUS_CANONICAL_URL",
  "MISSING_CANONICAL_URL",
  "ROOT_ONLY_DISCOVERY",
  "LOW_CONFIDENCE",
  "AMBIGUOUS_CLASSIFICATION",
  "UNPROMOTED_MODEL_DECISION",
];

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : (process.argv[index + 1] ?? null);
};

const zeroCounts = (keys) => Object.fromEntries(keys.map((key) => [key, 0]));

const loadSeedCommentIds = async () => {
  const raw = await readFile(
    resolve(process.cwd(), "evaluation/gold-v1.jsonl"),
    "utf8",
  );
  const ids = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line).commentId);
  if (
    ids.length !== 98 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
  ) {
    throw new TypeError("SEED_CORPUS_IDS_INVALID");
  }
  return ids;
};

const main = async () => {
  const corpus = argument("--corpus");
  if (corpus !== "seed-v1") {
    throw new TypeError("--corpus must be seed-v1");
  }
  try {
    process.loadEnvFile(resolve(process.cwd(), ".env"));
  } catch (error) {
    if (
      error === null ||
      typeof error !== "object" ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
  const commentIds = await loadSeedCommentIds();
  const connectionString =
    process.env.DATABASE_URL ??
    "postgresql://hn_knowledge:hn_knowledge@127.0.0.1:5432/hn_knowledge";
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 2_000,
  });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT "kind", "state", "priority", "reason_codes"
       FROM "review_tasks"
       WHERE "comment_id" = ANY($1::BIGINT[])`,
      [commentIds.map(String)],
    );
    const byPriority = zeroCounts(PRIORITIES);
    const byState = zeroCounts(STATES);
    const byKind = zeroCounts(KINDS);
    const byReason = zeroCounts(REASONS);
    for (const row of result.rows) {
      if (
        !(row.priority in byPriority) ||
        !(row.state in byState) ||
        !(row.kind in byKind)
      ) {
        throw new TypeError("REVIEW_STATS_ENUM_DRIFT");
      }
      byPriority[row.priority] += 1;
      byState[row.state] += 1;
      byKind[row.kind] += 1;
      for (const reason of row.reason_codes) {
        if (!(reason in byReason)) {
          throw new TypeError("REVIEW_STATS_REASON_DRIFT");
        }
        byReason[reason] += 1;
      }
    }
    const report = {
      reportVersion: "review-stats.v1",
      corpus,
      corpusCommentCount: commentIds.length,
      taskCount: result.rowCount ?? result.rows.length,
      byPriority,
      byState,
      byKind,
      byReason,
    };
    const output = argument("--output");
    if (output !== null) {
      await writeFile(
        resolve(process.cwd(), output),
        `${JSON.stringify(report, null, 2)}\n`,
        { encoding: "utf8", flag: "w" },
      );
    }
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    await client.end();
  }
};

try {
  await main();
} catch (error) {
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? String(error.code)
      : error instanceof Error
        ? error.message
        : "UNKNOWN";
  process.stderr.write(`Review stats failed: ${code}\n`);
  process.exitCode = 1;
}
