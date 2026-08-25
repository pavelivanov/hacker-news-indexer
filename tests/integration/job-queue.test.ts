import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { pipelineJobId } from "@hn-knowledge/domain";
import {
  createDatabase,
  createJobQueue,
  JobLeaseError,
  type Database,
} from "@hn-knowledge/db";

const databaseUrl =
  process.env["DATABASE_URL"] ??
  "postgresql://hn_knowledge:hn_knowledge@127.0.0.1:5432/hn_knowledge";

const database: Database = createDatabase({ connectionString: databaseUrl });
const queue = createJobQueue(database.client);

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.client.pipelineJob.deleteMany();
});

const enqueue = async (key: string) =>
  queue.enqueue({
    type: "INGEST_SELECTION_RANGE",
    payload: { requestKey: key },
    idempotencyKey: key,
  });

describe("PostgreSQL job queue", () => {
  it("makes newly enqueued work immediately claimable at database precision", async () => {
    const precisionRows = await database.client.$queryRaw<
      { datetimePrecision: number | null }[]
    >`
      SELECT datetime_precision AS "datetimePrecision"
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'pipeline_jobs'
        AND column_name = 'available_at'
    `;
    expect(precisionRows).toEqual([{ datetimePrecision: 6 }]);

    for (let index = 0; index < 25; index += 1) {
      const enqueued = await enqueue(`immediate:${index}`);
      const claimed = await queue.claim({
        leaseOwner: "immediate-worker",
        leaseDurationMs: 30_000,
      });

      expect(claimed?.id).toBe(enqueued.id);
      await queue.complete(enqueued.id, "immediate-worker");
    }
  });

  it("lets concurrent claimers lease each job at most once", async () => {
    await Promise.all([enqueue("concurrent:1"), enqueue("concurrent:2")]);

    const [first, second] = await Promise.all([
      queue.claim({ leaseOwner: "worker-a", leaseDurationMs: 30_000 }),
      queue.claim({ leaseOwner: "worker-b", leaseDurationMs: 30_000 }),
    ]);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.id).not.toBe(second?.id);
    expect(new Set([first?.leaseOwner, second?.leaseOwner])).toEqual(
      new Set(["worker-a", "worker-b"]),
    );
    expect(
      await queue.claim({
        leaseOwner: "worker-c",
        leaseDurationMs: 30_000,
      }),
    ).toBeNull();
  });

  it("creates one row for a duplicate idempotency key", async () => {
    const [first, second] = await Promise.all([
      enqueue("same-logical-work"),
      enqueue("same-logical-work"),
    ]);

    expect(first.id).toBe(second.id);
    expect(await database.client.pipelineJob.count()).toBe(1);
  });

  it("recovers an expired lease without duplicating the job", async () => {
    const enqueued = await enqueue("recover-expired");
    const firstLease = await queue.claim({
      leaseOwner: "crashed-worker",
      leaseDurationMs: 30_000,
    });
    expect(firstLease?.id).toBe(enqueued.id);

    await database.client.pipelineJob.update({
      where: { id: enqueued.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });

    const recovered = await queue.claim({
      leaseOwner: "replacement-worker",
      leaseDurationMs: 30_000,
    });

    expect(recovered).toMatchObject({
      id: enqueued.id,
      state: "LEASED",
      attempts: 2,
      leaseOwner: "replacement-worker",
    });
    expect(await database.client.pipelineJob.count()).toBe(1);
  });

  it("renews only an active lease owned by the requesting worker", async () => {
    const enqueued = await enqueue("renew-owned-lease");
    const claimed = await queue.claim({
      leaseOwner: "worker-a",
      leaseDurationMs: 30_000,
    });
    if (claimed === null || claimed.leaseExpiresAt === null) {
      throw new Error("Expected leased job with an expiry");
    }

    await expect(
      queue.renew(enqueued.id, "worker-b", 60_000),
    ).rejects.toBeInstanceOf(JobLeaseError);
    await queue.renew(enqueued.id, "worker-a", 60_000);

    const renewed = await database.client.pipelineJob.findUniqueOrThrow({
      where: { id: enqueued.id },
    });
    expect(renewed.leaseExpiresAt?.getTime()).toBeGreaterThan(
      claimed.leaseExpiresAt.getTime(),
    );

    await queue.complete(enqueued.id, "worker-a");
    await expect(
      queue.renew(enqueued.id, "worker-a", 60_000),
    ).rejects.toBeInstanceOf(JobLeaseError);
  });

  it("makes retry and terminal transitions explicit and lease-owned", async () => {
    const enqueued = await enqueue("retry-terminal");
    await queue.claim({ leaseOwner: "worker-a", leaseDurationMs: 30_000 });

    await expect(
      queue.complete(pipelineJobId(enqueued.id), "worker-b"),
    ).rejects.toBeInstanceOf(JobLeaseError);

    await queue.retry(
      pipelineJobId(enqueued.id),
      "worker-a",
      "UPSTREAM_TIMEOUT",
      // Use a meaningful margin because Node and PostgreSQL do not share a
      // monotonic clock and may differ by more than one millisecond.
      new Date(Date.now() - 1_000),
    );
    const retried = await queue.claim({
      leaseOwner: "worker-b",
      leaseDurationMs: 30_000,
    });
    expect(retried).toMatchObject({
      id: enqueued.id,
      state: "LEASED",
      attempts: 2,
      leaseOwner: "worker-b",
      lastErrorCode: "UPSTREAM_TIMEOUT",
    });

    await queue.terminal(
      pipelineJobId(enqueued.id),
      "worker-b",
      "INVALID_PAYLOAD",
    );
    await expect(
      database.client.pipelineJob.findUniqueOrThrow({
        where: { id: enqueued.id },
      }),
    ).resolves.toMatchObject({
      state: "TERMINAL",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: "INVALID_PAYLOAD",
    });
  });
});
