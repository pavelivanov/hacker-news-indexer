import { describe, expect, it, vi } from "vitest";

import { createApp, type SafeLogger } from "@hn-knowledge/api";

const createTestLogger = (): SafeLogger => ({ error: vi.fn() });

describe("API health and safe errors", () => {
  it("returns the exact dependency-free health response", async () => {
    const checkReadiness = vi.fn<() => Promise<void>>();
    const app = createApp({ checkReadiness, logger: createTestLogger() });

    const response = await app.request("/healthz");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(checkReadiness).not.toHaveBeenCalled();
  });

  it("returns a safe 404 with a correlation ID", async () => {
    const app = createApp({
      checkReadiness: () => Promise.resolve(),
      logger: createTestLogger(),
    });

    const response = await app.request("/missing", {
      headers: { "x-request-id": "test-request-1" },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("x-request-id")).toBe("test-request-1");
    expect(await response.json()).toEqual({
      error: "not_found",
      requestId: "test-request-1",
    });
  });

  it("does not expose errors, stacks, or source bodies", async () => {
    const logger = createTestLogger();
    const app = createApp({
      checkReadiness: () => Promise.resolve(),
      logger,
    });
    app.get("/explode", () => {
      throw new Error("sensitive source body and stack marker");
    });

    const response = await app.request("/explode", {
      headers: { "x-request-id": "safe-id" },
    });
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get("x-request-id")).toBe("safe-id");
    expect(JSON.parse(body)).toEqual({
      error: "internal_error",
      requestId: "safe-id",
    });
    expect(body).not.toContain("sensitive source body");
    expect(body).not.toContain("stack");
    const errorMock = vi.mocked(logger.error);
    expect(errorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        errorName: "Error",
        requestId: "safe-id",
      }),
      "Request failed",
    );
    expect(JSON.stringify(errorMock.mock.calls)).not.toContain(
      "sensitive source body",
    );
  });

  it("replaces unsafe incoming correlation IDs", async () => {
    const app = createApp({
      checkReadiness: () => Promise.resolve(),
      logger: createTestLogger(),
    });

    const response = await app.request("/healthz", {
      headers: { "x-request-id": "invalid id with spaces" },
    });

    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
  });
});
