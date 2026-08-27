import { describe, expect, it } from "vitest";

import {
  evaluateOperationalAlerts,
  type OperationalLogEvent,
  type OperationalSnapshot,
} from "@hn-knowledge/config";

const NOW = "2026-08-27T15:00:00.000Z";

const required = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new TypeError("Expected fixture value");
  }
  return value;
};

const event = (
  name: string,
  overrides: Partial<OperationalLogEvent> = {},
): OperationalLogEvent => ({
  event: name,
  timestamp: "2026-08-27T14:59:00.000Z",
  state: null,
  jobType: null,
  errorCode: null,
  durationMs: null,
  ...overrides,
});

const healthySnapshot = (): OperationalSnapshot => ({
  checkedAt: NOW,
  services: {
    api: "SUCCESS",
    worker: "SUCCESS",
    scheduler: "SUCCESS",
    postgres: "SUCCESS",
  },
  api: {
    health: true,
    ready: true,
    metricsAvailable: true,
    reviewQueueDepth: 0,
    reviewOldestAgeSeconds: 0,
    feedRootConcentration: 0,
  },
  workerEvents: [event("worker_heartbeat")],
  schedulerEvents: [event("reconciliation_schedule_completed")],
  resources: {
    api: {
      cpuTenMinuteFloorPercent: 0.1,
      memoryTenMinuteFloorPercent: 0.5,
      volumeMaxUtilizationPercent: null,
    },
    worker: {
      cpuTenMinuteFloorPercent: 0.1,
      memoryTenMinuteFloorPercent: 0.7,
      volumeMaxUtilizationPercent: 1.7,
    },
    postgres: {
      cpuTenMinuteFloorPercent: 0.1,
      memoryTenMinuteFloorPercent: 0.3,
      volumeMaxUtilizationPercent: 3.1,
    },
  },
  database: {
    runnableDepth: 0,
    oldestRunnableAgeSeconds: 0,
    expiredLeaseCount: 0,
    terminalCount: 0,
    recentClassificationCount: 0,
    recentClassificationSchemaErrors: 0,
    classificationP95Seconds: null,
    recentExportFailures: 0,
  },
});

const evaluate = (snapshot: OperationalSnapshot) =>
  evaluateOperationalAlerts(snapshot, {
    requireScheduler: true,
    terminalBaseline: 0,
  });

describe("operational alert policy", () => {
  it("accepts a healthy, current, empty personal-scale snapshot", () => {
    expect(evaluate(healthySnapshot())).toEqual([]);
  });

  it("detects readiness loss, stalled queue state, and expired leases", () => {
    const snapshot = healthySnapshot();
    const alerts = evaluate({
      ...snapshot,
      api: { ...snapshot.api, ready: false },
      database: {
        ...snapshot.database,
        runnableDepth: 11,
        oldestRunnableAgeSeconds: 901,
        expiredLeaseCount: 1,
      },
    });

    expect(alerts.map((alert) => alert.code)).toEqual(
      expect.arrayContaining([
        "api_readiness_failed",
        "pipeline_queue_stalled",
        "pipeline_expired_leases",
      ]),
    );
  });

  it("detects missing services, stale worker heartbeat, and stale scheduler completion", () => {
    const snapshot = healthySnapshot();
    const alerts = evaluate({
      ...snapshot,
      services: { api: "SUCCESS", worker: "CRASHED", postgres: "SUCCESS" },
      workerEvents: [
        event("worker_heartbeat", {
          timestamp: "2026-08-27T14:56:59.000Z",
        }),
      ],
      schedulerEvents: [],
    });

    expect(alerts.map((alert) => alert.code)).toEqual(
      expect.arrayContaining([
        "service_missing",
        "service_unhealthy",
        "worker_heartbeat_stale",
        "scheduler_completion_stale",
      ]),
    );
  });

  it("allows a worker startup grace without masking restart loops", () => {
    const snapshot = healthySnapshot();
    const recentStart = event("worker_started", {
      timestamp: "2026-08-27T14:59:30.000Z",
    });

    expect(
      evaluate({
        ...snapshot,
        workerEvents: [recentStart],
      }).map((alert) => alert.code),
    ).not.toContain("worker_heartbeat_stale");

    const alerts = evaluate({
      ...snapshot,
      workerEvents: [
        recentStart,
        event("worker_started", {
          timestamp: "2026-08-27T14:58:30.000Z",
        }),
        event("worker_started", {
          timestamp: "2026-08-27T14:57:30.000Z",
        }),
      ],
    });
    expect(alerts.map((alert) => alert.code)).toContain("worker_restart_loop");
    expect(alerts.map((alert) => alert.code)).not.toContain(
      "worker_heartbeat_stale",
    );
  });

  it("alerts when a worker never heartbeats after startup grace", () => {
    const snapshot = healthySnapshot();
    const alerts = evaluate({
      ...snapshot,
      workerEvents: [
        event("worker_started", {
          timestamp: "2026-08-27T14:56:59.000Z",
        }),
      ],
    });

    expect(alerts.map((alert) => alert.code)).toContain(
      "worker_heartbeat_stale",
    );
  });

  it("alerts only after retryable failures become sustained", () => {
    const snapshot = healthySnapshot();
    const oneRetry = event("pipeline_job_finished", {
      state: "RETRYABLE",
      jobType: "RESOLVE_HN_COMMENT",
      errorCode: "UPSTREAM_TIMEOUT",
    });
    expect(
      evaluate({
        ...snapshot,
        workerEvents: [event("worker_heartbeat"), oneRetry],
      }).map((alert) => alert.code),
    ).not.toContain("pipeline_failures_sustained");

    const alerts = evaluate({
      ...snapshot,
      workerEvents: [
        event("worker_heartbeat"),
        oneRetry,
        { ...oneRetry, timestamp: "2026-08-27T14:58:00.000Z" },
        { ...oneRetry, timestamp: "2026-08-27T14:57:00.000Z" },
      ],
    });
    expect(alerts.map((alert) => alert.code)).toContain(
      "pipeline_failures_sustained",
    );
  });

  it("detects classifier schema failures, latency, aged review, and export failures", () => {
    const snapshot = healthySnapshot();
    const alerts = evaluate({
      ...snapshot,
      api: {
        ...snapshot.api,
        reviewQueueDepth: 4,
        reviewOldestAgeSeconds: 7 * 24 * 60 * 60 + 1,
      },
      database: {
        ...snapshot.database,
        recentClassificationCount: 5,
        recentClassificationSchemaErrors: 1,
        classificationP95Seconds: 61,
        recentExportFailures: 1,
      },
    });

    expect(alerts.map((alert) => alert.code)).toEqual(
      expect.arrayContaining([
        "classification_schema_invalid",
        "classification_latency_high",
        "review_backlog_aged",
        "export_delivery_failed",
      ]),
    );
  });

  it("detects sustained resource pressure and volume capacity risk", () => {
    const snapshot = healthySnapshot();
    const alerts = evaluate({
      ...snapshot,
      resources: {
        ...snapshot.resources,
        api: {
          ...required(snapshot.resources["api"]),
          cpuTenMinuteFloorPercent: 85.1,
        },
        worker: {
          ...required(snapshot.resources["worker"]),
          memoryTenMinuteFloorPercent: 90,
        },
        postgres: {
          ...required(snapshot.resources["postgres"]),
          volumeMaxUtilizationPercent: 80.1,
        },
      },
    });

    expect(alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "service_cpu_sustained_high",
          context: { serviceName: "api", utilizationPercent: 85.1 },
        }),
        expect.objectContaining({
          code: "service_memory_sustained_high",
          context: { serviceName: "worker", utilizationPercent: 90 },
        }),
        expect.objectContaining({
          code: "service_volume_high",
          context: { serviceName: "postgres", utilizationPercent: 80.1 },
        }),
      ]),
    );
  });

  it("never copies an error code or payload-like value into alert output", () => {
    const secretMarker = "fixture-secret-payload-marker";
    const snapshot = healthySnapshot();
    const alerts = evaluate({
      ...snapshot,
      workerEvents: [
        event("worker_heartbeat"),
        event("pipeline_job_finished", {
          state: "TERMINAL",
          jobType: "CLASSIFY_COMMENT",
          errorCode: secretMarker,
        }),
      ],
    });

    expect(alerts.map((alert) => alert.code)).toContain(
      "pipeline_terminal_job",
    );
    expect(JSON.stringify(alerts)).not.toContain(secretMarker);
  });
});
