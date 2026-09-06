import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { createApp } from "@hn-knowledge/api";
import {
  createDatabase,
  createFeedProcessingRepository,
  createJobQueue,
  acquireFeedLock,
  createClassificationRepository,
  createClassifierResultsRepository,
} from "@hn-knowledge/db";
import {
  createFeedProcessingService,
  createClassifierResultsService,
  createClassifyComment,
} from "@hn-knowledge/application";
import { hnItemId } from "@hn-knowledge/domain";
import { dailyFeedFixture } from "../fixtures/manual-review/daily-feed.js";
import {
  seedClassifierResult,
  resultHasher,
} from "../fixtures/manual-review/classifier-result.js";
import { manualOutput } from "../fixtures/manual-review/output.js";

const url = process.env["DATABASE_URL"];
if (
  !url ||
  new URL(url).pathname !== "/hn_manual_review_test" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)
)
  throw new Error("Daily feed integration requires isolated database");
const database = createDatabase({ connectionString: url });
const client = database.client;
const processing = createFeedProcessingRepository(client);
const api = createApp({
  apiToken: "fixture-token",
  feedProcessingService: createFeedProcessingService(processing),
});
const post = (path: string, body: unknown) =>
  api.request(path, {
    method: "POST",
    headers: {
      Authorization: "Bearer fixture-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
const clean = () =>
  client.$executeRawUnsafe(
    'TRUNCATE "hn_items", "classification_runs", "content_decisions", "subjects", "review_tasks", "manual_override_events", "ingestion_runs", "selection_occurrences", "pipeline_jobs", "feed_processing_state", "feed_request_usage", "feed_command_receipts" CASCADE',
  );
beforeEach(clean);
afterAll(async () => {
  await clean();
  await database.close();
});

describe("automatic private feed", () => {
  it("ingests incremental ranges and exposes results without approval or duplicate requests", async () => {
    const fixture = await dailyFeedFixture(database);
    await fixture.drain();
    expect(fixture.state.ranges).toEqual([[1, 2]]);
    expect((await processing.state())?.cursor).toBe(2n);
    expect(await client.classifierResultSnapshot.count()).toBe(2);
    expect(await client.reviewTask.count()).toBe(0);
    expect(await client.manualOverrideEvent.count()).toBe(0);
    expect(
      await client.selectedComment.count({
        where: { activeDecisionId: { not: null } },
      }),
    ).toBe(0);
    await processing.control("sync");
    await fixture.drain();
    expect(fixture.state.calls).toBe(2);
    fixture.state.latest = 3;
    await processing.control("sync");
    await fixture.drain();
    expect(fixture.state.ranges).toEqual([
      [1, 2],
      [3, 3],
    ]);
    expect(fixture.state.calls).toBe(3);
    const status = await processing.status();
    expect(status).toMatchObject({
      pending: 0,
      processing: 0,
      failed: 0,
      requests_today: 3,
      online: true,
    });
  });
  it("bounds initial history and does not advance the cursor after failed ingestion", async () => {
    const fixture = await dailyFeedFixture(database);
    fixture.state.latest = 4;
    fixture.state.sourceFails = true;
    await fixture.runtime.tick();
    expect(fixture.state.ranges).toEqual([[3, 4]]);
    expect((await processing.state())?.cursor).toBeNull();
    expect(await client.selectedComment.count()).toBe(0);
    const job = await client.pipelineJob.findFirstOrThrow({
      where: { lane: "feed", state: "TERMINAL" },
    });
    fixture.state.sourceFails = false;
    const response = await post(`/v1/processing/jobs/${job.id}/retry`, {
      command_key: "source-retry",
    });
    expect(response.status).toBe(200);
    await fixture.drain();
    expect((await processing.state())?.cursor).toBe(4n);
    expect(await client.selectedComment.count()).toBe(2);
  });
  it("keeps feed jobs out of the legacy worker and honors pause", async () => {
    const fixture = await dailyFeedFixture(database);
    await processing.control("pause");
    await fixture.runtime.tick();
    expect(fixture.state.latestCalls).toBe(0);
    await processing.control("resume");
    await processing.scheduleLatest(2);
    expect(
      await createJobQueue(client).claim({
        leaseOwner: "legacy",
        leaseDurationMs: 1000,
      }),
    ).toBeNull();
    await fixture.drain();
    expect(fixture.state.calls).toBe(2);
  });
  it("reserves a hard daily request cap atomically and defers work at the limit", async () => {
    const reserved = await Promise.all(
      Array.from({ length: 20 }, () => processing.reserveRequest(5)),
    );
    expect(reserved.filter(Boolean)).toHaveLength(5);
    await client.feedRequestUsage.deleteMany();
    const fixture = await dailyFeedFixture(database);
    await client.feedProcessingState.update({
      where: { id: "local" },
      data: { dailyRequestLimit: 1 },
    });
    await fixture.drain();
    expect(fixture.state.calls).toBe(1);
    expect(await client.classifierResultSnapshot.count()).toBe(1);
    expect(await processing.status()).toMatchObject({
      requests_today: 1,
      pending: 1,
      failed: 0,
    });
    const queued = await client.pipelineJob.findFirstOrThrow({
      where: { lastErrorCode: "DAILY_REQUEST_LIMIT" },
    });
    expect(queued.attempts).toBe(0);
    expect(queued.availableAt.getTime()).toBeGreaterThan(Date.now());
  });
  it("counts validation retries against the same budget", async () => {
    const fixture = await dailyFeedFixture(database);
    fixture.state.invalidOutput = true;
    await client.feedProcessingState.update({
      where: { id: "local" },
      data: { dailyRequestLimit: 1 },
    });
    await fixture.drain();
    expect(fixture.state.calls).toBe(1);
    expect(await processing.status()).toMatchObject({
      requests_today: 1,
      pending: 2,
      failed: 0,
    });
  });
  it("defers a validation retry at the daily cap even on the final job attempt", async () => {
    const fixture = await dailyFeedFixture(database);
    await fixture.runtime.tick();
    await fixture.runtime.tick();
    await fixture.runtime.tick();
    await client.pipelineJob.updateMany({
      where: { lane: "feed", type: "CLASSIFY_COMMENT" },
      data: { attempts: 2 },
    });
    fixture.state.invalidOutput = true;
    await client.feedProcessingState.update({
      where: { id: "local" },
      data: { dailyRequestLimit: 1 },
    });
    await fixture.drain();
    expect(fixture.state.calls).toBe(1);
    expect(await client.classificationRun.count()).toBe(0);
    expect(await processing.status()).toMatchObject({
      requests_today: 1,
      pending: 2,
      failed: 0,
    });
    const jobs = await client.pipelineJob.findMany({
      where: { lane: "feed", type: "CLASSIFY_COMMENT" },
    });
    expect(jobs.every((job) => job.attempts === 2)).toBe(true);
  });
  it("preserves failed predictions and feedback while an idempotent retry creates a new attempt", async () => {
    const fixture = await dailyFeedFixture(database);
    fixture.state.invalidOutput = true;
    await fixture.drain();
    const original = await client.classifierResultSnapshot.findFirstOrThrow();
    const feedback = createClassifierResultsService(
      createClassifierResultsRepository(client),
      resultHasher,
      { actorId: "owner", cursorSecret: "fixture" },
    );
    await feedback.correct(original.runId, {
      expected_version: 0,
      command_key: "note-failure",
      category: "REVIEW",
      title: "",
      summary: "",
      issue: "OTHER",
      explanation: "Please retry this source",
    });
    const before = await client.classificationRun.findUniqueOrThrow({
      where: { id: original.runId },
    });
    fixture.state.invalidOutput = false;
    const path = `/v1/processing/results/${original.runId}/retry`;
    const replies = await Promise.all([
      post(path, { command_key: "retry-result" }),
      post(path, { command_key: "retry-result" }),
    ]);
    expect(replies.every((reply) => reply.status === 200)).toBe(true);
    const bodies = (await Promise.all(
      replies.map((reply) => reply.json()),
    )) as Array<{ job_id: string }>;
    expect(new Set(bodies.map((body) => body.job_id)).size).toBe(1);
    await fixture.drain();
    expect(
      await client.classificationRun.findUnique({
        where: { id: original.runId },
      }),
    ).toEqual(before);
    expect(
      await client.classificationRun.count({
        where: { commentId: before.commentId, attempt: 2, errorCode: null },
      }),
    ).toBe(1);
    expect((await feedback.get(original.runId)).feedback).toHaveLength(1);
    const firstReply = bodies[0];
    if (!firstReply) throw new Error("Missing retry response");
    expect(
      (
        await post(`/v1/processing/jobs/${firstReply.job_id}/retry`, {
          command_key: "retry-result",
        })
      ).status,
    ).toBe(409);
  });
  it("recovers a committed classification after a lost completion without another provider call", async () => {
    const fixture = await dailyFeedFixture(database);
    await fixture.drain();
    const job = await client.pipelineJob.findFirstOrThrow({
      where: { lane: "feed", type: "CLASSIFY_COMMENT" },
    });
    const snapshots = await client.classifierResultSnapshot.findMany();
    await client.pipelineJob.update({
      where: { id: job.id },
      data: {
        state: "LEASED",
        leaseOwner: "dead-worker",
        leaseExpiresAt: new Date(0),
      },
    });
    await fixture.runtime.tick();
    expect(fixture.state.calls).toBe(2);
    expect(await client.classifierResultSnapshot.findMany()).toEqual(snapshots);
    expect(
      (await client.pipelineJob.findUniqueOrThrow({ where: { id: job.id } }))
        .state,
    ).toBe("COMPLETED");
  });
  it("stops new provider dispatch after authentication fails", async () => {
    const fixture = await dailyFeedFixture(database);
    fixture.state.providerFails = true;
    await fixture.drain();
    expect(fixture.state.calls).toBe(1);
    expect(await processing.status()).toMatchObject({
      error_code: "CLASSIFIER_AUTH",
      failed: 1,
      pending: 1,
    });
    fixture.state.providerFails = false;
    await processing.control("sync");
    await fixture.drain();
    expect(fixture.state.calls).toBe(2);
  });
  it("prevents two local worker sessions from owning generation simultaneously", async () => {
    const first = await acquireFeedLock(url, () => {});
    try {
      await expect(acquireFeedLock(url, () => {})).rejects.toThrow(
        "FEED_WORKER_ALREADY_RUNNING",
      );
    } finally {
      await first.close();
    }
    const next = await acquireFeedLock(url, () => {});
    await next.close();
  });
  it("derives replayed decisions from persisted output when a competing response differs", async () => {
    const fixture = await seedClassifierResult(client);
    const output = manualOutput(fixture.source, "REJECTED");
    const repository = createClassificationRepository(client);
    const result = await createClassifyComment(
      {
        provider: "fixture",
        modelId: "synthetic-classifier",
        modelConfigId: "synthetic-classifier:results-v1",
        classify: async () => ({
          rawOutput: JSON.stringify(output),
          provider: "fixture",
          modelId: "synthetic-classifier",
          modelConfigId: "synthetic-classifier:results-v1",
          latencyMs: 1,
          inputTokens: 1,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 1,
        }),
      },
      repository,
      resultHasher,
      null,
    )({
      commentId: hnItemId(fixture.source.selectedCommentId),
      boundedInput: fixture.source,
    });
    expect(result.kind).toBe("DECISION");
    if (result.kind === "DECISION")
      expect(result.output.primary_decision).toBe("EXPERT_NOTE");
  });
  it("upgrades legacy runs and queued jobs with safe identity and lane defaults", async () => {
    const connection = new pg.Client({ connectionString: url });
    await connection.connect();
    try {
      await connection.query(
        "DROP SCHEMA IF EXISTS daily_feed_upgrade CASCADE",
      );
      await connection.query("CREATE SCHEMA daily_feed_upgrade");
      await connection.query("SET search_path TO daily_feed_upgrade");
      const directory = new URL(
        "../../packages/db/prisma/migrations/",
        import.meta.url,
      );
      for (const name of (await readdir(directory))
        .filter((name) => /^\d/.test(name) && name < "0010_daily_feed")
        .sort())
        await connection.query(
          await readFile(new URL(`${name}/migration.sql`, directory), "utf8"),
        );
      await connection.query(`INSERT INTO hn_items(id,type,availability,fetched_at,response_hash) VALUES(1,'comment','AVAILABLE',now(),'fixture');
        INSERT INTO selected_comments(id,root_id,canonical_html,canonical_text,content_hash,availability,last_seen_at) VALUES(1,1,'','source','fixture','AVAILABLE',now());
        INSERT INTO classification_runs(id,comment_id,input_hash,prompt_version,prompt_hash,schema_version,model_config_id,provider,model_id,output_hash,status)
        VALUES('00000000-0000-4000-8000-000000000001',1,'fixture','fixture','fixture','classification.v1','fixture','fixture','fixture','fixture','REVIEW');
        INSERT INTO pipeline_jobs(type,payload,idempotency_key,updated_at) VALUES('CLASSIFY_COMMENT','{}','legacy',now());`);
      await connection.query(
        await readFile(
          new URL("0010_daily_feed/migration.sql", directory),
          "utf8",
        ),
      );
      expect(
        (await connection.query("SELECT attempt FROM classification_runs"))
          .rows,
      ).toEqual([{ attempt: 1 }]);
      expect(
        (await connection.query("SELECT lane FROM pipeline_jobs")).rows,
      ).toEqual([{ lane: "legacy" }]);
      expect(
        (await connection.query("SELECT count(*) FROM feed_processing_state"))
          .rows[0],
      ).toEqual({ count: "0" });
    } finally {
      await connection.query("SET search_path TO public");
      await connection.query(
        "DROP SCHEMA IF EXISTS daily_feed_upgrade CASCADE",
      );
      await connection.end();
    }
  });
});
