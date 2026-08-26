import { describe, expect, it, vi } from "vitest";

import {
  ReviewServiceError,
  type ReviewService,
} from "@hn-knowledge/application";
import {
  contentDecisionId,
  hnItemId,
  reviewTaskId,
  subjectId,
  urlCandidateId,
  type ReviewTask,
} from "@hn-knowledge/domain";
import { createApp, type SafeLogger } from "@hn-knowledge/api";

const token = "test-review-token";
const taskId = reviewTaskId("00000000-0000-4000-8000-000000000101");
const now = new Date("2026-08-25T12:00:00.000Z");
const sourceSubjectId = subjectId("00000000-0000-4000-8000-000000000201");
const targetSubjectId = subjectId("00000000-0000-4000-8000-000000000202");
const candidateId = urlCandidateId("00000000-0000-4000-8000-000000000203");
const task: ReviewTask = {
  id: taskId,
  commentId: hnItemId(9_101),
  contentDecisionId: contentDecisionId("00000000-0000-4000-8000-000000000102"),
  kind: "CONTENT_DECISION",
  targetKey: "content",
  targetSnapshotHash: null,
  state: "OPEN",
  priority: "LOW",
  reasonCodes: ["UNPROMOTED_MODEL_DECISION"],
  version: 1,
  revision: 1,
  supersedesTaskId: null,
  resolutionReason: null,
  resolvedBy: null,
  resolvedAt: null,
  createdAt: now,
  updatedAt: now,
};
const logger: SafeLogger = { error: vi.fn() };
const resolvedTask = (state: "APPROVED" | "REJECTED"): ReviewTask => ({
  ...task,
  state,
  version: 2,
  resolutionReason: state === "APPROVED" ? "Approved" : "Rejected",
  resolvedBy: "owner",
  resolvedAt: now,
});
const supersededTask = (): ReviewTask => ({
  ...task,
  state: "SUPERSEDED",
  version: 2,
  resolutionReason: "Superseded",
  resolvedBy: "owner",
  resolvedAt: now,
});

const fakeService = (
  overrides: Partial<ReviewService> = {},
): ReviewService => ({
  openPolicyReview: vi.fn(),
  openActionReview: vi.fn(),
  getTask: vi.fn(async () => task),
  listOpenTasks: vi.fn(async () => ({ items: [task], nextCursor: null })),
  approve: vi.fn(async () => resolvedTask("APPROVED")),
  reject: vi.fn(async () => resolvedTask("REJECTED")),
  supersede: vi.fn(async () => supersededTask()),
  reopen: vi.fn(async () => task),
  mergeSubjects: vi.fn(async () => resolvedTask("APPROVED")),
  resolveSubjectUrl: vi.fn(async () => resolvedTask("APPROVED")),
  ...overrides,
});

const authorized = { authorization: `Bearer ${token}` };

describe("review routes", () => {
  it.each([
    ["GET", "/v1/review/tasks"],
    ["POST", `/v1/review/tasks/${taskId}/approve`],
    ["POST", `/v1/review/tasks/${taskId}/reject`],
    ["POST", `/v1/review/tasks/${taskId}/merge-subject`],
    ["POST", `/v1/review/tasks/${taskId}/resolve-url`],
  ] as const)("requires authentication for %s %s", async (method, path) => {
    const service = fakeService();
    const app = createApp({
      apiToken: token,
      logger,
      reviewService: service,
      reviewActorId: "url-owner",
    });

    const response = await app.request(path, { method });

    expect(response.status).toBe(401);
    expect(service.listOpenTasks).not.toHaveBeenCalled();
    expect(service.approve).not.toHaveBeenCalled();
    expect(service.reject).not.toHaveBeenCalled();
    expect(service.mergeSubjects).not.toHaveBeenCalled();
    expect(service.resolveSubjectUrl).not.toHaveBeenCalled();
  });

  it("returns a redacted 404 for a missing review task", async () => {
    const service = fakeService({
      approve: vi.fn(async () => {
        throw new ReviewServiceError("REVIEW_NOT_FOUND");
      }),
    });
    const app = createApp({ apiToken: token, logger, reviewService: service });

    const response = await app.request(`/v1/review/tasks/${taskId}/approve`, {
      method: "POST",
      headers: { ...authorized, "content-type": "application/json" },
      body: JSON.stringify({
        expected_version: 1,
        command_key: "missing-review-101",
        reason: "Review task no longer exists",
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toMatchObject({ error: "not_found" });
    expect(JSON.stringify(body)).not.toContain(task.contentDecisionId);
  });

  it("lists a bounded redacted review queue", async () => {
    const service = fakeService();
    const app = createApp({ apiToken: token, logger, reviewService: service });

    const response = await app.request("/v1/review/tasks?limit=10", {
      headers: authorized,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        {
          id: task.id,
          comment_id: task.commentId,
          content_decision_id: task.contentDecisionId,
          kind: "CONTENT_DECISION",
          target_key: "content",
          state: "OPEN",
          priority: "LOW",
          reason_codes: ["UNPROMOTED_MODEL_DECISION"],
          version: 1,
          revision: 1,
          supersedes_task_id: null,
          resolution_reason: null,
          resolved_by: null,
          resolved_at: null,
          created_at: now.toISOString(),
          updated_at: now.toISOString(),
        },
      ],
      next_cursor: null,
    });
    expect(service.listOpenTasks).toHaveBeenCalledWith(10, null);
  });

  it("approves with the configured actor and strict command body", async () => {
    const service = fakeService();
    const app = createApp({
      apiToken: token,
      logger,
      reviewService: service,
      reviewActorId: "local-owner",
    });

    const response = await app.request(`/v1/review/tasks/${taskId}/approve`, {
      method: "POST",
      headers: { ...authorized, "content-type": "application/json" },
      body: JSON.stringify({
        expected_version: 1,
        command_key: "approve-101",
        reason: "Reviewed manually",
      }),
    });

    expect(response.status).toBe(200);
    expect(service.approve).toHaveBeenCalledWith({
      taskId,
      expectedVersion: 1,
      actorId: "local-owner",
      commandKey: "approve-101",
      reason: "Reviewed manually",
    });
  });

  it("maps optimistic conflicts and terminal-state errors safely", async () => {
    const versionService = fakeService({
      approve: vi.fn(async () => {
        throw new ReviewServiceError("REVIEW_VERSION_CONFLICT", 2);
      }),
    });
    const terminalService = fakeService({
      reject: vi.fn(async () => {
        throw new ReviewServiceError("REVIEW_INVALID_STATE", null, "APPROVED");
      }),
    });
    const body = JSON.stringify({
      expected_version: 1,
      command_key: "resolve-101",
      reason: "Reviewed manually",
    });

    const conflict = await createApp({
      apiToken: token,
      logger,
      reviewService: versionService,
    }).request(`/v1/review/tasks/${taskId}/approve`, {
      method: "POST",
      headers: { ...authorized, "content-type": "application/json" },
      body,
    });
    const terminal = await createApp({
      apiToken: token,
      logger,
      reviewService: terminalService,
    }).request(`/v1/review/tasks/${taskId}/reject`, {
      method: "POST",
      headers: { ...authorized, "content-type": "application/json" },
      body,
    });

    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: "version_conflict",
      current_version: 2,
    });
    expect(terminal.status).toBe(422);
    expect(await terminal.json()).toMatchObject({
      error: "invalid_review_state",
      current_state: "APPROVED",
    });
  });

  it("rejects unexpected fields without invoking the service", async () => {
    const service = fakeService();
    const app = createApp({
      apiToken: token,
      logger,
      reviewService: service,
      reviewActorId: "url-owner",
    });

    const response = await app.request(`/v1/review/tasks/${taskId}/approve`, {
      method: "POST",
      headers: { ...authorized, "content-type": "application/json" },
      body: JSON.stringify({
        expected_version: 1,
        command_key: "approve-101",
        reason: "Reviewed manually",
        actor_id: "spoofed",
      }),
    });

    expect(response.status).toBe(400);
    expect(service.approve).not.toHaveBeenCalled();
  });

  it("parses the strict subject-merge action and supplies the configured actor", async () => {
    const service = fakeService();
    const app = createApp({
      apiToken: token,
      logger,
      reviewService: service,
      reviewActorId: "merge-owner",
    });

    const response = await app.request(
      `/v1/review/tasks/${taskId}/merge-subject`,
      {
        method: "POST",
        headers: { ...authorized, "content-type": "application/json" },
        body: JSON.stringify({
          expected_version: 1,
          source_subject_id: sourceSubjectId,
          target_subject_id: targetSubjectId,
          command_key: "merge-subject-101",
          reason: "Confirmed the suggested identity",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(service.mergeSubjects).toHaveBeenCalledWith({
      taskId,
      expectedVersion: 1,
      sourceSubjectId,
      targetSubjectId,
      actorId: "merge-owner",
      commandKey: "merge-subject-101",
      reason: "Confirmed the suggested identity",
    });
  });

  it("parses URL resolution and maps invalid candidate membership to 422", async () => {
    const service = fakeService({
      resolveSubjectUrl: vi.fn(async () => {
        throw new ReviewServiceError("REVIEW_POLICY_INVALID");
      }),
    });
    const app = createApp({
      apiToken: token,
      logger,
      reviewService: service,
      reviewActorId: "url-owner",
    });

    const response = await app.request(
      `/v1/review/tasks/${taskId}/resolve-url`,
      {
        method: "POST",
        headers: { ...authorized, "content-type": "application/json" },
        body: JSON.stringify({
          expected_version: 1,
          subject_id: sourceSubjectId,
          url_candidate_id: candidateId,
          command_key: "resolve-url-101",
          reason: "Use the reviewed candidate",
        }),
      },
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "policy_invalid" });
    expect(service.resolveSubjectUrl).toHaveBeenCalledWith({
      taskId,
      expectedVersion: 1,
      subjectId: sourceSubjectId,
      urlCandidateId: candidateId,
      actorId: "url-owner",
      commandKey: "resolve-url-101",
      reason: "Use the reviewed candidate",
    });
  });
});
