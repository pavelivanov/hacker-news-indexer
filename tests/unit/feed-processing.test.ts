import { describe, expect, it, vi } from "vitest";
import { createApp } from "@hn-knowledge/api";
import { createFeedProcessingService } from "@hn-knowledge/application";
import { parseFeedControlV1, parseFeedRetryV1 } from "@hn-knowledge/contracts";
import { FeedProcessingError } from "@hn-knowledge/domain";
const repository = { status: vi.fn(), control: vi.fn(), retry: vi.fn() };
const service = createFeedProcessingService(repository);
const app = createApp({
  apiToken: "fixture",
  feedProcessingService: service,
  logger: { error: vi.fn() },
});
const headers = {
  authorization: "Bearer fixture",
  "content-type": "application/json",
};
const id = "11111111-1111-4111-8111-111111111111";
describe("feed processing boundary", () => {
  it.each([
    ["GET", "/v1/processing"],
    ["POST", "/v1/processing/control"],
    ["POST", `/v1/processing/jobs/${id}/retry`],
    ["POST", `/v1/processing/results/${id}/retry`],
  ])("authenticates %s %s", async (method, path) => {
    expect((await app.request(path, { method })).status).toBe(401);
  });
  it("rejects arbitrary job bodies, unknown controls and oversized keys", () => {
    expect(parseFeedControlV1({ action: "pause" })).toEqual({
      action: "pause",
    });
    for (const value of [
      { action: "execute" },
      { action: "sync", source: "arbitrary" },
    ])
      expect(() => parseFeedControlV1(value)).toThrow();
    for (const value of [
      { command_key: "" },
      { command_key: "a".repeat(161) },
      { command_key: "x", actor: "other" },
    ])
      expect(() => parseFeedRetryV1(value)).toThrow();
  });
  it("bounds request bodies, validates identifiers and rejects unknown query fields", async () => {
    expect(
      (await app.request("/v1/processing?source=arbitrary", { headers }))
        .status,
    ).toBe(400);
    expect(
      (
        await app.request("/v1/processing/jobs/not-id/retry", {
          method: "POST",
          headers,
          body: '{"command_key":"test"}',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request("/v1/processing/control", {
          method: "POST",
          headers,
          body: JSON.stringify({ action: "x".repeat(140000) }),
        })
      ).status,
    ).toBe(400);
  });
  it("returns safe conflicts and delegates only the validated command", async () => {
    repository.retry.mockRejectedValueOnce(
      new FeedProcessingError("STATE_CONFLICT"),
    );
    const response = await app.request(`/v1/processing/jobs/${id}/retry`, {
      method: "POST",
      headers,
      body: '{"command_key":"fixture-retry"}',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "state_conflict" });
    expect(repository.retry).toHaveBeenLastCalledWith(
      "job",
      id,
      "fixture-retry",
    );
  });
});
