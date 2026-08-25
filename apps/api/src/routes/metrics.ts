import type { PipelineMetrics } from "@hn-knowledge/config";
import type { Hono } from "hono";

import { createBearerAuth } from "../middleware/bearer-auth.js";
import type { HealthBindings } from "./health.js";

export interface ReviewQueueMeasurement {
  readonly depth: number;
  readonly oldestAgeSeconds: number;
}

export interface RegisterMetricsRouteOptions {
  readonly apiToken: string | undefined;
  readonly metrics: PipelineMetrics;
  readonly measureReviewQueue: () => Promise<ReviewQueueMeasurement>;
}

export const registerMetricsRoute = (
  app: Hono<HealthBindings>,
  options: RegisterMetricsRouteOptions,
): void => {
  app.use("/metrics", createBearerAuth(options.apiToken));
  app.get("/metrics", async (context) => {
    const queue = await options.measureReviewQueue();
    options.metrics.set("review_queue_depth", queue.depth);
    options.metrics.set(
      "review_queue_oldest_age_seconds",
      queue.oldestAgeSeconds,
    );
    return context.text(options.metrics.render(), 200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "cache-control": "no-store",
    });
  });
};
