import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import {
  createDatabase,
  createFeedProcessingRepository,
} from "@hn-knowledge/db";
import { checkTarget } from "./target.mjs";

const snapshotOnly = process.argv[2] === "--snapshot";
if (process.argv.length > 3 || (process.argv.length === 3 && !snapshotOnly))
  throw new Error("feed:status accepts only the optional --snapshot flag");
const local = parseEnv(await readFile(".env.manual-review.local", "utf8"));
checkTarget(local.DATABASE_URL, "hn_manual_review");
const database = createDatabase({ connectionString: local.DATABASE_URL });
try {
  const client = database.client;
  if (snapshotOnly) {
    // Explicit columns let this read-only preflight run before settings migration 0012.
    const [settings, oldest, results, feedback, approvals] = await Promise.all([
      client.$queryRaw`SELECT interval_seconds, daily_request_limit, batch_size, enabled, cursor FROM feed_processing_state WHERE id = 'local'`,
      client.classifierResultSnapshot.findMany({
        take: 98,
        orderBy: [{ createdAt: "asc" }, { runId: "asc" }],
        select: {
          runId: true,
          sourceInput: true,
          originalOutput: true,
          errorCode: true,
          createdAt: true,
        },
      }),
      client.classifierResultSnapshot.count(),
      client.classifierFeedback.count(),
      client.manualReviewReceipt.count(),
    ]);
    console.log(
      JSON.stringify(
        {
          settings,
          results,
          feedback,
          approvals,
          oldestSnapshotCount: oldest.length,
          oldestSnapshotDigest: createHash("sha256")
            .update(JSON.stringify(oldest))
            .digest("hex"),
        },
        (_key, value) => (typeof value === "bigint" ? value.toString() : value),
        2,
      ),
    );
  } else {
    const processing = createFeedProcessingRepository(client);
    const [status, state, oldest, total, feedback, approvals, batches, jobs] =
      await Promise.all([
        processing.status(),
        processing.state(),
        client.classifierResultSnapshot.findMany({
          take: 98,
          orderBy: [{ createdAt: "asc" }, { runId: "asc" }],
          select: {
            runId: true,
            sourceInput: true,
            originalOutput: true,
            errorCode: true,
            createdAt: true,
          },
        }),
        client.classifierResultSnapshot.count(),
        client.classifierFeedback.count(),
        client.manualReviewReceipt.count(),
        client.ingestionRun.findMany({
          where: { feedBatch: { isNot: null } },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: { minId: true, maxId: true, status: true },
        }),
        client.pipelineJob.groupBy({
          by: ["type", "state"],
          where: { lane: "feed" },
          _count: { _all: true },
        }),
      ]);
    console.log(
      JSON.stringify(
        {
          status,
          cursor: state?.cursor?.toString() ?? null,
          results: total,
          feedback,
          approvals,
          oldestSnapshotCount: oldest.length,
          oldestSnapshotDigest: createHash("sha256")
            .update(JSON.stringify(oldest))
            .digest("hex"),
          batches,
          jobs,
        },
        (_key, value) => (typeof value === "bigint" ? value.toString() : value),
        2,
      ),
    );
  }
} finally {
  await database.close();
}
