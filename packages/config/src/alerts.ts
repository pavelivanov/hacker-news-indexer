const EXPECTED_SERVICE_NAMES = [
  "api",
  "worker",
  "scheduler",
  "postgres",
] as const;
const KNOWN_DEPLOYMENT_STATUSES = new Set([
  "BUILDING",
  "CRASHED",
  "DEPLOYING",
  "FAILED",
  "REMOVED",
  "SKIPPED",
  "SUCCESS",
  "WAITING",
]);
const WORKER_LIVENESS_GRACE_SECONDS = 180;
const RESOURCE_SERVICE_NAMES = ["api", "worker", "postgres"] as const;
const RESOURCE_UTILIZATION_ALERT_PERCENT = 85;
const VOLUME_UTILIZATION_ALERT_PERCENT = 80;

export type OperationalAlertSeverity = "P2" | "P3";

export interface OperationalLogEvent {
  readonly event: string;
  readonly timestamp: string;
  readonly state: string | null;
  readonly jobType: string | null;
  readonly errorCode: string | null;
  readonly durationMs: number | null;
}

export interface OperationalResourceSignal {
  readonly cpuTenMinuteFloorPercent: number | null;
  readonly memoryTenMinuteFloorPercent: number | null;
  readonly volumeMaxUtilizationPercent: number | null;
}

export interface OperationalSnapshot {
  readonly checkedAt: string;
  readonly services: Readonly<Record<string, string>>;
  readonly api: {
    readonly health: boolean;
    readonly ready: boolean;
    readonly metricsAvailable: boolean;
    readonly reviewQueueDepth: number;
    readonly reviewOldestAgeSeconds: number;
    readonly feedRootConcentration: number;
  };
  readonly workerEvents: readonly OperationalLogEvent[];
  readonly schedulerEvents: readonly OperationalLogEvent[];
  readonly resources: Readonly<Record<string, OperationalResourceSignal>>;
  readonly database: {
    readonly runnableDepth: number;
    readonly oldestRunnableAgeSeconds: number;
    readonly expiredLeaseCount: number;
    readonly terminalCount: number;
    readonly recentClassificationCount: number;
    readonly recentClassificationSchemaErrors: number;
    readonly classificationP95Seconds: number | null;
    readonly recentExportFailures: number;
  };
}

export interface OperationalAlert {
  readonly code: string;
  readonly severity: OperationalAlertSeverity;
  readonly signal: string;
  readonly context: Readonly<Record<string, number | string | boolean>>;
}

export interface OperationalAlertOptions {
  readonly requireScheduler: boolean;
  readonly terminalBaseline: number;
}

const finiteNonNegative = (value: number): number =>
  Number.isFinite(value) && value >= 0 ? value : 0;

const eventTime = (event: OperationalLogEvent): number | null => {
  const parsed = Date.parse(event.timestamp);
  return Number.isFinite(parsed) ? parsed : null;
};

const within = (
  events: readonly OperationalLogEvent[],
  now: number,
  windowMs: number,
): readonly OperationalLogEvent[] =>
  events.filter((event) => {
    const timestamp = eventTime(event);
    return (
      timestamp !== null &&
      timestamp <= now + 60_000 &&
      timestamp >= now - windowMs
    );
  });

const latestAgeSeconds = (
  events: readonly OperationalLogEvent[],
  eventName: string,
  now: number,
): number | null => {
  const timestamps = events
    .filter((event) => event.event === eventName)
    .map(eventTime)
    .filter((timestamp): timestamp is number => timestamp !== null);
  if (timestamps.length === 0) {
    return null;
  }
  return Math.max(0, (now - Math.max(...timestamps)) / 1_000);
};

export const evaluateOperationalAlerts = (
  snapshot: OperationalSnapshot,
  options: OperationalAlertOptions,
): readonly OperationalAlert[] => {
  const now = Date.parse(snapshot.checkedAt);
  if (!Number.isFinite(now)) {
    throw new TypeError("checkedAt must be an ISO timestamp");
  }
  const alerts: OperationalAlert[] = [];
  const add = (
    code: string,
    severity: OperationalAlertSeverity,
    signal: string,
    context: Readonly<Record<string, number | string | boolean>> = {},
  ): void => {
    alerts.push({ code, severity, signal, context });
  };

  for (const serviceName of EXPECTED_SERVICE_NAMES) {
    const status = snapshot.services[serviceName];
    if (status === undefined) {
      add("service_missing", "P2", "service_status", { serviceName });
    } else if (status !== "SUCCESS") {
      add("service_unhealthy", "P2", "service_status", {
        serviceName,
        status: KNOWN_DEPLOYMENT_STATUSES.has(status) ? status : "UNKNOWN",
      });
    }
  }
  const unexpectedServiceCount = Object.keys(snapshot.services).filter(
    (name) =>
      !EXPECTED_SERVICE_NAMES.includes(
        name as (typeof EXPECTED_SERVICE_NAMES)[number],
      ),
  ).length;
  if (unexpectedServiceCount > 0) {
    add("unexpected_service", "P2", "service_graph", {
      count: unexpectedServiceCount,
    });
  }

  if (!snapshot.api.health) {
    add("api_liveness_failed", "P2", "api_health");
  }
  if (!snapshot.api.ready) {
    add("api_readiness_failed", "P2", "api_readiness");
  }
  if (!snapshot.api.metricsAvailable) {
    add("api_metrics_unavailable", "P2", "api_metrics");
  }

  const workerHeartbeatAge = latestAgeSeconds(
    snapshot.workerEvents,
    "worker_heartbeat",
    now,
  );
  const workerStartAge = latestAgeSeconds(
    snapshot.workerEvents,
    "worker_started",
    now,
  );
  const workerLivenessAge = [workerHeartbeatAge, workerStartAge]
    .filter((age): age is number => age !== null)
    .reduce<number | null>(
      (youngest, age) => (youngest === null ? age : Math.min(youngest, age)),
      null,
    );
  if (
    workerLivenessAge === null ||
    workerLivenessAge > WORKER_LIVENESS_GRACE_SECONDS
  ) {
    add("worker_heartbeat_stale", "P2", "worker_heartbeat", {
      ageSeconds:
        workerLivenessAge === null ? -1 : Math.round(workerLivenessAge),
    });
  }

  const recentWorkerEvents = within(snapshot.workerEvents, now, 10 * 60_000);
  const workerStarts = recentWorkerEvents.filter(
    (event) => event.event === "worker_started",
  ).length;
  if (workerStarts >= 3) {
    add("worker_restart_loop", "P2", "worker_restart", {
      startsInTenMinutes: workerStarts,
    });
  }

  const finishedFailures = recentWorkerEvents.filter(
    (event) =>
      event.event === "pipeline_job_finished" &&
      (event.state === "RETRYABLE" || event.state === "TERMINAL"),
  );
  if (finishedFailures.length >= 3) {
    add("pipeline_failures_sustained", "P2", "pipeline_failure", {
      failuresInTenMinutes: finishedFailures.length,
    });
  }
  const recentTerminalJobs = finishedFailures.filter(
    (event) => event.state === "TERMINAL",
  ).length;
  if (recentTerminalJobs > 0) {
    add("pipeline_terminal_job", "P2", "pipeline_terminal", {
      terminalJobsInTenMinutes: recentTerminalJobs,
    });
  }
  const transitionFailures = recentWorkerEvents.filter(
    (event) => event.event === "pipeline_job_transition_failed",
  ).length;
  if (transitionFailures > 0) {
    add("pipeline_transition_failed", "P2", "pipeline_transition", {
      failuresInTenMinutes: transitionFailures,
    });
  }

  const database = snapshot.database;
  if (
    finiteNonNegative(database.runnableDepth) > 10 &&
    finiteNonNegative(database.oldestRunnableAgeSeconds) > 15 * 60
  ) {
    add("pipeline_queue_stalled", "P2", "pipeline_queue", {
      depth: database.runnableDepth,
      oldestAgeSeconds: Math.round(database.oldestRunnableAgeSeconds),
    });
  }
  if (finiteNonNegative(database.expiredLeaseCount) > 0) {
    add("pipeline_expired_leases", "P2", "pipeline_lease", {
      count: database.expiredLeaseCount,
    });
  }
  if (database.terminalCount > options.terminalBaseline) {
    add("pipeline_terminal_count_increased", "P2", "pipeline_terminal", {
      baseline: options.terminalBaseline,
      current: database.terminalCount,
    });
  }
  if (finiteNonNegative(database.recentClassificationSchemaErrors) > 0) {
    add("classification_schema_invalid", "P2", "classification_schema", {
      count: database.recentClassificationSchemaErrors,
    });
  }
  if (
    database.recentClassificationCount >= 5 &&
    database.classificationP95Seconds !== null &&
    database.classificationP95Seconds > 60
  ) {
    add("classification_latency_high", "P3", "classification_latency", {
      p95Seconds: Math.round(database.classificationP95Seconds),
      samples: database.recentClassificationCount,
    });
  }
  if (finiteNonNegative(database.recentExportFailures) > 0) {
    add("export_delivery_failed", "P2", "export_delivery", {
      failuresInTenMinutes: database.recentExportFailures,
    });
  }

  if (
    finiteNonNegative(snapshot.api.reviewOldestAgeSeconds) >
    7 * 24 * 60 * 60
  ) {
    add("review_backlog_aged", "P3", "review_backlog", {
      depth: finiteNonNegative(snapshot.api.reviewQueueDepth),
      oldestAgeSeconds: Math.round(snapshot.api.reviewOldestAgeSeconds),
    });
  }
  if (finiteNonNegative(snapshot.api.feedRootConcentration) > 0.5) {
    add("feed_root_concentration_high", "P3", "feed_diversity", {
      concentration: snapshot.api.feedRootConcentration,
    });
  }

  for (const serviceName of RESOURCE_SERVICE_NAMES) {
    const resources = snapshot.resources[serviceName];
    if (resources === undefined) {
      continue;
    }
    if (
      resources.cpuTenMinuteFloorPercent !== null &&
      finiteNonNegative(resources.cpuTenMinuteFloorPercent) >
        RESOURCE_UTILIZATION_ALERT_PERCENT
    ) {
      add("service_cpu_sustained_high", "P3", "service_cpu", {
        serviceName,
        utilizationPercent: resources.cpuTenMinuteFloorPercent,
      });
    }
    if (
      resources.memoryTenMinuteFloorPercent !== null &&
      finiteNonNegative(resources.memoryTenMinuteFloorPercent) >
        RESOURCE_UTILIZATION_ALERT_PERCENT
    ) {
      add("service_memory_sustained_high", "P3", "service_memory", {
        serviceName,
        utilizationPercent: resources.memoryTenMinuteFloorPercent,
      });
    }
    if (
      resources.volumeMaxUtilizationPercent !== null &&
      finiteNonNegative(resources.volumeMaxUtilizationPercent) >
        VOLUME_UTILIZATION_ALERT_PERCENT
    ) {
      add("service_volume_high", "P3", "service_volume", {
        serviceName,
        utilizationPercent: resources.volumeMaxUtilizationPercent,
      });
    }
  }

  if (options.requireScheduler) {
    const schedulerAge = latestAgeSeconds(
      snapshot.schedulerEvents,
      "reconciliation_schedule_completed",
      now,
    );
    if (schedulerAge === null || schedulerAge > 26 * 60 * 60) {
      add("scheduler_completion_stale", "P2", "scheduler_completion", {
        ageSeconds: schedulerAge === null ? -1 : Math.round(schedulerAge),
      });
    }
  }

  return alerts;
};
