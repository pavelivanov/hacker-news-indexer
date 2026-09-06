import { beforeEach, afterAll, describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import {
  createDatabase,
  createClassifierResultsRepository,
} from "@hn-knowledge/db";
import { createClassifierResultsService } from "@hn-knowledge/application";
import { createApp } from "@hn-knowledge/api";
import {
  seedClassifierResult,
  resultHasher,
} from "../fixtures/manual-review/classifier-result.js";

const url = process.env["DATABASE_URL"];
if (
  !url ||
  new URL(url).pathname !== "/hn_manual_review_test" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)
)
  throw new Error("Requires isolated local test database");
const database = createDatabase({ connectionString: url });
const client = database.client;
const service = createClassifierResultsService(
  createClassifierResultsRepository(client),
  resultHasher,
  {
    actorId: "owner",
    cursorSecret: "test-only",
  },
);
const app = createApp({
  apiToken: "test-only",
  classifierResultsService: service,
});
const command = (
  bookmarked = true,
  expected_version = 0,
  command_key = "bookmark:1",
) => ({ bookmarked, expected_version, command_key });
beforeEach(async () => {
  await client.$executeRawUnsafe(
    'TRUNCATE TABLE "hn_items", "manual_review_drafts", "manual_review_receipts", "subjects", "classification_runs", "content_decisions", "review_tasks", "manual_override_events" CASCADE',
  );
});
afterAll(async () => database.close());

describe("result search and independent bookmarks", () => {
  it("filters before pagination and binds cursors to normalized query and view", async () => {
    for (let n = 0; n < 25; n += 1) {
      const { id } = await seedClassifierResult(client, 900001 + n);
      await client.classifierResultSnapshot.update({
        where: { runId: id },
        data: {
          title: n < 23 ? `Cache lesson ${n}` : "Other lesson",
          summary: "A useful explanation",
        },
      });
    }
    const first = await service.list("all", null, "  CACHE  ");
    expect(first.items).toHaveLength(20);
    const next = await service.list("all", first.next_cursor, "cache");
    expect(next.items).toHaveLength(3);
    expect(
      new Set([...first.items, ...next.items].map((item) => item.id)).size,
    ).toBe(23);
    await expect(
      service.list("all", first.next_cursor, "other"),
    ).rejects.toThrow("Invalid cursor");
    await expect(
      service.list("saved", first.next_cursor, "cache"),
    ).rejects.toThrow("Invalid cursor");
    expect((await service.list("all", null, "explanation")).items).toHaveLength(
      20,
    );
    const unicode = "界".repeat(200);
    await client.classifierResultSnapshot.updateMany({
      data: { title: unicode },
    });
    const long = await service.list("all", null, unicode);
    expect(
      (await service.list("all", long.next_cursor, unicode)).items,
    ).toHaveLength(5);
  });

  it("matches literal wildcard characters and the latest correction, not the original title", async () => {
    const { id } = await seedClassifierResult(client);
    await seedClassifierResult(client, 900002);
    await service.correct(id, {
      expected_version: 0,
      command_key: "correction:1",
      category: "EXPERT_NOTE",
      title: "100% fast_cache",
      summary: "Paths use C:\\data",
      issue: "INACCURATE_SUMMARY",
      explanation: "",
    });
    for (const query of ["%", "_", "\\", "FAST_CACHE", "c:\\data"])
      expect(
        (await service.list("all", null, query)).items.map((item) => item.id),
      ).toEqual([id]);
    expect(
      (await service.list("all", null, "Batching storage writes")).items,
    ).toHaveLength(1);
    expect(
      (await service.list("all", null, "absent phrase")).items,
    ).toHaveLength(0);
  });

  it("persists save/remove through the authenticated API without changing feedback or prediction", async () => {
    const { id } = await seedClassifierResult(client);
    const before = await service.get(id);
    const runs = await client.classificationRun.findMany();
    const save = await app.request(`/v1/classifier-results/${id}/bookmark`, {
      method: "PUT",
      headers: {
        authorization: "Bearer test-only",
        "content-type": "application/json",
      },
      body: JSON.stringify(command()),
    });
    expect(save.status).toBe(200);
    expect(await save.json()).toEqual({
      bookmarked: true,
      version: 1,
      replayed: false,
    });
    expect(
      (await service.list("saved", null, "batching")).items.map(
        (item) => item.id,
      ),
    ).toEqual([id]);
    expect((await service.list("saved", null, "absent")).items).toHaveLength(0);
    expect(await service.get(id)).toEqual({
      ...before,
      bookmarked: true,
      bookmark_version: 1,
    });
    await service.bookmark(id, command(false, 1, "bookmark:2"));
    expect((await service.list("saved")).items).toHaveLength(0);
    expect(await client.classificationRun.findMany()).toEqual(runs);
    expect(await client.classifierFeedback.count()).toBe(0);
    expect(await client.manualOverrideEvent.count()).toBe(0);
    expect(await client.reviewTask.count()).toBe(0);
  });

  it("recovers simultaneous exact retries and old receipts without reapplying them", async () => {
    const { id } = await seedClassifierResult(client);
    const responses = await Promise.all([
      service.bookmark(id, command()),
      service.bookmark(id, command()),
    ]);
    expect(responses.map((item) => item.version)).toEqual([1, 1]);
    expect(responses.filter((item) => item.replayed)).toHaveLength(1);
    await service.bookmark(id, command(false, 1, "bookmark:2"));
    expect(await service.bookmark(id, command())).toEqual({
      bookmarked: true,
      version: 1,
      replayed: true,
    });
    expect(await service.get(id)).toMatchObject({
      bookmarked: false,
      bookmark_version: 2,
    });
    expect(await client.resultBookmarkReceipt.count()).toBe(2);
    await expect(service.bookmark(id, command(false))).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    await expect(
      service.bookmark(id, command(true, 0, "stale")),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await expect(
      service.bookmark(
        "00000000-0000-4000-8000-000000000001",
        command(true, 0, "missing"),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("allows one conflicting concurrent command and keeps correction versions independent", async () => {
    const { id } = await seedClassifierResult(client);
    const outcomes = await Promise.allSettled([
      service.bookmark(id, command(true, 0, "first")),
      service.bookmark(id, command(false, 0, "second")),
      service.correct(id, {
        expected_version: 0,
        command_key: "feedback",
        category: "EXPERT_NOTE",
        title: "My title",
        summary: "My summary",
        issue: "INACCURATE_SUMMARY",
        explanation: "",
      }),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(
      2,
    );
    expect(outcomes.find((item) => item.status === "rejected")).toMatchObject({
      reason: { code: "VERSION_CONFLICT" },
    });
    expect(await service.get(id)).toMatchObject({
      bookmark_version: 1,
      feedback_version: 1,
      title: "My title",
    });
    expect(await client.resultBookmarkReceipt.count()).toBe(1);
  });

  it("upgrades existing snapshots and feedback with unsaved defaults and no data changes", async () => {
    const connection = new pg.Client({ connectionString: url });
    await connection.connect();
    try {
      await connection.query(
        "DROP SCHEMA IF EXISTS result_bookmarks_upgrade CASCADE",
      );
      await connection.query("CREATE SCHEMA result_bookmarks_upgrade");
      await connection.query("SET search_path TO result_bookmarks_upgrade");
      const directory = new URL(
        "../../packages/db/prisma/migrations/",
        import.meta.url,
      );
      for (const name of (await readdir(directory))
        .filter((name) => /^\d/.test(name) && name < "0011_result_bookmarks")
        .sort())
        await connection.query(
          await readFile(new URL(`${name}/migration.sql`, directory), "utf8"),
        );
      await connection.query(`INSERT INTO hn_items(id,type,availability,fetched_at,response_hash) VALUES(1,'comment','AVAILABLE',now(),'fixture');
        INSERT INTO selected_comments(id,root_id,canonical_html,canonical_text,content_hash,availability,last_seen_at) VALUES(1,1,'','source','fixture','AVAILABLE',now());
        INSERT INTO classification_runs(id,comment_id,input_hash,prompt_version,prompt_hash,schema_version,model_config_id,provider,model_id,output_hash,status)
        VALUES('00000000-0000-4000-8000-000000000001',1,'fixture','fixture','fixture','classification.v1','fixture','fixture','fixture','fixture','REVIEW');
        INSERT INTO classifier_result_snapshots(run_id,source_input,original_output,category,title,summary,feedback_version)
        VALUES('00000000-0000-4000-8000-000000000001','{"source":"unchanged"}','{"prediction":"unchanged"}','EXPERT_NOTE','Corrected title','Corrected summary',1);
        INSERT INTO classifier_feedback(id,result_id,version,command_key,request_hash,values,actor_id)
        VALUES('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001',1,'feedback','fixture','{"title":"Corrected title"}','owner');`);
      const snapshots = (
        await connection.query("SELECT * FROM classifier_result_snapshots")
      ).rows as Record<string, unknown>[];
      const feedback = (
        await connection.query("SELECT * FROM classifier_feedback")
      ).rows as unknown[];
      const runs = (await connection.query("SELECT * FROM classification_runs"))
        .rows as unknown[];
      await connection.query(
        await readFile(
          new URL("0011_result_bookmarks/migration.sql", directory),
          "utf8",
        ),
      );
      expect(
        (await connection.query("SELECT * FROM classifier_result_snapshots"))
          .rows,
      ).toEqual(
        snapshots.map((row) => ({
          ...row,
          bookmarked: false,
          bookmark_version: 0,
        })),
      );
      expect(
        (await connection.query("SELECT * FROM classifier_feedback")).rows,
      ).toEqual(feedback);
      expect(
        (await connection.query("SELECT * FROM classification_runs")).rows,
      ).toEqual(runs);
      expect(
        (await connection.query("SELECT * FROM result_bookmark_receipts")).rows,
      ).toHaveLength(0);
    } finally {
      await connection.query("SET search_path TO public");
      await connection.query(
        "DROP SCHEMA IF EXISTS result_bookmarks_upgrade CASCADE",
      );
      await connection.end();
    }
  });
});
