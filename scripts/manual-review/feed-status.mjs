import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import {
  createDatabase,
  createFeedProcessingRepository,
} from "@hn-knowledge/db";
import { checkTarget } from "./target.mjs";

if (process.argv.length !== 2)
  throw new Error("feed:status takes no arguments");
const local = parseEnv(await readFile(".env.manual-review.local", "utf8"));
checkTarget(local.DATABASE_URL, "hn_manual_review");
const database = createDatabase({ connectionString: local.DATABASE_URL });
try {
  const client = database.client;
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
} finally {
  await database.close();
}
