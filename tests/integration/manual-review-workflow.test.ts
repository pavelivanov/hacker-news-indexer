import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "@hn-knowledge/api";
import {
  createManualReviewService,
  createKnowledgeReader,
  normalizeHnCommentHtml,
  createReviewService,
} from "@hn-knowledge/application";
import {
  createDatabase,
  createManualReviewUnitOfWork,
  createKnowledgeReaderRepository,
  createReviewRepository,
  createClassificationRepository,
} from "@hn-knowledge/db";
import { hnItemId, reviewTaskId } from "@hn-knowledge/domain";
import type { ManualReviewUnitOfWork } from "@hn-knowledge/ports";
import { manualOutput } from "../fixtures/manual-review/output.js";

const url = process.env["DATABASE_URL"];
if (
  !url ||
  new URL(url).pathname !== "/hn_manual_review_test" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)
) {
  throw new Error(
    "Manual review tests require the disposable local hn_manual_review_test database",
  );
}
const database = createDatabase({ connectionString: url });
const client = database.client;
const hasher = {
  sha256: (value: string) => createHash("sha256").update(value).digest("hex"),
};
const work = createManualReviewUnitOfWork(client);
const service = createManualReviewService(work, hasher, {
  actorId: "owner",
  cursorSecret: "test-secret",
});
const reader = createKnowledgeReader(
  createKnowledgeReaderRepository(
    client,
    (html, id) => normalizeHnCommentHtml(html, id, hasher).canonicalText,
  ),
  { cursorSecret: "test-secret" },
);
const now = new Date("2026-09-05T00:00:00.000Z");
const commentId = 900_001;
const rootId = 900_000;
const token = "manual-test-token";
const app = createApp({
  apiToken: token,
  manualReviewService: service,
  knowledgeReader: reader,
});

const seedSource = async (id = commentId) => {
  const html = "<p>WidgetDB batches writes to reduce disk synchronization.</p>";
  const normalized = normalizeHnCommentHtml(html, `hn:item:${id}`, hasher);
  await client.hnItem.create({
    data: {
      id: BigInt(id),
      type: "comment",
      parentId: BigInt(rootId),
      textHtml: html,
      textPlain: normalized.canonicalText,
      fetchedAt: now,
      responseHash: hasher.sha256(html),
      availability: "AVAILABLE",
    },
  });
  await client.selectedComment.create({
    data: {
      id: BigInt(id),
      rootId: BigInt(rootId),
      canonicalHtml: normalized.canonicalHtml,
      canonicalText: normalized.canonicalText,
      contentHash: normalized.contentHash,
      availability: "AVAILABLE",
      firstSeenAt: now,
      lastSeenAt: now,
      resolutionPath: {
        create: {
          ancestorIds: [BigInt(rootId)],
          displayedStoryId: BigInt(rootId),
          resolvedRootId: BigInt(rootId),
          resolverVersion: "manual-fixture.v1",
          resolvedAt: now,
        },
      },
    },
  });
};
beforeEach(async () => {
  await client.$executeRawUnsafe(
    'TRUNCATE TABLE "hn_items", "manual_review_drafts", "manual_review_receipts", "subjects", "classification_runs", "content_decisions", "review_tasks", "manual_override_events" CASCADE',
  );
  await client.hnItem.create({
    data: {
      id: BigInt(rootId),
      type: "story",
      title: "WidgetDB internals",
      textHtml: "<p>WidgetDB uses a write-ahead log.</p>",
      textPlain: null,
      url: "https://widgetdb.example/",
      availability: "AVAILABLE",
      fetchedAt: now,
      responseHash: hasher.sha256("root"),
    },
  });
  await seedSource();
});
afterAll(async () => {
  await database.close();
});

const prepare = async (
  kind: Parameters<typeof manualOutput>[1] = "DISCOVERY",
  rootBody = false,
) => {
  const source = await service.getComment(commentId);
  if (!source.source) throw new Error("Source unavailable");
  const draft = await service.create(commentId);
  return service.save(draft.id, {
    expected_version: draft.version,
    source_hash: draft.source_hash,
    payload: manualOutput(source.source, kind, rootBody),
  });
};
const command = (
  draft: Awaited<ReturnType<typeof prepare>>,
  key = "approve:1",
) => ({
  expected_version: draft.version,
  source_hash: draft.source_hash,
  command_key: key,
  reason: "Checked against source evidence",
});
const counts = async () => ({
  decisions: await client.contentDecision.count(),
  discoveries: await client.discovery.count(),
  notes: await client.expertNote.count(),
  events: await client.manualOverrideEvent.count(),
  runs: await client.classificationRun.count(),
});

describe("manual draft to approved feed", () => {
  it("keeps unresolved evidence warnings in drafts rather than silently discarding them", async () => {
    const draft = await prepare();
    const saved = await service.save(draft.id, {
      expected_version: draft.version,
      source_hash: draft.source_hash,
      payload: {
        ...draft.payload,
        review: { required: true, reasons: ["INVALID_EVIDENCE_SPAN"] },
      },
    });
    await expect(
      service.finalize(draft.id, "APPROVED", command(saved)),
    ).rejects.toMatchObject({ code: "OUTPUT_INVALID" });
    expect((await counts()).decisions).toBe(0);
  });
  it("creates one draft under concurrent create requests and rejects stale concurrent saves", async () => {
    const [a, b] = await Promise.all([
      service.create(commentId),
      service.create(commentId),
    ]);
    expect(a.id).toBe(b.id);
    const saves = await Promise.allSettled(
      ["first", "second"].map((title) =>
        service.save(a.id, {
          expected_version: 1,
          source_hash: a.source_hash,
          payload: { expert_note: { title } },
        }),
      ),
    );
    expect(
      saves.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(await client.manualReviewDraft.count()).toBe(1);
  });
  it("persists incomplete drafts without decisions, tasks, or feed publication", async () => {
    const draft = await service.create(commentId);
    const saved = await service.save(draft.id, {
      expected_version: 1,
      source_hash: draft.source_hash,
      payload: { expert_note: { title: "Unfinished" } },
    });
    expect((await service.getComment(commentId)).draft).toEqual(saved);
    expect(await service.create(commentId)).toEqual(saved);
    expect(
      (await reader.getFeed({ kind: "discovery", cursor: null })).items,
    ).toEqual([]);
    expect(
      (await reader.getFeed({ kind: "expert_note", cursor: null })).items,
    ).toEqual([]);
    await expect(
      service.finalize(saved.id, "APPROVED", command(saved)),
    ).rejects.toMatchObject({ code: "OUTPUT_INVALID" });
    expect(await counts()).toEqual({
      decisions: 0,
      discoveries: 0,
      notes: 0,
      events: 0,
      runs: 0,
    });
  });
  it.each(["DISCOVERY", "EXPERT_NOTE", "BOTH", "REJECTED"] as const)(
    "finalizes %s from zero model runs through the real API",
    async (kind) => {
      const draft = await prepare(kind);
      const action = kind === "REJECTED" ? "reject" : "approve";
      const response = await app.request(
        `/v1/manual-review/drafts/${draft.id}/${action}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(command(draft)),
        },
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const decision = await client.contentDecision.findFirstOrThrow({
        include: { evidenceSpans: true },
      });
      expect(decision).toMatchObject({
        source: "MANUAL",
        classificationRunId: null,
        manualOverrideOfId: null,
        manualDraftId: draft.id,
        reviewRequired: true,
      });
      expect(decision.evidenceSpans.length).toBeGreaterThan(0);
      expect(
        (
          await client.selectedComment.findUniqueOrThrow({
            where: { id: BigInt(commentId) },
          })
        ).activeDecisionId,
      ).toBe(decision.id);
      expect(
        await client.manualOverrideEvent.count({
          where: { action: "APPROVED", newDecisionId: decision.id },
        }),
      ).toBe(1);
      expect(await client.classificationRun.count()).toBe(0);
      const discoveries = await reader.getFeed({
        kind: "discovery",
        cursor: null,
      });
      const notes = await reader.getFeed({ kind: "expert_note", cursor: null });
      expect(
        discoveries.items.length +
          discoveries.story_clusters.flatMap((cluster) => cluster.items).length,
      ).toBe(kind === "DISCOVERY" || kind === "BOTH" ? 1 : 0);
      expect(
        notes.items.length +
          notes.story_clusters.flatMap((cluster) => cluster.items).length,
      ).toBe(kind === "EXPERT_NOTE" || kind === "BOTH" ? 1 : 0);
      const again = await service.create(commentId);
      expect(again.state).toBe(kind === "REJECTED" ? "REJECTED" : "APPROVED");
      await expect(
        service.save(draft.id, {
          expected_version: again.version,
          source_hash: again.source_hash,
          payload: {},
        }),
      ).rejects.toMatchObject({ code: "STATE_CONFLICT" });
    },
  );
  it.each([null, "stale unrelated text"])(
    "publishes root-body evidence even with cached text %s",
    async (textPlain) => {
      await client.hnItem.update({
        where: { id: BigInt(rootId) },
        data: { textPlain },
      });
      const draft = await prepare("DISCOVERY", true);
      await service.finalize(draft.id, "APPROVED", command(draft));
      const feed = await reader.getFeed({ kind: "discovery", cursor: null });
      expect(JSON.stringify(feed)).toContain(
        "WidgetDB uses a write-ahead log.",
      );
    },
  );
  it("replays lost-response/concurrent requests and rejects changed command bodies", async () => {
    const draft = await prepare();
    const [a, b] = await Promise.all([
      service.finalize(draft.id, "APPROVED", command(draft)),
      service.finalize(draft.id, "APPROVED", command(draft)),
    ]);
    expect(a.decision_id).toBe(b.decision_id);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    await expect(
      service.finalize(draft.id, "APPROVED", {
        ...command(draft),
        reason: "Different",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await client.contentDecision.count()).toBe(1);
  });
  it("allows only one finalization when two tabs use different command keys", async () => {
    const draft = await prepare();
    const outcomes = await Promise.allSettled([
      service.finalize(draft.id, "APPROVED", command(draft, "tab:1")),
      service.finalize(draft.id, "APPROVED", command(draft, "tab:2")),
    ]);
    expect(
      outcomes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(await client.contentDecision.count()).toBe(1);
    expect(
      await client.manualOverrideEvent.count({ where: { action: "APPROVED" } }),
    ).toBe(1);
  });
  it("detects stale saves and requires explicit evidence rebase after root changes", async () => {
    const draft = await prepare();
    await expect(
      service.save(draft.id, {
        expected_version: 1,
        source_hash: draft.source_hash,
        payload: {},
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await client.hnItem.update({
      where: { id: BigInt(rootId) },
      data: { title: "Changed root title" },
    });
    await expect(
      service.finalize(draft.id, "APPROVED", command(draft)),
    ).rejects.toMatchObject({ code: "SOURCE_CONFLICT" });
    const rebased = await service.rebase(draft.id, draft.version);
    expect(rebased.source_hash).not.toBe(draft.source_hash);
    expect(rebased.payload.discoveries?.[0]).toMatchObject({
      name: "WidgetDB",
      evidence_span_ids: [],
      url_candidate_ids: [],
    });
    await expect(
      service.finalize(draft.id, "APPROVED", command(rebased)),
    ).rejects.toMatchObject({ code: "OUTPUT_INVALID" });
  });
  it("refuses a source that is deleted after drafting", async () => {
    const draft = await prepare();
    await client.hnItem.update({
      where: { id: BigInt(commentId) },
      data: { availability: "DELETED" },
    });
    await expect(
      service.finalize(draft.id, "APPROVED", command(draft)),
    ).rejects.toMatchObject({ code: "SOURCE_CONFLICT" });
    expect((await counts()).decisions).toBe(0);
  });
  it.each(["root-edit", "deletion"])(
    "rechecks a concurrent %s after transaction retry",
    async (change) => {
      const draft = await prepare();
      let release!: () => void;
      let entered!: () => void;
      const paused = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const proceed = new Promise<void>((resolve) => {
        release = resolve;
      });
      let first = true;
      const gated: ManualReviewUnitOfWork = {
        run: (operation, id) =>
          work.run(
            (tx) =>
              operation({
                ...tx,
                drafts: {
                  ...tx.drafts,
                  sourceState: async (comment) => {
                    if (first) {
                      first = false;
                      entered();
                      await proceed;
                    }
                    return tx.drafts.sourceState(comment);
                  },
                },
              }),
            id,
          ),
      };
      const racing = createManualReviewService(gated, hasher, {
        actorId: "owner",
        cursorSecret: "test-secret",
      });
      const approval = racing.finalize(draft.id, "APPROVED", command(draft));
      const outcome = Promise.allSettled([approval]);
      await paused;
      try {
        if (change === "root-edit")
          await client.hnItem.update({
            where: { id: BigInt(rootId) },
            data: { textHtml: "<p>Changed evidence</p>" },
          });
        else
          await client.hnItem.update({
            where: { id: BigInt(commentId) },
            data: { availability: "DELETED" },
          });
      } finally {
        release();
      }
      expect((await outcome)[0]).toMatchObject({
        status: "rejected",
        reason: { code: "SOURCE_CONFLICT" },
      });
      expect(await counts()).toEqual({
        decisions: 0,
        discoveries: 0,
        notes: 0,
        events: 0,
        runs: 0,
      });
    },
  );
  it.each(["decision", "materialization", "approval"] as const)(
    "rolls back failure after %s, then permits retry",
    async (stage) => {
      const draft = await prepare();
      const failingWork: ManualReviewUnitOfWork = {
        run: (operation, id) =>
          work.run(
            async (tx) =>
              operation({
                ...tx,
                classifications: {
                  ...tx.classifications,
                  saveDecision: async (input) => {
                    const result = await tx.classifications.saveDecision(input);
                    if (stage === "decision") throw new Error("injected");
                    return result;
                  },
                },
                subjects: {
                  ...tx.subjects,
                  materialize: async (input) => {
                    const result = await tx.subjects.materialize(input);
                    if (stage === "materialization")
                      throw new Error("injected");
                    return result;
                  },
                },
                review: {
                  ...tx.review,
                  resolveTask: async (input) => {
                    const result = await tx.review.resolveTask(input);
                    if (stage === "approval") throw new Error("injected");
                    return result;
                  },
                },
              }),
            id,
          ),
      };
      const failing = createManualReviewService(failingWork, hasher, {
        actorId: "owner",
        cursorSecret: "test-secret",
      });
      await expect(
        failing.finalize(draft.id, "APPROVED", command(draft)),
      ).rejects.toThrow("injected");
      expect(await counts()).toEqual({
        decisions: 0,
        discoveries: 0,
        notes: 0,
        events: 0,
        runs: 0,
      });
      expect((await service.getComment(commentId)).draft?.state).toBe("DRAFT");
      await service.finalize(draft.id, "APPROVED", command(draft));
    },
  );
  it("supports inactive model history without fabricating a run or predecessor", async () => {
    const repository = createClassificationRepository(client);
    const { run } = await repository.recordRun({
      commentId: hnItemId(commentId),
      inputHash: "old",
      promptVersion: "old",
      promptHash: "old",
      schemaVersion: "classification.v1",
      modelConfigId: "fixture",
      provider: "fixture",
      modelId: "fixture",
      outputHash: "old-output",
      providerOutput: {},
      latencyMs: null,
      inputTokens: null,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      outputTokens: null,
      status: "REVIEW",
      errorCode: null,
    });
    await repository.saveDecision({
      commentId: hnItemId(commentId),
      classificationRunId: run.id,
      source: "MODEL",
      primaryDecision: "REVIEW",
      decisionConfidence: 0.1,
      materiallyTechnical: false,
      reviewRequired: true,
      validatedOutput: {},
      manualOverrideOfId: null,
      evidenceSpans: [],
    });
    const draft = await prepare();
    const result = await service.finalize(draft.id, "APPROVED", command(draft));
    expect(await client.classificationRun.count()).toBe(1);
    expect(
      (
        await client.contentDecision.findUniqueOrThrow({
          where: { id: result.decision_id },
        })
      ).manualOverrideOfId,
    ).toBeNull();
  });
  it("blocks generic review reopen and direct approval of workflow-owned decisions", async () => {
    const draft = await prepare();
    const result = await service.finalize(draft.id, "APPROVED", command(draft));
    const review = createReviewService(createReviewRepository(client), hasher);
    await expect(
      review.reopen({
        taskId: reviewTaskId(result.review_task_id),
        expectedVersion: 2,
        actorId: "owner",
        commandKey: "bypass",
        reason: "Attempt",
      }),
    ).rejects.toMatchObject({ code: "REVIEW_POLICY_INVALID" });
    const response = await app.request(
      `/v1/review/tasks/${result.review_task_id}/approve`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          expected_version: 2,
          command_key: "bypass2",
          reason: "Attempt",
        }),
      },
    );
    expect(response.status).toBe(422);
  });
  it("paginates the unreviewed inbox before limiting and signs the filter", async () => {
    for (let i = 1; i < 22; i += 1) await seedSource(commentId + i);
    const draft = await prepare();
    await service.finalize(draft.id, "APPROVED", command(draft));
    const first = await service.inbox();
    expect(first.items).toHaveLength(20);
    expect(first.items.every((row) => row.comment_id !== commentId)).toBe(true);
    const second = await service.inbox("unreviewed", first.next_cursor);
    expect(second.items).toHaveLength(1);
    expect(
      new Set([...first.items, ...second.items].map((row) => row.comment_id))
        .size,
    ).toBe(21);
    await expect(service.inbox("approved", first.next_cursor)).rejects.toThrow(
      TypeError,
    );
  });
});
