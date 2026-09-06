import { beforeEach, afterAll, describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import {
  createDatabase,
  createFeedProcessingRepository,
} from "@hn-knowledge/db";
import { createFeedProcessingService } from "@hn-knowledge/application";
import { pipelineJobId } from "@hn-knowledge/domain";
import { createApp } from "@hn-knowledge/api";
import { dailyFeedFixture } from "../fixtures/manual-review/daily-feed.js";
import { seedClassifierResult } from "../fixtures/manual-review/classifier-result.js";

const url = process.env["DATABASE_URL"];
if (
  !url ||
  new URL(url).pathname !== "/hn_manual_review_test" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)
)
  throw new Error("Requires isolated local test database");
const database = createDatabase({ connectionString: url });
const client = database.client;
const processing = createFeedProcessingRepository(client);
const service = createFeedProcessingService(processing);
const app = createApp({
  apiToken: "test-only",
  feedProcessingService: service,
});
const command = (
  version = 0,
  key = "settings:1",
  minutes = 15,
  limit = 50,
) => ({
  expected_version: version,
  command_key: key,
  interval_minutes: minutes,
  daily_request_limit: limit,
});
const save = (value = command()) => service.saveSettings(value);
beforeEach(async () => {
  await client.$executeRawUnsafe(
    'TRUNCATE "hn_items", "classification_runs", "content_decisions", "subjects", "review_tasks", "manual_override_events", "ingestion_runs", "selection_occurrences", "pipeline_jobs", "feed_processing_state", "feed_request_usage", "feed_command_receipts" CASCADE',
  );
});
afterAll(async () => database.close());

describe("browser feed settings", () => {
  it("persists validated settings, reschedules only a changed interval, and preserves user data and pause state", async () => {
    await processing.initialize("fixture-channel");
    const fixture = await seedClassifierResult(client);
    const original = await client.classifierResultSnapshot.findUniqueOrThrow({
      where: { runId: fixture.id },
    });
    await client.feedProcessingState.update({
      where: { id: "local" },
      data: { enabled: false, syncRequested: true, cursor: 123n },
    });
    const before = Date.now();
    const response = await app.request("/v1/processing/settings", {
      method: "PUT",
      headers: {
        authorization: "Bearer test-only",
        "content-type": "application/json",
      },
      body: JSON.stringify(command()),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      settings_version: 1,
      replayed: false,
    });
    const state = await client.feedProcessingState.findUniqueOrThrow({
      where: { id: "local" },
    });
    expect(state).toMatchObject({
      intervalSeconds: 900,
      dailyRequestLimit: 50,
      settingsVersion: 1,
      enabled: false,
      syncRequested: true,
      cursor: 123n,
      batchSize: 20,
      sourceKey: "fixture-channel",
    });
    expect(state.nextSyncAt.getTime()).toBeGreaterThanOrEqual(before + 900000);
    expect(state.nextSyncAt.getTime()).toBeLessThanOrEqual(Date.now() + 900000);
    await save(command(1, "settings:2", 15, 60));
    expect((await processing.state())?.nextSyncAt).toEqual(state.nextSyncAt);
    expect(
      await client.classifierResultSnapshot.findUniqueOrThrow({
        where: { runId: fixture.id },
      }),
    ).toEqual(original);
    expect(await client.classifierFeedback.count()).toBe(0);
    expect(await client.manualOverrideEvent.count()).toBe(0);
  });

  it("keeps exact retries idempotent and refuses stale/conflicting commands", async () => {
    await expect(save()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await processing.initialize("fixture-channel");
    const replies = await Promise.all([save(), save()]);
    expect(replies.map((item) => item.settings_version)).toEqual([1, 1]);
    expect(replies.filter((item) => item.replayed)).toHaveLength(1);
    await save(command(1, "settings:2", 60, 20));
    const beforeReplay = await processing.state();
    expect(await save()).toEqual({ settings_version: 1, replayed: true });
    expect(await processing.state()).toEqual(beforeReplay);
    expect(await client.feedCommandReceipt.count()).toBe(2);
    await expect(save(command(0, "settings:1", 60))).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    await expect(save(command(0, "stale"))).rejects.toMatchObject({
      code: "STATE_CONFLICT",
    });
    await expect(
      processing.retry(
        "job",
        "11111111-1111-4111-8111-111111111111",
        "settings:1",
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it.each([false, true])(
    "reschedules a failed source check only if settings have not changed: %s",
    async (changed) => {
      const fixture = await dailyFeedFixture(database);
      let saved = await processing.state();
      fixture.state.onLatest = async () => {
        if (changed) {
          await save(command(0, "during-source-check", 60, 100));
          saved = await processing.state();
        }
        throw new Error("fixture-source-offline");
      };
      const before = Date.now();
      expect(await fixture.runtime.tick()).toBe("idle");
      const after = await processing.state();
      if (changed) expect(after).toEqual(saved);
      else {
        expect(after).toMatchObject({
          errorCode: "SOURCE_CONNECTION_FAILED",
          syncRequested: false,
          settingsVersion: 0,
        });
        expect(after?.nextSyncAt.getTime()).toBeGreaterThanOrEqual(
          before + 60000,
        );
        expect(after?.nextSyncAt.getTime()).toBeLessThanOrEqual(
          Date.now() + 60000,
        );
      }
      expect(await client.ingestionRun.count()).toBe(0);
    },
  );

  it("allows one concurrent settings edit", async () => {
    await processing.initialize("fixture-channel");
    const responses = await Promise.allSettled([
      save(),
      save(command(0, "other", 60, 20)),
    ]);
    expect(
      responses.filter((item) => item.status === "fulfilled"),
    ).toHaveLength(1);
    expect(responses.find((item) => item.status === "rejected")).toMatchObject({
      reason: { code: "STATE_CONFLICT" },
    });
    expect((await processing.status()).settings_version).toBe(1);
  });

  it("applies a lower cap before a provider validation retry without resetting usage", async () => {
    const fixture = await dailyFeedFixture(database);
    fixture.state.invalidOutput = true;
    const classify = fixture.classifier.classify;
    fixture.classifier.classify = async (request) => {
      const result = await classify(request);
      if (fixture.state.calls === 1) await save(command(0, "lower", 30, 1));
      return result;
    };
    await fixture.drain();
    expect(fixture.state.calls).toBe(1);
    expect(await processing.status()).toMatchObject({
      requests_today: 1,
      daily_request_limit: 1,
      pending: 2,
      failed: 0,
    });
    expect(await processing.reserveRequest()).toBe(false);
  });

  it("releases budget-blocked jobs after a higher cap without restarting or resuming a paused worker", async () => {
    const fixture = await dailyFeedFixture(database);
    await save(command(0, "small", 30, 1));
    await fixture.drain();
    expect(fixture.state.calls).toBe(1);
    await processing.control("pause");
    await save(command(1, "raise", 30, 2));
    await fixture.drain();
    expect(fixture.state.calls).toBe(1);
    expect(await processing.status()).toMatchObject({
      requests_today: 1,
      enabled: false,
    });
    await processing.control("resume");
    await fixture.drain();
    expect(fixture.state.calls).toBe(2);
    expect(await processing.status()).toMatchObject({
      requests_today: 2,
      pending: 0,
      failed: 0,
    });
  });

  it.each(["save-first", "defer-first", "concurrent"])(
    "does not strand work when a cap increase races deferral: %s",
    async (order) => {
      await processing.initialize("fixture-channel");
      await save(command(0, "small", 30, 1));
      expect(await processing.reserveRequest()).toBe(true);
      const job = await client.pipelineJob.create({
        data: {
          lane: "feed",
          type: "CLASSIFY_COMMENT",
          payload: {},
          idempotencyKey: "budget-job",
          state: "LEASED",
          attempts: 1,
          leaseOwner: "fixture",
          leaseExpiresAt: new Date(Date.now() + 60000),
        },
      });
      const raise = () => save(command(1, "raise", 30, 2));
      const defer = () =>
        processing.deferForBudget(pipelineJobId(job.id), "fixture");
      if (order === "save-first") {
        await raise();
        await defer();
      } else if (order === "defer-first") {
        await defer();
        await raise();
      } else await Promise.all([raise(), defer()]);
      const updated = await client.pipelineJob.findUniqueOrThrow({
        where: { id: job.id },
      });
      expect(updated).toMatchObject({
        state: "RETRYABLE",
        attempts: 0,
        leaseOwner: null,
      });
      expect(updated.availableAt.getTime()).toBeLessThanOrEqual(Date.now());
      expect((await processing.status()).requests_today).toBe(1);
    },
  );

  it("upgrades a non-default configuration without changing settings, usage, or receipts", async () => {
    const connection = new pg.Client({ connectionString: url });
    await connection.connect();
    try {
      await connection.query(
        "DROP SCHEMA IF EXISTS feed_settings_upgrade CASCADE",
      );
      await connection.query("CREATE SCHEMA feed_settings_upgrade");
      await connection.query("SET search_path TO feed_settings_upgrade");
      const directory = new URL(
        "../../packages/db/prisma/migrations/",
        import.meta.url,
      );
      for (const name of (await readdir(directory))
        .filter((name) => /^\d/.test(name) && name < "0012_feed_settings")
        .sort())
        await connection.query(
          await readFile(new URL(`${name}/migration.sql`, directory), "utf8"),
        );
      await connection.query(`INSERT INTO feed_processing_state(id,source_key,enabled,cursor,sync_requested,interval_seconds,daily_request_limit,batch_size) VALUES('local','fixture',false,123,false,1020,55,7);
        INSERT INTO feed_request_usage(day,requests) VALUES(CURRENT_DATE,12);
        INSERT INTO feed_command_receipts(command_key,request_hash,result) VALUES('existing','fixture','{"job_id":"unchanged"}');`);
      const state = (
        await connection.query("SELECT * FROM feed_processing_state")
      ).rows as Record<string, unknown>[];
      const usage = (await connection.query("SELECT * FROM feed_request_usage"))
        .rows as unknown[];
      const receipts = (
        await connection.query("SELECT * FROM feed_command_receipts")
      ).rows as unknown[];
      await connection.query(
        await readFile(
          new URL("0012_feed_settings/migration.sql", directory),
          "utf8",
        ),
      );
      expect(
        (await connection.query("SELECT * FROM feed_processing_state")).rows,
      ).toEqual(state.map((row) => ({ ...row, settings_version: 0 })));
      expect(
        (await connection.query("SELECT * FROM feed_request_usage")).rows,
      ).toEqual(usage);
      expect(
        (await connection.query("SELECT * FROM feed_command_receipts")).rows,
      ).toEqual(receipts);
    } finally {
      await connection.query("SET search_path TO public");
      await connection.query(
        "DROP SCHEMA IF EXISTS feed_settings_upgrade CASCADE",
      );
      await connection.end();
    }
  });
});
