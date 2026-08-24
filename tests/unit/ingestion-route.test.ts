import { describe, expect, it, vi } from "vitest";

import { createApp, type SafeLogger } from "@hn-knowledge/api";
import {
  ingestionRunId,
  pipelineJobId,
  telegramMessageId,
} from "@hn-knowledge/domain";

const token = "test-ingestion-token";
const logger: SafeLogger = { error: vi.fn() };
const now = new Date("2026-08-24T12:00:00.000Z");

const runId = ingestionRunId("00000000-0000-4000-8000-000000000001");
const jobId = pipelineJobId("00000000-0000-4000-8000-000000000002");

const result = {
  created: true,
  run: {
    id: runId,
    requestKey: "stable-request-key",
    range: {
      source: "TELEGRAM" as const,
      sourceKey: "hn_best_comments",
      minId: telegramMessageId(32_847),
      maxId: telegramMessageId(32_946),
    },
    status: "PENDING" as const,
    startedAt: null,
    completedAt: null,
  },
  job: {
    id: jobId,
    ingestionRunId: runId,
    type: "INGEST_SELECTION_RANGE" as const,
    payload: {},
    idempotencyKey: "ingest-range:stable-request-key",
    state: "AVAILABLE" as const,
    attempts: 0,
    availableAt: now,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
  },
};

const validBody = {
  source: "TELEGRAM",
  source_key: "hn_best_comments",
  min_id: 32_847,
  max_id: 32_946,
};

const post = (
  app: ReturnType<typeof createApp>,
  body: unknown,
  authorization?: string,
) =>
  app.request("/v1/ingestion-runs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: JSON.stringify(body),
  });

describe("ingestion control route", () => {
  it("rejects missing and incorrect bearer tokens", async () => {
    const startIngestion = vi.fn(async () => result);
    const app = createApp({ apiToken: token, logger, startIngestion });

    const missing = await post(app, validBody);
    const wrong = await post(app, validBody, "Bearer wrong-token");

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await missing.json()).toMatchObject({ error: "unauthorized" });
    expect(await wrong.json()).toMatchObject({ error: "unauthorized" });
    expect(startIngestion).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...validBody, min_id: 0 }],
    [{ ...validBody, min_id: 40_000, max_id: 39_999 }],
    [{ ...validBody, max_id: 33_847 }],
    [{ ...validBody, unexpected: true }],
    [{ ...validBody, source: "UNKNOWN" }],
  ])("rejects an invalid or oversized range", async (body) => {
    const startIngestion = vi.fn(async () => result);
    const app = createApp({
      apiToken: token,
      logger,
      maxIngestionRange: 1_000,
      startIngestion,
    });

    const response = await post(app, body, `Bearer ${token}`);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(startIngestion).not.toHaveBeenCalled();
  });

  it("accepts a strict request and returns the same logical run on replay", async () => {
    const startIngestion = vi.fn(async () => result);
    const app = createApp({ apiToken: token, logger, startIngestion });

    const first = await post(app, validBody, `Bearer ${token}`);
    const second = await post(app, validBody, `Bearer ${token}`);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(first.headers.get("location")).toBe(`/v1/ingestion-runs/${runId}`);
    expect(await first.json()).toEqual({ run_id: runId, status: "PENDING" });
    expect(await second.json()).toEqual({ run_id: runId, status: "PENDING" });
    expect(startIngestion).toHaveBeenCalledTimes(2);
    expect(startIngestion).toHaveBeenNthCalledWith(1, {
      source: "TELEGRAM",
      sourceKey: "hn_best_comments",
      minId: 32_847,
      maxId: 32_946,
    });
  });
});
