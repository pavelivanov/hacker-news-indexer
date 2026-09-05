import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { createHash } from "node:crypto";
import pg from "pg";
import { OpenAiClassifier } from "@hn-knowledge/adapters";
import {
  createDatabase,
  createClassificationRepository,
  createClassifierResultsRepository,
} from "@hn-knowledge/db";
import {
  createClassifyComment,
  captureClassifierResult,
  loadClassifierInput,
  CLASSIFICATION_PROMPT_VERSION,
  CLASSIFICATION_SCHEMA_VERSION,
} from "@hn-knowledge/application";
import { hnItemId, classificationRunId } from "@hn-knowledge/domain";
import { checkTarget } from "./manual-review/target.mjs";

const args = process.argv.slice(2);
if (
  args.length !== 2 ||
  args[0] !== "--limit" ||
  !/^[1-9][0-9]*$/.test(args[1]) ||
  Number(args[1]) > 100
)
  throw new Error("Use --limit 1..100 to bound local generation");
const local = parseEnv(await readFile(".env.manual-review.local", "utf8"));
checkTarget(local.DATABASE_URL, "hn_manual_review");
if (
  local.HOST !== "127.0.0.1" ||
  local.TELEGRAM_ENABLED !== "false" ||
  local.CLASSIFIER_ENABLED !== "false"
)
  throw new Error(
    "Local generation requires the isolated loopback workspace with workers disabled",
  );
const providerEnv = parseEnv(await readFile(".env", "utf8"));
if (
  providerEnv.CLASSIFIER_PROVIDER !== "openai" ||
  !providerEnv.CLASSIFIER_API_TOKEN ||
  !providerEnv.CLASSIFIER_MODEL
)
  throw new Error(
    "Configure CLASSIFIER_PROVIDER, CLASSIFIER_API_TOKEN and CLASSIFIER_MODEL in .env; credentials stay outside the browser",
  );
const provider = new OpenAiClassifier({
  apiToken: providerEnv.CLASSIFIER_API_TOKEN,
  modelId: providerEnv.CLASSIFIER_MODEL,
  reasoningEffort: providerEnv.CLASSIFIER_REASONING_EFFORT ?? "low",
});
const database = createDatabase({ connectionString: local.DATABASE_URL });
const lock = new pg.Client({ connectionString: local.DATABASE_URL });
const hasher = {
  sha256: (value) => createHash("sha256").update(value).digest("hex"),
};
const classifications = createClassificationRepository(database.client);
const results = createClassifierResultsRepository(database.client);
const classify = createClassifyComment(provider, classifications, hasher, null);
let providerRequests = 0;
let reused = 0;
let captured = 0;
let failed = 0;
let stop = false;
try {
  await lock.connect();
  const acquired = await lock.query(
    "SELECT pg_try_advisory_lock(140014) AS acquired",
  );
  if (!acquired.rows[0]?.acquired)
    throw new Error("Another local generation command is running");
  const comments = await database.client.selectedComment.findMany({
    where: { availability: "AVAILABLE", item: { availability: "AVAILABLE" } },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  const pending = [];
  for (const comment of comments) {
    const source = await loadClassifierInput(
      hnItemId(Number(comment.id)),
      classifications,
      hasher,
    );
    const identity = {
      attempt: 1,
      commentId: comment.id,
      inputHash: hasher.sha256(JSON.stringify(source)),
      promptVersion: CLASSIFICATION_PROMPT_VERSION,
      schemaVersion: CLASSIFICATION_SCHEMA_VERSION,
      modelConfigId: provider.modelConfigId,
    };
    const run = await database.client.classificationRun.findUnique({
      where: {
        runIdentity: identity,
      },
    });
    if (run) {
      await captureClassifierResult(
        results,
        classifications,
        classificationRunId(run.id),
        source,
        hasher,
      );
      reused += 1;
    } else if (pending.length < Number(args[1]))
      pending.push({ source, identity });
  }
  console.log(
    JSON.stringify({
      event: "generation_started",
      comments: pending.length,
      reused,
      model: provider.modelId,
      approvalsRequired: false,
    }),
  );
  let next = 0;
  const worker = async () => {
    while (next < pending.length && !stop) {
      const item = pending[next++];
      providerRequests += 1;
      let errorCode = null;
      try {
        await classify({
          commentId: item.source.selectedCommentId,
          boundedInput: item.source,
          persistRetryableFailure: true,
        });
      } catch (error) {
        errorCode =
          typeof error.code === "string" ? error.code : "GENERATION_FAILED";
        if (["CLASSIFIER_AUTH", "CLASSIFIER_CONFIG"].includes(errorCode))
          stop = true;
      }
      const run = await database.client.classificationRun.findUnique({
        where: {
          runIdentity: item.identity,
        },
      });
      if (run) {
        await captureClassifierResult(
          results,
          classifications,
          classificationRunId(run.id),
          item.source,
          hasher,
        );
        captured += 1;
        if (run.errorCode) failed += 1;
      } else failed += 1;
      console.log(
        JSON.stringify({
          event: "result_stored",
          comment: item.source.selectedCommentId,
          status: run?.errorCode || errorCode ? "failed" : "ready",
          error: run?.errorCode ?? errorCode,
        }),
      );
    }
  };
  await Promise.all([worker(), worker()]);
  console.log(
    JSON.stringify({
      event: "generation_completed",
      attemptedComments: providerRequests,
      captured,
      failed,
      reused,
      approvals: 0,
      corrections: 0,
    }),
  );
  if (stop) process.exitCode = 1;
} finally {
  await lock.end();
  await database.close();
}
