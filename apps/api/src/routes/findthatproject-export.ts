import {
  FindThatProjectExportError,
  type FindThatProjectExportService,
} from "@hn-knowledge/application";
import type { PipelineMetrics } from "@hn-knowledge/config";
import type { Context, Hono } from "hono";

import { createBearerAuth } from "../middleware/bearer-auth.js";
import type { HealthBindings } from "./health.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COMMAND_KEY = /^[A-Za-z0-9._:-]{1,256}$/u;
const HASH = /^[0-9a-f]{64}$/u;

interface ResolutionBody {
  readonly commandKey: string;
  readonly reason: string;
  readonly expectedVersion?: number;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const resolutionBody = (
  value: unknown,
  withVersion: boolean,
): ResolutionBody => {
  const keys = withVersion
    ? ["expected_version", "command_key", "reason"]
    : ["command_key", "reason"];
  if (
    !record(value) ||
    Object.keys(value).length !== keys.length ||
    !Object.keys(value).every((key) => keys.includes(key))
  ) {
    throw new TypeError("Request body has unexpected fields");
  }
  const commandKey =
    typeof value["command_key"] === "string" ? value["command_key"].trim() : "";
  const reason =
    typeof value["reason"] === "string" ? value["reason"].trim() : "";
  const expectedVersion = value["expected_version"];
  if (
    !COMMAND_KEY.test(commandKey) ||
    reason.length === 0 ||
    reason.length > 1_000 ||
    (withVersion &&
      (typeof expectedVersion !== "number" ||
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion <= 0))
  ) {
    throw new TypeError("Request body is invalid");
  }
  return {
    commandKey,
    reason,
    ...(withVersion ? { expectedVersion: expectedVersion as number } : {}),
  };
};

const ackBody = (
  value: unknown,
): { readonly payloadHash: string; readonly idempotencyKey: string } => {
  if (
    !record(value) ||
    Object.keys(value).length !== 2 ||
    !Object.keys(value).every((key) =>
      ["payload_hash", "idempotency_key"].includes(key),
    ) ||
    typeof value["payload_hash"] !== "string" ||
    !HASH.test(value["payload_hash"]) ||
    typeof value["idempotency_key"] !== "string" ||
    !COMMAND_KEY.test(value["idempotency_key"])
  ) {
    throw new TypeError("Request body is invalid");
  }
  return {
    payloadHash: value["payload_hash"],
    idempotencyKey: value["idempotency_key"],
  };
};

const requestJson = async (
  context: Context<HealthBindings>,
): Promise<unknown> => {
  try {
    return await context.req.json<unknown>();
  } catch {
    throw new TypeError("Request body is not valid JSON");
  }
};

const errorResponse = (
  context: Context<HealthBindings>,
  error: FindThatProjectExportError,
): Response => {
  const requestId = context.get("requestId");
  switch (error.code) {
    case "NOT_FOUND":
      return context.json({ error: "not_found", requestId }, 404);
    case "INVALID_CURSOR":
      return context.json({ error: "invalid_cursor", requestId }, 400);
    case "VERSION_CONFLICT":
      return context.json(
        {
          error: "version_conflict",
          current_version: error.details.currentVersion,
          requestId,
        },
        409,
      );
    case "INVALID_STATE":
      return context.json(
        {
          error: "invalid_review_state",
          current_state: error.details.currentState,
          requestId,
        },
        422,
      );
    case "INELIGIBLE":
      return context.json(
        {
          error: "export_ineligible",
          reason_codes: error.details.reasons ?? [],
          requestId,
        },
        422,
      );
    case "SNAPSHOT_CHANGED":
      return context.json({ error: "snapshot_changed", requestId }, 409);
    case "ALREADY_CURRENT":
      return context.json({ error: "already_current", requestId }, 409);
    case "PAYLOAD_HASH_MISMATCH":
      return context.json({ error: "payload_hash_mismatch", requestId }, 409);
    case "IDEMPOTENCY_CONFLICT":
      return context.json({ error: "idempotency_conflict", requestId }, 409);
  }
};

const execute = async (
  context: Context<HealthBindings>,
  action: () => Promise<unknown>,
): Promise<Response> => {
  try {
    return context.json(await action());
  } catch (error) {
    if (error instanceof FindThatProjectExportError) {
      return errorResponse(context, error);
    }
    if (error instanceof TypeError) {
      return context.json(
        { error: "invalid_request", requestId: context.get("requestId") },
        400,
      );
    }
    throw error;
  }
};

export const registerFindThatProjectConsumerRoutes = (
  app: Hono<HealthBindings>,
  options: {
    readonly service: FindThatProjectExportService;
    readonly consumerToken: string | undefined;
    readonly metrics: PipelineMetrics;
  },
): void => {
  const base = "/v1/exports/findthatproject/outbox";
  app.use(`${base}/*`, createBearerAuth(options.consumerToken));
  app.use(base, createBearerAuth(options.consumerToken));
  app.get(base, (context) =>
    execute(context, async () => {
      const params = new URL(context.req.url).searchParams;
      if (
        [...params.keys()].some((key) => key !== "cursor" && key !== "limit") ||
        params.getAll("cursor").length > 1 ||
        params.getAll("limit").length > 1
      ) {
        throw new TypeError("Unexpected query parameter");
      }
      const rawLimit = params.get("limit") ?? undefined;
      const limit = rawLimit === undefined ? 25 : Number(rawLimit);
      return options.service.getOutbox({
        cursor: params.get("cursor"),
        limit,
      });
    }),
  );
  app.post(`${base}/:exportId/revisions/:revision/ack`, (context) =>
    execute(context, async () => {
      const rawExportId = context.req.param("exportId");
      const revision = Number(context.req.param("revision"));
      if (
        !UUID.test(rawExportId) ||
        !Number.isSafeInteger(revision) ||
        revision <= 0
      ) {
        throw new TypeError("Invalid export revision path");
      }
      const body = ackBody(await requestJson(context));
      const response = await options.service.acknowledge({
        exportId: rawExportId,
        revision,
        payloadHash: body.payloadHash,
        idempotencyKey: body.idempotencyKey,
      });
      options.metrics.increment("export_total");
      return response;
    }),
  );
};

export const registerFindThatProjectReviewRoutes = (
  app: Hono<HealthBindings>,
  options: {
    readonly service: FindThatProjectExportService;
    readonly actorId: string;
  },
): void => {
  app.post(
    "/v1/exports/findthatproject/candidates/:discoveryId/review",
    (context) =>
      execute(context, async () => {
        const rawDiscoveryId = context.req.param("discoveryId");
        if (!UUID.test(rawDiscoveryId)) {
          throw new TypeError("Invalid Discovery ID");
        }
        const body = resolutionBody(await requestJson(context), false);
        const task = await options.service.requestReview({
          discoveryId: rawDiscoveryId,
          actorId: options.actorId,
          commandKey: body.commandKey,
          reason: body.reason,
        });
        return { task_id: task.id, state: task.state, version: task.version };
      }),
  );
  app.post("/v1/exports/findthatproject/reviews/:taskId/approve", (context) =>
    execute(context, async () => {
      const rawTaskId = context.req.param("taskId");
      if (!UUID.test(rawTaskId)) {
        throw new TypeError("Invalid review task ID");
      }
      const body = resolutionBody(await requestJson(context), true);
      const result = await options.service.approveReview({
        taskId: rawTaskId,
        expectedVersion: body.expectedVersion ?? 0,
        actorId: options.actorId,
        commandKey: body.commandKey,
        reason: body.reason,
      });
      return {
        task_id: result.task.id,
        state: result.task.state,
        version: result.task.version,
        export_id: result.revision.exportId,
        revision: result.revision.revision,
        payload_hash: result.revision.payloadHash,
      };
    }),
  );
};
