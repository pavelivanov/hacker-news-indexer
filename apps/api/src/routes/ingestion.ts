import type { StartIngestion } from "@hn-knowledge/application";
import {
  SELECTION_SOURCES,
  telegramMessageId,
  type SelectionSourceKind,
} from "@hn-knowledge/domain";
import type { Hono } from "hono";

import type { HealthBindings } from "./health.js";

interface RegisterIngestionRoutesOptions {
  readonly maxRange: number;
  readonly startIngestion: StartIngestion;
}

interface IngestionRequest {
  readonly source: SelectionSourceKind;
  readonly sourceKey: string;
  readonly minId: number;
  readonly maxId: number;
}

const requestKeys = ["source", "source_key", "min_id", "max_id"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const parseRequest = (value: unknown, maxRange: number): IngestionRequest => {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== requestKeys.length ||
    !Object.keys(value).every((key) =>
      requestKeys.includes(key as (typeof requestKeys)[number]),
    )
  ) {
    throw new TypeError("Request body has unexpected fields");
  }

  const source = value["source"];
  const rawSourceKey = value["source_key"];
  const minId = value["min_id"];
  const maxId = value["max_id"];
  const sourceKey = typeof rawSourceKey === "string" ? rawSourceKey.trim() : "";

  if (
    typeof source !== "string" ||
    !SELECTION_SOURCES.includes(source as SelectionSourceKind) ||
    sourceKey.length === 0 ||
    sourceKey.length > 128 ||
    typeof minId !== "number" ||
    !Number.isSafeInteger(minId) ||
    minId <= 0 ||
    typeof maxId !== "number" ||
    !Number.isSafeInteger(maxId) ||
    maxId < minId ||
    maxId - minId + 1 > maxRange
  ) {
    throw new TypeError("Request body is invalid");
  }

  return {
    source: source as SelectionSourceKind,
    sourceKey,
    minId,
    maxId,
  };
};

export const registerIngestionRoutes = (
  app: Hono<HealthBindings>,
  options: RegisterIngestionRoutesOptions,
): void => {
  app.post("/v1/ingestion-runs", async (context) => {
    let request: IngestionRequest;
    try {
      request = parseRequest(
        await context.req.json<unknown>(),
        options.maxRange,
      );
    } catch {
      return context.json(
        {
          error: "invalid_request" as const,
          requestId: context.get("requestId"),
        },
        400,
      );
    }

    const result = await options.startIngestion({
      source: request.source,
      sourceKey: request.sourceKey,
      minId: telegramMessageId(request.minId),
      maxId: telegramMessageId(request.maxId),
    });

    context.header("location", `/v1/ingestion-runs/${result.run.id}`);
    return context.json(
      {
        run_id: result.run.id,
        status: result.run.status,
      },
      202,
    );
  });
};
