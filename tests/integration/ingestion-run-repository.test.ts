import { createHash } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createStartIngestion } from "@hn-knowledge/application";
import {
  createDatabase,
  createIngestionRunRepository,
  type Database,
} from "@hn-knowledge/db";
import { telegramMessageId } from "@hn-knowledge/domain";

const databaseUrl =
  process.env["DATABASE_URL"] ??
  "postgresql://hn_knowledge:hn_knowledge@127.0.0.1:5432/hn_knowledge";

const database: Database = createDatabase({ connectionString: databaseUrl });
const startIngestion = createStartIngestion(
  createIngestionRunRepository(database.client),
  {
    sha256: (value) => createHash("sha256").update(value).digest("hex"),
  },
);

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.client.pipelineJob.deleteMany();
  await database.client.ingestionRun.deleteMany();
});

describe("ingestion run repository", () => {
  it("atomically creates one logical run and one job under concurrent replay", async () => {
    const input = {
      source: "TELEGRAM" as const,
      sourceKey: "hn_best_comments",
      minId: telegramMessageId(32_847),
      maxId: telegramMessageId(32_946),
    };

    const [first, second] = await Promise.all([
      startIngestion(input),
      startIngestion(input),
    ]);

    expect(first.run.id).toBe(second.run.id);
    expect(first.job.id).toBe(second.job.id);
    expect(new Set([first.created, second.created])).toEqual(
      new Set([true, false]),
    );
    expect(await database.client.ingestionRun.count()).toBe(1);
    expect(await database.client.pipelineJob.count()).toBe(1);
  });
});
