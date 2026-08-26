import {
  ReviewServiceError,
  type MergeSubjectsReviewCommand,
  type ResolveReviewCommand,
  type ResolveSubjectUrlReviewCommand,
  type ReviewService,
} from "@hn-knowledge/application";
import {
  reviewTaskId,
  subjectId,
  urlCandidateId,
  type ReviewTask,
} from "@hn-knowledge/domain";
import type { Context, Hono } from "hono";

import type { HealthBindings } from "./health.js";

interface RegisterReviewRoutesOptions {
  readonly service: ReviewService;
  readonly actorId: string;
}

interface ResolutionRequest {
  readonly expectedVersion: number;
  readonly commandKey: string;
  readonly reason: string;
}

interface MergeSubjectsRequest extends ResolutionRequest {
  readonly sourceSubjectId: string;
  readonly targetSubjectId: string;
}

interface ResolveUrlRequest extends ResolutionRequest {
  readonly subjectId: string;
  readonly urlCandidateId: string;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COMMAND_KEY = /^[A-Za-z0-9._:-]{1,256}$/u;
const requestKeys = ["expected_version", "command_key", "reason"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const parseResolutionRequest = (value: unknown): ResolutionRequest => {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== requestKeys.length ||
    !Object.keys(value).every((key) =>
      requestKeys.includes(key as (typeof requestKeys)[number]),
    )
  ) {
    throw new TypeError("Request body has unexpected fields");
  }
  const expectedVersion = value["expected_version"];
  const rawCommandKey = value["command_key"];
  const rawReason = value["reason"];
  const commandKey =
    typeof rawCommandKey === "string" ? rawCommandKey.trim() : "";
  const reason = typeof rawReason === "string" ? rawReason.trim() : "";
  if (
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion <= 0 ||
    !COMMAND_KEY.test(commandKey) ||
    reason.length === 0 ||
    reason.length > 1_000
  ) {
    throw new TypeError("Request body is invalid");
  }
  return { expectedVersion, commandKey, reason };
};

const parseActionBase = (value: Record<string, unknown>): ResolutionRequest => {
  const expectedVersion = value["expected_version"];
  const rawCommandKey = value["command_key"];
  const rawReason = value["reason"];
  const commandKey =
    typeof rawCommandKey === "string" ? rawCommandKey.trim() : "";
  const reason = typeof rawReason === "string" ? rawReason.trim() : "";
  if (
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion <= 0 ||
    !COMMAND_KEY.test(commandKey) ||
    reason.length === 0 ||
    reason.length > 1_000
  ) {
    throw new TypeError("Request body is invalid");
  }
  return { expectedVersion, commandKey, reason };
};

const parseMergeSubjectsRequest = (value: unknown): MergeSubjectsRequest => {
  const keys = [
    ...requestKeys,
    "source_subject_id",
    "target_subject_id",
  ] as const;
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    !Object.keys(value).every((key) =>
      keys.includes(key as (typeof keys)[number]),
    ) ||
    typeof value["source_subject_id"] !== "string" ||
    typeof value["target_subject_id"] !== "string" ||
    !UUID.test(value["source_subject_id"]) ||
    !UUID.test(value["target_subject_id"])
  ) {
    throw new TypeError("Request body is invalid");
  }
  return {
    ...parseActionBase(value),
    sourceSubjectId: value["source_subject_id"],
    targetSubjectId: value["target_subject_id"],
  };
};

const parseResolveUrlRequest = (value: unknown): ResolveUrlRequest => {
  const keys = [...requestKeys, "subject_id", "url_candidate_id"] as const;
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    !Object.keys(value).every((key) =>
      keys.includes(key as (typeof keys)[number]),
    ) ||
    typeof value["subject_id"] !== "string" ||
    typeof value["url_candidate_id"] !== "string" ||
    !UUID.test(value["subject_id"]) ||
    !UUID.test(value["url_candidate_id"])
  ) {
    throw new TypeError("Request body is invalid");
  }
  return {
    ...parseActionBase(value),
    subjectId: value["subject_id"],
    urlCandidateId: value["url_candidate_id"],
  };
};

const responseTask = (task: ReviewTask) => ({
  id: task.id,
  comment_id: task.commentId,
  content_decision_id: task.contentDecisionId,
  kind: task.kind,
  target_key: task.targetKey,
  state: task.state,
  priority: task.priority,
  reason_codes: task.reasonCodes,
  version: task.version,
  revision: task.revision,
  supersedes_task_id: task.supersedesTaskId,
  resolution_reason: task.resolutionReason,
  resolved_by: task.resolvedBy,
  resolved_at: task.resolvedAt?.toISOString() ?? null,
  created_at: task.createdAt.toISOString(),
  updated_at: task.updatedAt.toISOString(),
});

const errorResponse = (
  error: ReviewServiceError,
  requestId: string,
): {
  readonly body: Record<string, unknown>;
  readonly status: 404 | 409 | 422;
} => {
  switch (error.code) {
    case "REVIEW_NOT_FOUND":
      return { body: { error: "not_found", requestId }, status: 404 };
    case "REVIEW_VERSION_CONFLICT":
      return {
        body: {
          error: "version_conflict",
          current_version: error.currentVersion,
          requestId,
        },
        status: 409,
      };
    case "REVIEW_IDEMPOTENCY_CONFLICT":
      return {
        body: { error: "idempotency_conflict", requestId },
        status: 409,
      };
    case "REVIEW_INVALID_STATE":
      return {
        body: {
          error: "invalid_review_state",
          current_state: error.currentState,
          requestId,
        },
        status: 422,
      };
    case "REVIEW_POLICY_INVALID":
      return {
        body: { error: "policy_invalid", requestId },
        status: 422,
      };
  }
};

export const registerReviewRoutes = (
  app: Hono<HealthBindings>,
  options: RegisterReviewRoutesOptions,
): void => {
  app.get("/v1/review/tasks", async (context) => {
    const rawLimit = context.req.query("limit");
    const limit = rawLimit === undefined ? 25 : Number(rawLimit);
    const rawCursor = context.req.query("cursor");
    if (
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit > 100 ||
      (rawCursor !== undefined && !UUID.test(rawCursor))
    ) {
      return context.json(
        {
          error: "invalid_request" as const,
          requestId: context.get("requestId"),
        },
        400,
      );
    }
    const page = await options.service.listOpenTasks(
      limit,
      rawCursor === undefined ? null : reviewTaskId(rawCursor),
    );
    return context.json({
      items: page.items.map(responseTask),
      next_cursor: page.nextCursor,
    });
  });

  const resolveTask = async (
    context: Context<HealthBindings>,
    outcome: "APPROVED" | "REJECTED",
  ) => {
    const rawTaskId = context.req.param("id");
    if (rawTaskId === undefined || !UUID.test(rawTaskId)) {
      return context.json(
        { error: "not_found" as const, requestId: context.get("requestId") },
        404,
      );
    }
    let request: ResolutionRequest;
    try {
      request = parseResolutionRequest(await context.req.json<unknown>());
    } catch {
      return context.json(
        {
          error: "invalid_request" as const,
          requestId: context.get("requestId"),
        },
        400,
      );
    }
    const command: ResolveReviewCommand = {
      taskId: reviewTaskId(rawTaskId),
      expectedVersion: request.expectedVersion,
      actorId: options.actorId,
      commandKey: request.commandKey,
      reason: request.reason,
    };
    try {
      const task =
        outcome === "APPROVED"
          ? await options.service.approve(command)
          : await options.service.reject(command);
      return context.json({ task: responseTask(task) }, 200);
    } catch (error) {
      if (!(error instanceof ReviewServiceError)) {
        throw error;
      }
      const response = errorResponse(error, context.get("requestId"));
      return context.json(response.body, response.status);
    }
  };

  app.post("/v1/review/tasks/:id/approve", (context) =>
    resolveTask(context, "APPROVED"),
  );
  app.post("/v1/review/tasks/:id/reject", (context) =>
    resolveTask(context, "REJECTED"),
  );

  app.post("/v1/review/tasks/:id/merge-subject", async (context) => {
    const rawTaskId = context.req.param("id");
    if (!UUID.test(rawTaskId)) {
      return context.json(
        { error: "not_found" as const, requestId: context.get("requestId") },
        404,
      );
    }
    let request: MergeSubjectsRequest;
    try {
      request = parseMergeSubjectsRequest(await context.req.json<unknown>());
    } catch {
      return context.json(
        {
          error: "invalid_request" as const,
          requestId: context.get("requestId"),
        },
        400,
      );
    }
    const command: MergeSubjectsReviewCommand = {
      taskId: reviewTaskId(rawTaskId),
      expectedVersion: request.expectedVersion,
      sourceSubjectId: subjectId(request.sourceSubjectId),
      targetSubjectId: subjectId(request.targetSubjectId),
      actorId: options.actorId,
      commandKey: request.commandKey,
      reason: request.reason,
    };
    try {
      const task = await options.service.mergeSubjects(command);
      return context.json({ task: responseTask(task) }, 200);
    } catch (error) {
      if (!(error instanceof ReviewServiceError)) {
        throw error;
      }
      const response = errorResponse(error, context.get("requestId"));
      return context.json(response.body, response.status);
    }
  });

  app.post("/v1/review/tasks/:id/resolve-url", async (context) => {
    const rawTaskId = context.req.param("id");
    if (!UUID.test(rawTaskId)) {
      return context.json(
        { error: "not_found" as const, requestId: context.get("requestId") },
        404,
      );
    }
    let request: ResolveUrlRequest;
    try {
      request = parseResolveUrlRequest(await context.req.json<unknown>());
    } catch {
      return context.json(
        {
          error: "invalid_request" as const,
          requestId: context.get("requestId"),
        },
        400,
      );
    }
    const command: ResolveSubjectUrlReviewCommand = {
      taskId: reviewTaskId(rawTaskId),
      expectedVersion: request.expectedVersion,
      subjectId: subjectId(request.subjectId),
      urlCandidateId: urlCandidateId(request.urlCandidateId),
      actorId: options.actorId,
      commandKey: request.commandKey,
      reason: request.reason,
    };
    try {
      const task = await options.service.resolveSubjectUrl(command);
      return context.json({ task: responseTask(task) }, 200);
    } catch (error) {
      if (!(error instanceof ReviewServiceError)) {
        throw error;
      }
      const response = errorResponse(error, context.get("requestId"));
      return context.json(response.body, response.status);
    }
  });
};
