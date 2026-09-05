import { describe, expect, it, vi } from "vitest";
import { createApp } from "@hn-knowledge/api";
import { parseClassifierFeedbackV1 } from "@hn-knowledge/contracts";
import { createClassifierResultsService } from "@hn-knowledge/application";
import { ClassifierResultsError } from "@hn-knowledge/domain";

const request = {
  expected_version: 0,
  command_key: "test",
  category: "EXPERT_NOTE",
  title: "Corrected title",
  summary: "Corrected explanation",
  issue: "INACCURATE_SUMMARY",
  explanation: "",
};
const id = "11111111-1111-4111-8111-111111111111";
const service = createClassifierResultsService(
  {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    capture: vi.fn(),
    correct: vi.fn(),
  },
  { sha256: (value) => value },
  { actorId: "owner", cursorSecret: "test-only" },
);
const app = createApp({
  apiToken: "test-only",
  classifierResultsService: service,
  logger: { error: vi.fn() },
});
const headers = {
  authorization: "Bearer test-only",
  "content-type": "application/json",
};
describe("classifier feedback contracts and routes", () => {
  it("allows optional explanations and requires useful text for retained categories", () => {
    expect(parseClassifierFeedbackV1(request)).toEqual(request);
    expect(() =>
      parseClassifierFeedbackV1({ ...request, summary: " " }),
    ).toThrow();
    expect(
      parseClassifierFeedbackV1({
        ...request,
        category: "REJECTED",
        title: "",
        summary: "",
      }).category,
    ).toBe("REJECTED");
    for (const invalid of [
      { actor_id: "spoofed" },
      { title: "x".repeat(241) },
      { expected_version: -1 },
      { issue: "unknown" },
    ])
      expect(() =>
        parseClassifierFeedbackV1({ ...request, ...invalid }),
      ).toThrow();
  });
  it.each([
    ["GET", "/v1/classifier-results"],
    ["GET", `/v1/classifier-results/${id}`],
    ["POST", `/v1/classifier-results/${id}/corrections`],
  ])("authenticates %s %s", async (method, path) => {
    expect((await app.request(path, { method })).status).toBe(401);
  });
  it("rejects invalid paths, unknown query fields, and oversized correction bodies", async () => {
    for (const path of [
      "/v1/classifier-results?filter=invalid",
      "/v1/classifier-results?actor=spoof",
      "/v1/classifier-results/no-id",
    ])
      expect((await app.request(path, { headers })).status).toBe(400);
    expect(
      (
        await app.request(`/v1/classifier-results/${id}/corrections`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...request, explanation: "x".repeat(140000) }),
        })
      ).status,
    ).toBe(400);
  });
  it("returns conflicts without exposing internal data", async () => {
    vi.spyOn(service, "correct").mockRejectedValue(
      new ClassifierResultsError("VERSION_CONFLICT"),
    );
    const response = await app.request(
      `/v1/classifier-results/${id}/corrections`,
      { method: "POST", headers, body: JSON.stringify(request) },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "version_conflict" });
  });
});
