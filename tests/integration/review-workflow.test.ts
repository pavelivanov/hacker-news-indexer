import { createHash } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createReviewService,
  ReviewServiceError,
} from "@hn-knowledge/application";
import { createApp } from "@hn-knowledge/api";
import {
  createClassificationRepository,
  createDatabase,
  createReviewRepository,
  type Database,
} from "@hn-knowledge/db";
import {
  UNPROMOTED_MODEL_REVIEW_DECISION,
  hnItemId,
} from "@hn-knowledge/domain";

const databaseUrl =
  process.env["DATABASE_URL"] ??
  "postgresql://hn_knowledge:hn_knowledge@127.0.0.1:5432/hn_knowledge";
const database: Database = createDatabase({ connectionString: databaseUrl });
const classification = createClassificationRepository(database.client);
const repository = createReviewRepository(database.client);
const hasher = {
  sha256: (value: string): string =>
    createHash("sha256").update(value).digest("hex"),
};
const service = createReviewService(repository, hasher);
const commentId = hnItemId(9_101);
const now = new Date("2026-08-25T12:00:00.000Z");

const clean = async (): Promise<void> => {
  await database.client.$executeRawUnsafe(
    'TRUNCATE TABLE "manual_override_events", "review_tasks", "evidence_spans", "content_decisions", "classification_runs" CASCADE',
  );
  await database.client.hnItem.deleteMany({ where: { id: BigInt(commentId) } });
};

const prepareDecision = async () => {
  await database.client.hnItem.create({
    data: {
      id: BigInt(commentId),
      type: "comment",
      parentId: null,
      author: "fixture",
      time: now,
      title: null,
      textHtml: "<p>Fixture</p>",
      textPlain: "Fixture",
      url: null,
      availability: "AVAILABLE",
      fetchedAt: now,
      responseHash: hasher.sha256("response"),
      selectedComment: {
        create: {
          rootId: BigInt(commentId),
          canonicalHtml: "<p>Fixture</p>",
          canonicalText: "Fixture",
          contentHash: hasher.sha256("Fixture"),
          availability: "AVAILABLE",
          firstSeenAt: now,
          lastSeenAt: now,
        },
      },
    },
  });
  const { run } = await classification.recordRun({
    commentId,
    inputHash: hasher.sha256("input"),
    promptVersion: "classification-prompt.v3",
    promptHash: hasher.sha256("prompt"),
    schemaVersion: "classification.v1",
    modelConfigId: "fixture-review-v1",
    provider: "fixture",
    modelId: "gold-replay-v1",
    outputHash: hasher.sha256("output"),
    providerOutput: { primary_decision: "DISCOVERY" },
    latencyMs: 1,
    inputTokens: 1,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 1,
    status: "REVIEW",
    errorCode: null,
  });
  return classification.saveDecision({
    commentId,
    classificationRunId: run.id,
    source: "MODEL",
    primaryDecision: "DISCOVERY",
    decisionConfidence: 0.9,
    materiallyTechnical: true,
    reviewRequired: true,
    validatedOutput: { primary_decision: "DISCOVERY" },
    manualOverrideOfId: null,
    evidenceSpans: [],
  });
};

beforeEach(clean);
afterEach(clean);
afterAll(async () => database.close());

describe("review workflow repository", () => {
  it("opens one logical task and audit event under replay", async () => {
    const decision = await prepareDecision();

    const [first, second] = await Promise.all([
      service.openPolicyReview({
        commentId,
        contentDecisionId: decision.id,
        policy: UNPROMOTED_MODEL_REVIEW_DECISION,
      }),
      service.openPolicyReview({
        commentId,
        contentDecisionId: decision.id,
        policy: UNPROMOTED_MODEL_REVIEW_DECISION,
      }),
    ]);

    expect(first.task.id).toBe(second.task.id);
    expect(new Set([first.created, second.created])).toEqual(
      new Set([true, false]),
    );
    expect(first.task).toMatchObject({
      state: "OPEN",
      version: 1,
      priority: "LOW",
      reasonCodes: ["UNPROMOTED_MODEL_DECISION"],
    });
    expect(await database.client.reviewTask.count()).toBe(1);
    expect(await database.client.manualOverrideEvent.count()).toBe(1);
  });

  it("paginates the open queue without duplicates", async () => {
    const firstDecision = await prepareDecision();
    const secondDecision = await classification.saveDecision({
      commentId,
      classificationRunId: null,
      source: "MANUAL",
      primaryDecision: "EXPERT_NOTE",
      decisionConfidence: 1,
      materiallyTechnical: true,
      reviewRequired: true,
      validatedOutput: { primary_decision: "EXPERT_NOTE" },
      manualOverrideOfId: firstDecision.id,
      evidenceSpans: [],
    });
    await service.openPolicyReview({
      commentId,
      contentDecisionId: firstDecision.id,
      policy: UNPROMOTED_MODEL_REVIEW_DECISION,
    });
    await service.openPolicyReview({
      commentId,
      contentDecisionId: secondDecision.id,
      policy: UNPROMOTED_MODEL_REVIEW_DECISION,
    });

    const firstPage = await service.listOpenTasks(1, null);
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();
    if (firstPage.nextCursor === null) {
      throw new Error("Expected a review queue cursor");
    }
    const secondPage = await service.listOpenTasks(1, firstPage.nextCursor);

    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("approves once, activates atomically, and replays the command", async () => {
    const decision = await prepareDecision();
    const opened = await service.openPolicyReview({
      commentId,
      contentDecisionId: decision.id,
      policy: UNPROMOTED_MODEL_REVIEW_DECISION,
    });
    const command = {
      taskId: opened.task.id,
      expectedVersion: 1,
      actorId: "owner",
      commandKey: "approve-review-9101",
      reason: "Grounded discovery reviewed manually",
    };

    const approved = await service.approve(command);
    const replayed = await service.approve(command);

    expect(approved).toMatchObject({
      state: "APPROVED",
      version: 2,
      resolvedBy: "owner",
    });
    expect(replayed).toEqual(approved);
    expect((await classification.getActiveDecision(commentId))?.id).toBe(
      decision.id,
    );
    expect(await database.client.manualOverrideEvent.count()).toBe(2);
  });

  it("reports stale versions while the task remains open", async () => {
    const decision = await prepareDecision();
    const opened = await service.openPolicyReview({
      commentId,
      contentDecisionId: decision.id,
      policy: UNPROMOTED_MODEL_REVIEW_DECISION,
    });

    await expect(
      service.approve({
        taskId: opened.task.id,
        expectedVersion: 2,
        actorId: "owner",
        commandKey: "stale-review-9101",
        reason: "Stale client attempt",
      }),
    ).rejects.toMatchObject({
      code: "REVIEW_VERSION_CONFLICT",
      currentVersion: 1,
    });
    expect((await repository.getTask(opened.task.id))?.state).toBe("OPEN");
  });

  it("allows only one of two concurrent review decisions to succeed", async () => {
    const decision = await prepareDecision();
    const opened = await service.openPolicyReview({
      commentId,
      contentDecisionId: decision.id,
      policy: UNPROMOTED_MODEL_REVIEW_DECISION,
    });

    const outcomes = await Promise.allSettled([
      service.approve({
        taskId: opened.task.id,
        expectedVersion: 1,
        actorId: "owner-a",
        commandKey: "concurrent-approve-9101",
        reason: "Concurrent approval",
      }),
      service.reject({
        taskId: opened.task.id,
        expectedVersion: 1,
        actorId: "owner-b",
        commandKey: "concurrent-reject-9101",
        reason: "Concurrent rejection",
      }),
    ]);

    expect(
      outcomes.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = outcomes.find(({ status }) => status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (
      rejected?.status !== "rejected" ||
      !(rejected.reason instanceof ReviewServiceError)
    ) {
      throw new Error("Expected a bounded review conflict");
    }
    expect(["REVIEW_INVALID_STATE", "REVIEW_VERSION_CONFLICT"]).toContain(
      rejected.reason.code,
    );
    expect(await database.client.manualOverrideEvent.count()).toBe(2);
    const resolved = await repository.getTask(opened.task.id);
    expect(resolved).toMatchObject({
      version: 2,
    });
    expect(["APPROVED", "REJECTED"]).toContain(resolved?.state);
  });

  it("rejects without activating the model decision", async () => {
    const decision = await prepareDecision();
    const opened = await service.openPolicyReview({
      commentId,
      contentDecisionId: decision.id,
      policy: UNPROMOTED_MODEL_REVIEW_DECISION,
    });

    const rejected = await service.reject({
      taskId: opened.task.id,
      expectedVersion: 1,
      actorId: "owner",
      commandKey: "reject-review-9101",
      reason: "Not suitable for the private knowledge feed",
    });

    expect(rejected).toMatchObject({ state: "REJECTED", version: 2 });
    await expect(
      classification.getActiveDecision(commentId),
    ).resolves.toBeNull();
  });

  it("supersedes an open task and reopens it as an append-only revision", async () => {
    const decision = await prepareDecision();
    const opened = await service.openPolicyReview({
      commentId,
      contentDecisionId: decision.id,
      policy: UNPROMOTED_MODEL_REVIEW_DECISION,
    });
    const supersedeCommand = {
      taskId: opened.task.id,
      expectedVersion: 1,
      actorId: "owner",
      commandKey: "supersede-review-9101",
      reason: "A revised review is required",
    };

    const superseded = await service.supersede(supersedeCommand);
    await expect(service.supersede(supersedeCommand)).resolves.toEqual(
      superseded,
    );
    expect(superseded).toMatchObject({
      id: opened.task.id,
      state: "SUPERSEDED",
      version: 2,
      revision: 1,
    });

    const reopenCommand = {
      taskId: superseded.id,
      expectedVersion: 2,
      actorId: "owner",
      commandKey: "reopen-review-9101",
      reason: "Review against the corrected context",
    };
    const reopened = await service.reopen(reopenCommand);
    await expect(service.reopen(reopenCommand)).resolves.toEqual(reopened);

    expect(reopened).toMatchObject({
      state: "OPEN",
      version: 1,
      revision: 2,
      supersedesTaskId: superseded.id,
      kind: "CONTENT_DECISION",
    });
    await expect(database.client.reviewTask.count()).resolves.toBe(2);
    await expect(database.client.manualOverrideEvent.count()).resolves.toBe(3);
    const actions = await database.client.manualOverrideEvent.findMany({
      orderBy: { createdAt: "asc" },
      select: { action: true },
    });
    expect(actions.map((event) => event.action)).toEqual([
      "OPENED",
      "SUPERSEDED",
      "REOPENED",
    ]);
  });

  it("reviews through the authenticated API and records the configured actor", async () => {
    const decision = await prepareDecision();
    const opened = await service.openPolicyReview({
      commentId,
      contentDecisionId: decision.id,
      policy: UNPROMOTED_MODEL_REVIEW_DECISION,
    });
    const app = createApp({
      apiToken: "integration-review-token",
      reviewActorId: "integration-owner",
      reviewService: service,
      startIngestion: () => Promise.reject(new Error("not used in this test")),
    });

    const unauthorized = await app.request("/v1/review/tasks");
    expect(unauthorized.status).toBe(401);

    const listed = await app.request("/v1/review/tasks?limit=10", {
      headers: { authorization: "Bearer integration-review-token" },
    });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      items: [{ id: opened.task.id, state: "OPEN", version: 1 }],
      next_cursor: null,
    });

    const approved = await app.request(
      `/v1/review/tasks/${opened.task.id}/approve`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer integration-review-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          expected_version: 1,
          command_key: "approve-through-api-9101",
          reason: "Approved through the authenticated integration path",
        }),
      },
    );

    expect(approved.status).toBe(200);
    await expect(approved.json()).resolves.toMatchObject({
      task: {
        id: opened.task.id,
        state: "APPROVED",
        version: 2,
        resolved_by: "integration-owner",
      },
    });
    await expect(
      database.client.manualOverrideEvent.findUniqueOrThrow({
        where: { commandKey: "approve-through-api-9101" },
      }),
    ).resolves.toMatchObject({ actorId: "integration-owner" });
    expect((await classification.getActiveDecision(commentId))?.id).toBe(
      decision.id,
    );
  });

  it("enforces append-only audit and the review transition matrix", async () => {
    const decision = await prepareDecision();
    const opened = await service.openPolicyReview({
      commentId,
      contentDecisionId: decision.id,
      policy: UNPROMOTED_MODEL_REVIEW_DECISION,
    });
    const event = await database.client.manualOverrideEvent.findFirstOrThrow({
      where: { reviewTaskId: opened.task.id },
    });

    await expect(
      database.client.manualOverrideEvent.delete({ where: { id: event.id } }),
    ).rejects.toThrow(/review history is append-only/u);
    await expect(
      database.client.manualOverrideEvent.update({
        where: { id: event.id },
        data: { reason: "Attempted rewrite" },
      }),
    ).rejects.toThrow(/review history is append-only/u);
    await expect(
      database.client.reviewTask.delete({ where: { id: opened.task.id } }),
    ).rejects.toThrow(/review history is append-only/u);
    await expect(
      database.client.reviewTask.update({
        where: { id: opened.task.id },
        data: { priority: "CRITICAL" },
      }),
    ).rejects.toThrow(/invalid review task transition/u);
    await expect(
      database.client.selectedComment.update({
        where: { id: BigInt(commentId) },
        data: { activeDecisionId: decision.id },
      }),
    ).rejects.toThrow(/active decision requires approved review/u);
    await expect(
      database.client.reviewTask.update({
        where: { id: opened.task.id },
        data: {
          state: "APPROVED",
          version: { increment: 1 },
          resolutionReason: "Direct transition without audit",
          resolvedBy: "unsafe-direct-client",
          resolvedAt: now,
        },
      }),
    ).rejects.toThrow(/transition requires matching audit event/u);
  });
});
