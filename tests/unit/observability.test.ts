import { describe, expect, it, vi } from "vitest";

import {
  createPipelineMetrics,
  PIPELINE_METRIC_NAMES,
  redactLogFields,
} from "@hn-knowledge/config";
import { createApp, type SafeLogger } from "@hn-knowledge/api";

const logger: SafeLogger = { error: vi.fn() };

describe("pipeline metrics", () => {
  it("exports every required metric and records counters, gauges, and histograms", () => {
    const metrics = createPipelineMetrics();
    metrics.increment("ingestion_messages_total", 3);
    metrics.increment("pipeline_failure_total");
    metrics.set("review_queue_depth", 7);
    metrics.observe("hn_resolution_depth", 4);
    metrics.observe("classification_latency_seconds", 1.25);

    const output = metrics.render();

    for (const name of PIPELINE_METRIC_NAMES) {
      expect(output).toContain(`# HELP ${name} `);
      expect(output).toContain(`# TYPE ${name} `);
    }
    expect(output).toContain("ingestion_messages_total 3");
    expect(output).toContain("review_queue_depth 7");
    expect(output).toContain("hn_resolution_depth_count 1");
    expect(output).toContain("classification_latency_seconds_sum 1.25");
  });

  it("protects the metrics route and refreshes review queue gauges", async () => {
    const token = "metrics-test-token";
    const metrics = createPipelineMetrics();
    const measureReviewQueue = vi.fn(async () => ({
      depth: 12,
      oldestAgeSeconds: 45,
    }));
    const app = createApp({
      apiToken: token,
      logger,
      metrics,
      measureReviewQueue,
    });

    expect((await app.request("/metrics")).status).toBe(401);
    expect(measureReviewQueue).not.toHaveBeenCalled();

    const response = await app.request("/metrics", {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(body).toContain("review_queue_depth 12");
    expect(body).toContain("review_queue_oldest_age_seconds 45");
    expect(measureReviewQueue).toHaveBeenCalledOnce();
  });
});

describe("safe structured logs", () => {
  it("redacts source bodies, prompts, credentials, sessions, database URLs, and URL queries", () => {
    const markers = [
      "fixture-comment-body-marker",
      "fixture-prompt-marker",
      "fixture-password-marker",
      "fixture-session-marker",
      "database-password-marker",
      "query-secret-marker",
    ];
    const redacted = redactLogFields({
      event: "fixture_event",
      commentBody: markers[0],
      prompt: markers[1],
      credentials: { password: markers[2] },
      nested: { session: markers[3] },
      detail: `postgresql://owner:${markers[4]}@db.example/app`,
      sourceUrl: `https://example.com/path?token=${markers[5]}`,
      jobId: "safe-job-id",
    });
    const serialized = JSON.stringify(redacted);

    for (const marker of markers) {
      expect(serialized).not.toContain(marker);
    }
    expect(redacted).toMatchObject({
      event: "fixture_event",
      jobId: "safe-job-id",
    });
  });
});
