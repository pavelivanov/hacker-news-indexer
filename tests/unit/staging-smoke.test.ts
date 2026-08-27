import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type RequestListener, type Server } from "node:http";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(
  new URL("../../scripts/staging-smoke.mjs", import.meta.url),
);

interface ProcessResult {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

const runSmoke = async (
  baseUrl: string,
  token: string,
): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, baseUrl], {
      env: { ...process.env, APP_API_TOKEN: token },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code, stderr, stdout });
    });
  });

const listen = async (
  handler: RequestListener,
): Promise<{ readonly baseUrl: string; readonly server: Server }> => {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not expose a TCP address");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
};

const close = async (server: Server): Promise<void> => {
  server.close();
  await once(server, "close");
};

const json = (
  response: Parameters<RequestListener>[1],
  body: unknown,
): void => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
};

describe("staging smoke command", () => {
  it("checks public health, fail-closed auth, and safe authenticated metrics", async () => {
    const token = "staging-smoke-test-secret-0123456789abcdef";
    const requests: Array<{
      readonly authorization: string | undefined;
      readonly url: string | undefined;
    }> = [];
    const { baseUrl, server } = await listen((request, response) => {
      requests.push({
        authorization: request.headers.authorization,
        url: request.url,
      });
      if (request.url === "/healthz" || request.url === "/readyz") {
        json(response, { status: "ok" });
        return;
      }
      if (
        request.url === "/metrics" &&
        request.headers.authorization === `Bearer ${token}`
      ) {
        response.setHeader("content-type", "text/plain; charset=utf-8");
        response.end(
          [
            "pipeline_failure_total 0",
            "review_queue_depth 0",
            "review_queue_oldest_age_seconds 0",
            'classification_latency_seconds_bucket{le="0.1"} 0',
            'classification_latency_seconds_bucket{le="+Inf"} 0',
            "",
          ].join("\n"),
        );
        return;
      }
      response.statusCode = 401;
      json(response, { error: "unauthorized" });
    });

    try {
      const result = await runSmoke(baseUrl, token);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain(token);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        origin: baseUrl,
        checks: [
          "healthz",
          "readyz",
          "metrics_unauthorized",
          "v1_unauthorized",
          "metrics_authenticated_safe",
        ],
      });
      expect(requests).toEqual([
        { authorization: undefined, url: "/healthz" },
        { authorization: undefined, url: "/readyz" },
        { authorization: undefined, url: "/metrics" },
        {
          authorization: undefined,
          url: "/v1/feed?kind=discovery",
        },
        { authorization: `Bearer ${token}`, url: "/metrics" },
      ]);
    } finally {
      await close(server);
    }
  });

  it("fails without printing a secret leaked by the metrics response", async () => {
    const token = "must-never-be-printed-0123456789abcdef";
    const { baseUrl, server } = await listen((request, response) => {
      if (request.url === "/healthz" || request.url === "/readyz") {
        json(response, { status: "ok" });
        return;
      }
      if (
        request.url === "/metrics" &&
        request.headers.authorization === `Bearer ${token}`
      ) {
        response.setHeader("content-type", "text/plain");
        response.end(
          `pipeline_failure_total 0\nreview_queue_depth 0\nreview_queue_oldest_age_seconds 0\n${token}\n`,
        );
        return;
      }
      response.statusCode = 401;
      json(response, { error: "unauthorized" });
    });

    try {
      const result = await runSmoke(baseUrl, token);

      expect(result.code).toBe(1);
      expect(`${result.stdout}${result.stderr}`).not.toContain(token);
      expect(result.stderr).toContain(
        "Authenticated metrics response contains sensitive material",
      );
    } finally {
      await close(server);
    }
  });

  it("rejects a short token without printing it or making a request", async () => {
    const token = "short-private-value";
    const result = await runSmoke("http://127.0.0.1:9", token);

    expect(result.code).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
    expect(result.stderr).toContain(
      "APP_API_TOKEN must contain at least 32 non-whitespace characters",
    );
  });
});
