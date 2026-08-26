import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  FindThatProjectAckV1,
  FindThatProjectOutboxV1,
} from "@hn-knowledge/contracts";
import {
  discoveryId,
  exportId,
  reviewTaskId,
  type ExportOutboxRevision,
  type FindThatProjectIneligibilityCode,
  type ReviewTask,
} from "@hn-knowledge/domain";
import type {
  FindThatProjectExportRepository,
  Hasher,
} from "@hn-knowledge/ports";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COMMAND_KEY = /^[A-Za-z0-9._:-]{1,256}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const CURSOR_VERSION = 1;
const CURSOR_SCOPE = "findthatproject-outbox";

interface CursorPayload {
  readonly v: typeof CURSOR_VERSION;
  readonly scope: typeof CURSOR_SCOPE;
  readonly created_at: string;
  readonly id: string;
}

export class FindThatProjectExportError extends Error {
  constructor(
    readonly code:
      | "NOT_FOUND"
      | "INVALID_CURSOR"
      | "INVALID_STATE"
      | "VERSION_CONFLICT"
      | "IDEMPOTENCY_CONFLICT"
      | "INELIGIBLE"
      | "SNAPSHOT_CHANGED"
      | "ALREADY_CURRENT"
      | "PAYLOAD_HASH_MISMATCH",
    readonly details: {
      readonly currentVersion?: number;
      readonly currentState?: ReviewTask["state"];
      readonly reasons?: readonly FindThatProjectIneligibilityCode[];
    } = {},
  ) {
    super(code);
    this.name = "FindThatProjectExportError";
  }
}

export interface FindThatProjectExportService {
  readonly requestReview: (input: {
    readonly discoveryId: string;
    readonly actorId: string;
    readonly commandKey: string;
    readonly reason: string;
  }) => Promise<ReviewTask>;
  readonly approveReview: (input: {
    readonly taskId: string;
    readonly expectedVersion: number;
    readonly actorId: string;
    readonly commandKey: string;
    readonly reason: string;
  }) => Promise<{
    readonly task: ReviewTask;
    readonly revision: ExportOutboxRevision;
  }>;
  readonly getOutbox: (input: {
    readonly cursor: string | null;
    readonly limit: number;
  }) => Promise<FindThatProjectOutboxV1>;
  readonly acknowledge: (input: {
    readonly exportId: string;
    readonly revision: number;
    readonly payloadHash: string;
    readonly idempotencyKey: string;
  }) => Promise<FindThatProjectAckV1>;
}

const boundedText = (value: string, field: string, maximum: number): string => {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new TypeError(`${field} must contain 1 to ${maximum} characters`);
  }
  return normalized;
};

const commandKey = (value: string): string => {
  const normalized = value.trim();
  if (!COMMAND_KEY.test(normalized)) {
    throw new TypeError("commandKey is invalid");
  }
  return normalized;
};

const uuid = (value: string, field: string): string => {
  if (!UUID.test(value)) {
    throw new TypeError(`${field} must be a UUID`);
  }
  return value.toLowerCase();
};

const encoded = (value: string): string =>
  Buffer.from(value, "utf8").toString("base64url");

const signature = (payload: string, secret: string): Buffer =>
  createHmac("sha256", secret).update(payload, "utf8").digest();

const encodeCursor = (payload: CursorPayload, secret: string): string => {
  const body = encoded(JSON.stringify(payload));
  return `${body}.${signature(body, secret).toString("base64url")}`;
};

const decodeCursor = (
  value: string | null,
  secret: string,
): { readonly createdAt: Date; readonly id: string } | null => {
  if (value === null) {
    return null;
  }
  if (value.length > 8_192) {
    throw new FindThatProjectExportError("INVALID_CURSOR");
  }
  const [body, rawSignature, extra] = value.split(".");
  if (body === undefined || rawSignature === undefined || extra !== undefined) {
    throw new FindThatProjectExportError("INVALID_CURSOR");
  }
  const expected = signature(body, secret);
  const supplied = Buffer.from(rawSignature, "base64url");
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    throw new FindThatProjectExportError("INVALID_CURSOR");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new FindThatProjectExportError("INVALID_CURSOR");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 4
  ) {
    throw new FindThatProjectExportError("INVALID_CURSOR");
  }
  const cursor = parsed as Record<string, unknown>;
  if (
    cursor["v"] !== CURSOR_VERSION ||
    cursor["scope"] !== CURSOR_SCOPE ||
    typeof cursor["created_at"] !== "string" ||
    Number.isNaN(Date.parse(cursor["created_at"])) ||
    typeof cursor["id"] !== "string" ||
    !UUID.test(cursor["id"])
  ) {
    throw new FindThatProjectExportError("INVALID_CURSOR");
  }
  return { createdAt: new Date(cursor["created_at"]), id: cursor["id"] };
};

const requestHash = (
  hasher: Hasher,
  action: string,
  input: Readonly<Record<string, unknown>>,
): string => hasher.sha256(JSON.stringify({ action, ...input }));

export const createFindThatProjectExportService = (
  repository: FindThatProjectExportRepository,
  hasher: Hasher,
  options: {
    readonly cursorSecret: string;
    readonly consumerId?: string;
  },
): FindThatProjectExportService => {
  const cursorSecret = boundedText(options.cursorSecret, "cursorSecret", 1_024);
  const consumerId = boundedText(
    options.consumerId ?? "findthatproject-v1",
    "consumerId",
    128,
  );
  return {
    async requestReview(input) {
      const normalized = {
        discoveryId: uuid(input.discoveryId, "discoveryId"),
        actorId: boundedText(input.actorId, "actorId", 128),
        commandKey: commandKey(input.commandKey),
        reason: boundedText(input.reason, "reason", 1_000),
      };
      const result = await repository.requestReview({
        ...normalized,
        discoveryId: discoveryId(normalized.discoveryId),
        requestHash: requestHash(hasher, "REQUEST_EXPORT_REVIEW", normalized),
      });
      switch (result.kind) {
        case "OPENED":
          return result.task;
        case "NOT_FOUND":
          throw new FindThatProjectExportError("NOT_FOUND");
        case "INELIGIBLE":
          throw new FindThatProjectExportError("INELIGIBLE", {
            reasons: result.reasons,
          });
        case "ALREADY_CURRENT":
          throw new FindThatProjectExportError("ALREADY_CURRENT");
        case "IDEMPOTENCY_CONFLICT":
          throw new FindThatProjectExportError("IDEMPOTENCY_CONFLICT");
      }
    },

    async approveReview(input) {
      const normalized = {
        taskId: uuid(input.taskId, "taskId"),
        expectedVersion: input.expectedVersion,
        actorId: boundedText(input.actorId, "actorId", 128),
        commandKey: commandKey(input.commandKey),
        reason: boundedText(input.reason, "reason", 1_000),
      };
      if (
        !Number.isSafeInteger(normalized.expectedVersion) ||
        normalized.expectedVersion <= 0
      ) {
        throw new TypeError("expectedVersion must be positive");
      }
      const result = await repository.approveReview({
        ...normalized,
        taskId: reviewTaskId(normalized.taskId),
        requestHash: requestHash(hasher, "APPROVE_EXPORT_REVIEW", normalized),
      });
      switch (result.kind) {
        case "APPROVED":
          return { task: result.task, revision: result.revision };
        case "NOT_FOUND":
          throw new FindThatProjectExportError("NOT_FOUND");
        case "VERSION_CONFLICT":
          throw new FindThatProjectExportError("VERSION_CONFLICT", {
            currentVersion: result.currentVersion,
          });
        case "INVALID_STATE":
          throw new FindThatProjectExportError("INVALID_STATE", {
            currentState: result.state,
          });
        case "INELIGIBLE":
          throw new FindThatProjectExportError("INELIGIBLE", {
            reasons: result.reasons,
          });
        case "SNAPSHOT_CHANGED":
          throw new FindThatProjectExportError("SNAPSHOT_CHANGED");
        case "IDEMPOTENCY_CONFLICT":
          throw new FindThatProjectExportError("IDEMPOTENCY_CONFLICT");
      }
    },

    async getOutbox(input) {
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit <= 0 ||
        input.limit > 100
      ) {
        throw new TypeError("limit must be between 1 and 100");
      }
      const page = await repository.listPending(
        input.limit,
        decodeCursor(input.cursor, cursorSecret),
      );
      return {
        schema_version: "findthatproject.outbox.v1",
        items: page.items.map((item) => ({
          export_id: item.exportId,
          revision: item.revision,
          payload:
            item.payload as unknown as FindThatProjectOutboxV1["items"][number]["payload"],
          payload_hash: item.payloadHash,
          created_at: item.createdAt.toISOString(),
        })),
        next_cursor:
          page.nextAfter === null
            ? null
            : encodeCursor(
                {
                  v: CURSOR_VERSION,
                  scope: CURSOR_SCOPE,
                  created_at: page.nextAfter.createdAt.toISOString(),
                  id: page.nextAfter.id,
                },
                cursorSecret,
              ),
      };
    },

    async acknowledge(input) {
      const normalizedExportId = uuid(input.exportId, "exportId");
      if (!Number.isSafeInteger(input.revision) || input.revision <= 0) {
        throw new TypeError("revision must be positive");
      }
      if (!HASH.test(input.payloadHash)) {
        throw new TypeError("payloadHash must be a SHA-256 digest");
      }
      const normalizedCommandKey = commandKey(input.idempotencyKey);
      const result = await repository.acknowledge({
        exportId: exportId(normalizedExportId),
        revision: input.revision,
        payloadHash: input.payloadHash,
        idempotencyKey: normalizedCommandKey,
        consumerId,
      });
      switch (result.kind) {
        case "ACKNOWLEDGED":
          return {
            schema_version: "findthatproject.ack.v1",
            export_id: normalizedExportId,
            revision: input.revision,
            acknowledged: true,
            replayed: result.replayed,
          };
        case "NOT_FOUND":
          throw new FindThatProjectExportError("NOT_FOUND");
        case "PAYLOAD_HASH_MISMATCH":
          throw new FindThatProjectExportError("PAYLOAD_HASH_MISMATCH");
        case "IDEMPOTENCY_CONFLICT":
          throw new FindThatProjectExportError("IDEMPOTENCY_CONFLICT");
      }
    },
  };
};
