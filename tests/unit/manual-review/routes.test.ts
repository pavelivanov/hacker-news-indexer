import { describe, expect, it, vi } from "vitest";
import { createApp } from "@hn-knowledge/api";
import { createManualReviewService } from "@hn-knowledge/application";
import { ManualReviewError } from "@hn-knowledge/domain";

const id = "00000000-0000-4000-8000-000000000123";
const setup = () => {
  const service = createManualReviewService(
    {
      run: async () => {
        throw new Error("Unexpected database call");
      },
    },
    { sha256: (value) => value },
    { actorId: "owner", cursorSecret: "fixture" },
  );
  const logger = { error: vi.fn() };
  const app = createApp({
    apiToken: "fixture-token",
    manualReviewService: service,
    logger,
  });
  return { service, app, logger };
};
const command = {
  expected_version: 1,
  source_hash: "a".repeat(64),
  command_key: "test",
  reason: "Reviewed",
};
const headers = {
  authorization: "Bearer fixture-token",
  "content-type": "application/json",
};

describe("manual review routes", () => {
  it.each([
    ["GET", "/v1/manual-review/inbox"],
    ["GET", "/v1/manual-review/comments/1"],
    ["POST", "/v1/manual-review/comments/1/draft"],
    ["PUT", `/v1/manual-review/drafts/${id}`],
    ["POST", `/v1/manual-review/drafts/${id}/rebase`],
    ["POST", `/v1/manual-review/drafts/${id}/approve`],
    ["POST", `/v1/manual-review/drafts/${id}/reject`],
  ])("authenticates %s %s before service access", async (method, path) => {
    const { app } = setup();
    expect((await app.request(path, { method })).status).toBe(401);
  });
  it.each([
    ["GET", "/v1/manual-review/comments/nope", undefined],
    ["GET", "/v1/manual-review/inbox?state=all&state=draft", undefined],
    ["GET", "/v1/manual-review/inbox?unknown=1", undefined],
    ["POST", `/v1/manual-review/drafts/${id}/approve`, "{"],
    [
      "POST",
      `/v1/manual-review/drafts/${id}/approve`,
      JSON.stringify({ ...command, actor_id: "spoofed" }),
    ],
    [
      "PUT",
      `/v1/manual-review/drafts/${id}`,
      JSON.stringify({
        expected_version: 1,
        source_hash: "a".repeat(64),
        payload: { unknown: true },
      }),
    ],
  ])("rejects malformed requests %s %s", async (method, path, body) => {
    const { app } = setup();
    expect(
      (
        await app.request(path, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
        })
      ).status,
    ).toBe(400);
  });
  it.each([
    ["NOT_FOUND", 404],
    ["VERSION_CONFLICT", 409],
    ["SOURCE_CONFLICT", 409],
    ["OUTPUT_INVALID", 422],
  ] as const)("maps %s to %s", async (code, status) => {
    const { app, service } = setup();
    vi.spyOn(service, "finalize").mockRejectedValue(
      new ManualReviewError(code),
    );
    expect(
      (
        await app.request(`/v1/manual-review/drafts/${id}/approve`, {
          method: "POST",
          headers,
          body: JSON.stringify(command),
        })
      ).status,
    ).toBe(status);
  });
  it("sanitizes unexpected errors", async () => {
    const { app, service } = setup();
    vi.spyOn(service, "finalize").mockRejectedValue(
      new Error("private internal detail"),
    );
    const response = await app.request(
      `/v1/manual-review/drafts/${id}/approve`,
      { method: "POST", headers, body: JSON.stringify(command) },
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private internal detail");
  });
  it("bounds the request body before parsing or saving it", async () => {
    const { app } = setup();
    const response = await app.request(`/v1/manual-review/drafts/${id}`, {
      method: "PUT",
      headers,
      body: " ".repeat(131_073),
    });
    expect(response.status).toBe(400);
  });
});
