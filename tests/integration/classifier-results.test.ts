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
const repository = createClassifierResultsRepository(client);
const service = createClassifierResultsService(repository, resultHasher, {
  actorId: "owner",
  cursorSecret: "test-only",
});
const app = createApp({
  apiToken: "test-only",
  classifierResultsService: service,
});
const correction = (version = 0, key = "feedback:1") => ({
  expected_version: version,
  command_key: key,
  category: "REJECTED",
  title: "Not useful to me",
  summary: "",
  issue: "NOT_USEFUL",
  explanation: "I already know this.",
});
beforeEach(async () => {
  await client.$executeRawUnsafe(
    'TRUNCATE TABLE "hn_items", "manual_review_drafts", "manual_review_receipts", "subjects", "classification_runs", "content_decisions", "review_tasks", "manual_override_events" CASCADE',
  );
});
afterAll(async () => database.close());

describe("private classifier results and feedback", () => {
  it("upgrades existing source and model rows without changing them", async () => {
    const connection = new pg.Client({ connectionString: url });
    await connection.connect();
    try {
      await connection.query(
        "DROP SCHEMA IF EXISTS classifier_feedback_upgrade CASCADE",
      );
      await connection.query("CREATE SCHEMA classifier_feedback_upgrade");
      await connection.query("SET search_path TO classifier_feedback_upgrade");
      const directory = new URL(
        "../../packages/db/prisma/migrations/",
        import.meta.url,
      );
      for (const name of (await readdir(directory))
        .filter((name) => /^\d/.test(name) && name < "0009_classifier_feedback")
        .sort())
        await connection.query(
          await readFile(new URL(`${name}/migration.sql`, directory), "utf8"),
        );
      await connection.query(`INSERT INTO hn_items(id,type,availability,fetched_at,response_hash) VALUES(1,'comment','AVAILABLE',now(),'fixture');
        INSERT INTO selected_comments(id,root_id,canonical_html,canonical_text,content_hash,availability,last_seen_at) VALUES(1,1,'','source','fixture','AVAILABLE',now());
        INSERT INTO classification_runs(id,comment_id,input_hash,prompt_version,prompt_hash,schema_version,model_config_id,provider,model_id,output_hash,status)
        VALUES('00000000-0000-4000-8000-000000000001',1,'fixture','fixture','fixture','classification.v1','fixture','fixture','fixture','fixture','REVIEW');`);
      const before = await connection.query(
        "SELECT * FROM classification_runs",
      );
      await connection.query(
        await readFile(
          new URL("0009_classifier_feedback/migration.sql", directory),
          "utf8",
        ),
      );
      expect(
        (await connection.query("SELECT * FROM classification_runs")).rows,
      ).toEqual(before.rows);
      expect(
        (await connection.query("SELECT * FROM classifier_result_snapshots"))
          .rows,
      ).toHaveLength(0);
      expect(
        (await connection.query("SELECT * FROM classifier_feedback")).rows,
      ).toHaveLength(0);
    } finally {
      await connection.query("SET search_path TO public");
      await connection.query(
        "DROP SCHEMA IF EXISTS classifier_feedback_upgrade CASCADE",
      );
      await connection.end();
    }
  });
  it("shows a real classifier result with no approval and persists correction separately", async () => {
    const fixture = await seedClassifierResult(client);
    expect(fixture.calls).toBe(1);
    const response = await app.request(
      "/v1/classifier-results?filter=expert_note",
      { headers: { authorization: "Bearer test-only" } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [{ id: fixture.id, category: "EXPERT_NOTE" }],
    });
    expect((await service.get(fixture.id)).original).toEqual(fixture.output);
    await service.correct(fixture.id, correction());
    const detail = await service.get(fixture.id);
    expect(detail).toMatchObject({
      category: "REJECTED",
      feedback_version: 1,
      feedback: [{ actor: "owner", issue: "NOT_USEFUL" }],
    });
    expect(detail.original).toEqual(fixture.output);
    expect((await service.list("expert_note")).items).toHaveLength(0);
    expect((await service.list("skipped")).items).toHaveLength(1);
    expect((await service.list("corrected")).items).toHaveLength(1);
    expect(await client.reviewTask.count()).toBe(0);
    expect(await client.manualOverrideEvent.count()).toBe(0);
    expect(await client.discoverySource.count()).toBe(0);
    expect(await client.expertNote.count()).toBe(0);
    expect(
      (
        await client.selectedComment.findUniqueOrThrow({
          where: { id: 900001n },
        })
      ).activeDecisionId,
    ).toBeNull();
    expect((await client.contentDecision.findFirstOrThrow()).source).toBe(
      "MODEL",
    );
  });
  it("keeps exact retries idempotent, records versions, and rejects changed commands", async () => {
    const { id } = await seedClassifierResult(client);
    expect(await service.correct(id, correction())).toEqual({
      version: 1,
      replayed: false,
    });
    expect(await service.correct(id, correction())).toEqual({
      version: 1,
      replayed: true,
    });
    await expect(
      service.correct(id, { ...correction(), explanation: "Different body" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await service.correct(id, {
      ...correction(1, "feedback:2"),
      explanation: "Another explanation",
    });
    expect(
      (await service.get(id)).feedback.map((item) => item.version),
    ).toEqual([2, 1]);
    await expect(
      client.classifierFeedback.updateMany({ data: { actorId: "rewritten" } }),
    ).rejects.toThrow();
  });
  it("allows one concurrent correction while preserving the losing revision", async () => {
    const { id } = await seedClassifierResult(client);
    const outcomes = await Promise.allSettled([
      service.correct(id, correction(0, "first")),
      service.correct(id, correction(0, "second")),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(
      1,
    );
    expect(await client.classifierFeedback.count()).toBe(1);
    expect((await service.get(id)).feedback_version).toBe(1);
  });
  it("returns one receipt for simultaneous exact retries", async () => {
    const { id } = await seedClassifierResult(client);
    const result = await Promise.all([
      service.correct(id, correction()),
      service.correct(id, correction()),
    ]);
    expect(result.map((item) => item.version)).toEqual([1, 1]);
    expect(await client.classifierFeedback.count()).toBe(1);
  });
  it("keeps the prediction snapshot after source changes and prevents snapshot rewriting", async () => {
    const fixture = await seedClassifierResult(client);
    await client.selectedComment.update({
      where: { id: 900001n },
      data: { canonicalText: "Changed text" },
    });
    expect((await service.get(fixture.id)).source).toEqual(fixture.source);
    await expect(
      client.classifierResultSnapshot.update({
        where: { runId: fixture.id },
        data: { sourceInput: {} },
      }),
    ).rejects.toThrow();
  });
  it("pages after filtering, signs cursor context, and covers the complete set", async () => {
    for (let n = 0; n < 23; n += 1)
      await seedClassifierResult(
        client,
        900001 + n,
        n === 0 ? "REJECTED" : "EXPERT_NOTE",
      );
    const first = await service.list("expert_note");
    expect(first.items).toHaveLength(20);
    const next = await service.list("expert_note", first.next_cursor);
    expect(next.items).toHaveLength(2);
    expect(
      new Set([...first.items, ...next.items].map((item) => item.id)).size,
    ).toBe(22);
    await expect(service.list("all", first.next_cursor)).rejects.toThrow();
    await expect(
      service.list("expert_note", `${first.next_cursor}x`),
    ).rejects.toThrow();
  });
});
