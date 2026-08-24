import { createHash } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  createIngestSelectionRange,
  createResolveSelectedComment,
  createStartIngestion,
  HnParentChainResolver,
} from "@hn-knowledge/application";
import {
  createDatabase,
  createHnResolutionRepository,
  createIngestionRunRepository,
  createJobQueue,
  createOccurrenceRepository,
  type Database,
} from "@hn-knowledge/db";
import {
  hnItemId,
  telegramMessageId,
  type HnFetchResult,
  type HnItem,
  type HnItemId,
  type IngestionRange,
  type SelectionOccurrenceInput,
} from "@hn-knowledge/domain";
import type { HnItems, SelectionSource } from "@hn-knowledge/ports";

const databaseUrl =
  process.env["DATABASE_URL"] ??
  "postgresql://hn_knowledge:hn_knowledge@127.0.0.1:5432/hn_knowledge";
const database: Database = createDatabase({ connectionString: databaseUrl });
const hasher = {
  sha256: (value: string) => createHash("sha256").update(value).digest("hex"),
};
const now = new Date("2026-08-24T12:00:00.000Z");
const clock = { now: () => now };
const runs = createIngestionRunRepository(database.client);
const occurrences = createOccurrenceRepository(database.client);
const resolutions = createHnResolutionRepository(database.client);
const queue = createJobQueue(database.client);

const cleanDatabase = async (): Promise<void> => {
  await database.client.multipartPart.deleteMany();
  await database.client.multipartGroup.deleteMany();
  await database.client.resolutionPath.deleteMany();
  await database.client.selectedComment.deleteMany();
  await database.client.urlCandidate.deleteMany();
  await database.client.hnItem.deleteMany();
  await database.client.hnReference.deleteMany();
  await database.client.telegramMessage.deleteMany();
  await database.client.ingestionRunOccurrence.deleteMany();
  await database.client.pipelineJob.deleteMany();
  await database.client.selectionOccurrence.deleteMany();
  await database.client.ingestionRun.deleteMany();
};

beforeEach(cleanDatabase);
afterAll(async () => database.close());

const range: IngestionRange = {
  source: "FIXTURE",
  sourceKey: "integration-fixture",
  minId: telegramMessageId(1),
  maxId: telegramMessageId(1),
};

const occurrence: SelectionOccurrenceInput = {
  source: "FIXTURE",
  sourceKey: "integration-fixture",
  externalId: telegramMessageId(1),
  occurredAt: now,
  editedAt: null,
  text: "Re: fixture\n\nHello\n\nuser, now",
  contentHash: hasher.sha256("Re: fixture\n\nHello\n\nuser, now"),
  entities: [],
  references: [
    {
      itemId: hnItemId(100),
      role: "DISPLAYED_STORY_REFERENCE",
      entityOffset: 0,
      entityLength: 1,
      parseConfidence: 1,
    },
    {
      itemId: hnItemId(200),
      role: "SELECTED_COMMENT",
      entityOffset: 1,
      entityLength: 1,
      parseConfidence: 0.9,
    },
  ],
  multipart: null,
  status: "OBSERVED",
};

const source: SelectionSource = {
  async *readRange() {
    yield occurrence;
  },
};

const hnItem = (
  id: number,
  type: HnItem["type"],
  parentId: number | null,
): HnItem => ({
  id: hnItemId(id),
  type,
  parentId: parentId === null ? null : hnItemId(parentId),
  author: "fixture",
  time: now,
  title: type === "story" ? "Fixture" : null,
  textHtml: type === "comment" ? "<p>Hello</p>" : null,
  url: null,
  availability: "AVAILABLE",
  fetchedAt: now,
  responseHash: `hash-${id}`,
});

const hnSource = (): HnItems => {
  const values = new Map([
    [100, hnItem(100, "story", null)],
    [200, hnItem(200, "comment", 100)],
  ]);
  return {
    async get(id: HnItemId): Promise<HnFetchResult> {
      const item = values.get(Number(id));
      return item === undefined
        ? { kind: "MISSING", id, fetchedAt: now, responseHash: "missing" }
        : { kind: "ITEM", item };
    },
  };
};

const startRun = async () =>
  createStartIngestion(
    runs,
    hasher,
  )({
    source: range.source,
    sourceKey: range.sourceKey,
    minId: range.minId,
    maxId: range.maxId,
  });

const prepareResolveJob = async () => {
  const started = await startRun();
  const ingestJob = await queue.claim({
    leaseOwner: "ingest-worker",
    leaseDurationMs: 30_000,
    ingestionRunId: started.run.id,
  });
  if (ingestJob === null) {
    const rows = await database.client.pipelineJob.findMany({
      select: { id: true, ingestionRunId: true, state: true },
    });
    throw new Error(
      `Expected ingestion job for ${started.run.id}; created=${started.created}; jobs=${JSON.stringify(rows)}`,
    );
  }
  await createIngestSelectionRange(
    source,
    runs,
    occurrences,
    queue,
  )({
    runId: started.run.id,
    range,
  });
  await expect(
    queue.claim({
      leaseOwner: "premature-resolve-worker",
      leaseDurationMs: 30_000,
      ingestionRunId: started.run.id,
    }),
  ).resolves.toBeNull();
  await queue.complete(ingestJob.id, "ingest-worker");
  await runs.reconcile(started.run.id);
  const resolveJob = await queue.claim({
    leaseOwner: "resolve-worker",
    leaseDurationMs: 30_000,
    ingestionRunId: started.run.id,
  });
  if (resolveJob === null) {
    throw new Error("Expected resolution job");
  }
  return { started, resolveJob };
};

describe("ingestion pipeline", () => {
  it("resolves successfully, applies retention, and deduplicates replay", async () => {
    const { started, resolveJob } = await prepareResolveJob();
    await createResolveSelectedComment(
      new HnParentChainResolver(hnSource()),
      occurrences,
      resolutions,
      clock,
      hasher,
    )({ runId: started.run.id, selectedCommentId: hnItemId(200) });
    await queue.complete(resolveJob.id, "resolve-worker");
    const completed = await runs.reconcile(started.run.id);
    const replay = await startRun();

    expect(completed.status).toBe("COMPLETED");
    expect(replay).toMatchObject({ created: false });
    expect(replay.run.id).toBe(started.run.id);
    expect(await database.client.pipelineJob.count()).toBe(2);
    expect(await database.client.selectedComment.count()).toBe(1);
    await expect(
      database.client.telegramMessage.findFirstOrThrow(),
    ).resolves.toMatchObject({ bodySnapshot: null });
  });

  it("keeps a run active while a resolution is retryable", async () => {
    const { started, resolveJob } = await prepareResolveJob();
    await queue.retry(
      resolveJob.id,
      "resolve-worker",
      "HN_RETRY_EXHAUSTED",
      new Date(Date.now() + 60_000),
    );

    const run = await runs.reconcile(started.run.id);

    expect(run.status).toBe("RUNNING");
    await expect(
      database.client.pipelineJob.findUniqueOrThrow({
        where: { id: resolveJob.id },
      }),
    ).resolves.toMatchObject({ state: "RETRYABLE" });
  });

  it("recovers the same job after a process dies with an expired lease", async () => {
    const started = await startRun();
    const abandoned = await queue.claim({
      leaseOwner: "dead-worker",
      leaseDurationMs: 30_000,
      ingestionRunId: started.run.id,
    });
    if (abandoned === null) {
      throw new Error("Expected leased job");
    }
    await database.client.pipelineJob.update({
      where: { id: abandoned.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });

    const recovered = await queue.claim({
      leaseOwner: "replacement-worker",
      leaseDurationMs: 30_000,
      ingestionRunId: started.run.id,
    });

    expect(recovered).toMatchObject({
      id: abandoned.id,
      attempts: 2,
      leaseOwner: "replacement-worker",
    });
    expect(await database.client.pipelineJob.count()).toBe(1);
  });

  it("marks a run failed when its source is terminally unavailable", async () => {
    const started = await startRun();
    const job = await queue.claim({
      leaseOwner: "worker",
      leaseDurationMs: 30_000,
      ingestionRunId: started.run.id,
    });
    if (job === null) {
      throw new Error("Expected ingestion job");
    }
    await queue.terminal(job.id, "worker", "SOURCE_MISSING");

    const run = await runs.reconcile(started.run.id);

    expect(run.status).toBe("FAILED");
  });
});
