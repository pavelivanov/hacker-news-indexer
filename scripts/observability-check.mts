import { spawn } from "node:child_process";

import {
  evaluateOperationalAlerts,
  resourceUtilizationPercent,
  sustainedUtilizationFloorPercent,
  type OperationalLogEvent,
  type OperationalResourceSignal,
  type OperationalSnapshot,
  type ResourceMetricPoint,
} from "@hn-knowledge/config";

const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_COMMAND_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 30_000;
const SAFE_ENVIRONMENT = /^[A-Za-z0-9._-]{1,64}$/u;
const RESOURCE_SERVICE_NAMES = ["api", "worker", "postgres"] as const;

type ResourceServiceName = (typeof RESOURCE_SERVICE_NAMES)[number];

const DATABASE_SNAPSHOT_QUERY = `
WITH pipeline AS (
  SELECT
    COUNT(*) FILTER (WHERE state IN ('AVAILABLE', 'RETRYABLE')) AS runnable_depth,
    COALESCE(
      EXTRACT(EPOCH FROM (
        CURRENT_TIMESTAMP - MIN(created_at) FILTER (
          WHERE state IN ('AVAILABLE', 'RETRYABLE')
        )
      )),
      0
    ) AS oldest_runnable_age_seconds,
    COUNT(*) FILTER (
      WHERE state = 'LEASED' AND lease_expires_at <= CURRENT_TIMESTAMP
    ) AS expired_lease_count,
    COUNT(*) FILTER (WHERE state = 'TERMINAL') AS terminal_count
  FROM pipeline_jobs
),
classification AS (
  SELECT
    COUNT(*) FILTER (
      WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '1 hour'
    ) AS recent_count,
    COUNT(*) FILTER (
      WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '10 minutes'
        AND error_code IS NOT NULL
        AND (error_code ILIKE '%SCHEMA%' OR error_code ILIKE '%INVALID%')
    ) AS recent_schema_errors,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (
      WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '1 hour'
        AND latency_ms IS NOT NULL
    ) / 1000.0 AS p95_seconds
  FROM classification_runs
),
export_failures AS (
  SELECT COUNT(*) AS recent_count
  FROM export_outbox
  WHERE last_error_at >= CURRENT_TIMESTAMP - INTERVAL '10 minutes'
)
SELECT json_build_object(
  'runnableDepth', pipeline.runnable_depth,
  'oldestRunnableAgeSeconds', pipeline.oldest_runnable_age_seconds,
  'expiredLeaseCount', pipeline.expired_lease_count,
  'terminalCount', pipeline.terminal_count,
  'recentClassificationCount', classification.recent_count,
  'recentClassificationSchemaErrors', classification.recent_schema_errors,
  'classificationP95Seconds', classification.p95_seconds,
  'recentExportFailures', export_failures.recent_count
)::text
FROM pipeline, classification, export_failures;
`;

class SafeFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SafeFailure";
  }
}

const safeJson = (value: string, code: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    throw new SafeFailure(code);
  }
};

const record = (value: unknown, code: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SafeFailure(code);
  }
  return value as Record<string, unknown>;
};

const nonNegativeNumber = (value: unknown, code: string): number => {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 0) {
    throw new SafeFailure(code);
  }
  return parsed;
};

const optionalNonNegativeNumber = (
  value: unknown,
  code: string,
): number | null => (value === null ? null : nonNegativeNumber(value, code));

const runRailway = async (args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn("railway", args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let bytes = 0;
    let settled = false;
    const fail = (code: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(new SafeFailure(code));
    };
    const timeout = setTimeout(
      () => fail("RAILWAY_COMMAND_TIMEOUT"),
      COMMAND_TIMEOUT_MS,
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_COMMAND_BYTES) {
        fail("RAILWAY_OUTPUT_TOO_LARGE");
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_COMMAND_BYTES) {
        fail("RAILWAY_OUTPUT_TOO_LARGE");
      }
    });
    child.once("error", () => fail("RAILWAY_COMMAND_START_FAILED"));
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (settled) {
        return;
      }
      settled = true;
      if (code !== 0) {
        reject(new SafeFailure("RAILWAY_COMMAND_FAILED"));
        return;
      }
      resolve(stdout);
    });
  });

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'"'"'`)}'`;

const parseOrigin = (value: string | undefined): URL => {
  if (value === undefined || value.trim().length === 0) {
    throw new SafeFailure("OBSERVABILITY_API_URL_REQUIRED");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SafeFailure("OBSERVABILITY_API_URL_INVALID");
  }
  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]";
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    (url.pathname !== "/" && url.pathname !== "") ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new SafeFailure("OBSERVABILITY_API_URL_INVALID");
  }
  return url;
};

const readBoundedText = async (response: Response): Promise<string> => {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new SafeFailure("API_RESPONSE_TOO_LARGE");
  }
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    bytes += result.value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new SafeFailure("API_RESPONSE_TOO_LARGE");
    }
    text += decoder.decode(result.value, { stream: true });
  }
  return text + decoder.decode();
};

interface HttpResult {
  readonly status: number | null;
  readonly text: string;
}

const request = async (
  origin: URL,
  path: string,
  token?: string,
): Promise<HttpResult> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (token !== undefined) {
      headers.authorization = `Bearer ${token}`;
      headers.accept = "text/plain";
    }
    const response = await fetch(new URL(path, origin), {
      cache: "no-store",
      headers,
      redirect: "error",
      signal: controller.signal,
    });
    return { status: response.status, text: await readBoundedText(response) };
  } catch (error) {
    if (error instanceof SafeFailure) {
      throw error;
    }
    return { status: null, text: "" };
  } finally {
    clearTimeout(timeout);
  }
};

const healthyJson = (result: HttpResult): boolean => {
  if (result.status !== 200) {
    return false;
  }
  const parsed = safeJson(result.text, "API_HEALTH_JSON_INVALID");
  return record(parsed, "API_HEALTH_JSON_INVALID")["status"] === "ok";
};

const metricValue = (text: string, name: string): number => {
  if (!/^[a-z_][a-z0-9_]*$/u.test(name)) {
    throw new SafeFailure("METRIC_NAME_INVALID");
  }
  const match = new RegExp(
    `^${name} ([0-9]+(?:\\.[0-9]+)?(?:e[+-]?[0-9]+)?)$`,
    "imu",
  ).exec(text);
  if (match?.[1] === undefined) {
    throw new SafeFailure("EXPECTED_METRIC_MISSING");
  }
  return nonNegativeNumber(match[1], "METRIC_VALUE_INVALID");
};

const parseLogEvents = (text: string): readonly OperationalLogEvent[] =>
  text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const entry = record(
        safeJson(line, "RAILWAY_LOG_JSON_INVALID"),
        "RAILWAY_LOG_JSON_INVALID",
      );
      const event = typeof entry["event"] === "string" ? entry["event"] : "";
      const timestamp =
        typeof entry["timestamp"] === "string" ? entry["timestamp"] : "";
      return {
        event,
        timestamp,
        state: typeof entry["state"] === "string" ? entry["state"] : null,
        jobType: typeof entry["jobType"] === "string" ? entry["jobType"] : null,
        errorCode:
          typeof entry["errorCode"] === "string" ? entry["errorCode"] : null,
        durationMs:
          typeof entry["durationMs"] === "number" &&
          Number.isFinite(entry["durationMs"])
            ? entry["durationMs"]
            : null,
      };
    });

const metricPoints = (
  measurements: Record<string, unknown>,
  name: string,
): readonly ResourceMetricPoint[] => {
  const rawPoints = measurements[name];
  if (!Array.isArray(rawPoints)) {
    throw new SafeFailure("RAILWAY_METRICS_INVALID");
  }
  return rawPoints.map((rawPoint) => {
    const point = record(rawPoint, "RAILWAY_METRICS_INVALID");
    const timestamp = point["ts"];
    if (typeof timestamp !== "string") {
      throw new SafeFailure("RAILWAY_METRICS_INVALID");
    }
    return {
      timestamp,
      value: nonNegativeNumber(point["value"], "RAILWAY_METRICS_INVALID"),
    };
  });
};

const parseVolumeUtilization = (
  text: string,
): Readonly<Record<ResourceServiceName, number | null>> => {
  const summary = record(
    safeJson(text, "RAILWAY_METRICS_INVALID"),
    "RAILWAY_METRICS_INVALID",
  );
  const rawServices = summary["services"];
  if (!Array.isArray(rawServices)) {
    throw new SafeFailure("RAILWAY_METRICS_INVALID");
  }
  const services = rawServices.map((service) =>
    record(service, "RAILWAY_METRICS_INVALID"),
  );
  const result = {} as Record<ResourceServiceName, number | null>;
  for (const serviceName of RESOURCE_SERVICE_NAMES) {
    const service = services.find(
      (candidate) => candidate["name"] === serviceName,
    );
    if (service === undefined) {
      throw new SafeFailure("RAILWAY_METRICS_INVALID");
    }
    const rawVolumes = service["volumes"];
    if (rawVolumes === undefined) {
      result[serviceName] = null;
      continue;
    }
    if (!Array.isArray(rawVolumes)) {
      throw new SafeFailure("RAILWAY_METRICS_INVALID");
    }
    const utilization = rawVolumes.map((rawVolume) => {
      const volume = record(rawVolume, "RAILWAY_METRICS_INVALID");
      try {
        return resourceUtilizationPercent(
          nonNegativeNumber(volume["current_mb"], "RAILWAY_METRICS_INVALID"),
          nonNegativeNumber(volume["limit_mb"], "RAILWAY_METRICS_INVALID"),
        );
      } catch {
        throw new SafeFailure("RAILWAY_METRICS_INVALID");
      }
    });
    result[serviceName] =
      utilization.length === 0 ? null : Math.max(...utilization);
  }
  return result;
};

const parseResourceSignal = (
  text: string,
  serviceName: ResourceServiceName,
  checkedAt: string,
  volumeMaxUtilizationPercent: number | null,
): OperationalResourceSignal => {
  const raw = record(
    safeJson(text, "RAILWAY_METRICS_INVALID"),
    "RAILWAY_METRICS_INVALID",
  );
  if (raw["service"] !== serviceName) {
    throw new SafeFailure("RAILWAY_METRICS_INVALID");
  }
  const measurements = record(raw["measurements"], "RAILWAY_METRICS_INVALID");
  try {
    return {
      cpuTenMinuteFloorPercent: sustainedUtilizationFloorPercent(
        metricPoints(measurements, "CPU_USAGE"),
        metricPoints(measurements, "CPU_LIMIT"),
        checkedAt,
      ),
      memoryTenMinuteFloorPercent: sustainedUtilizationFloorPercent(
        metricPoints(measurements, "MEMORY_USAGE_GB"),
        metricPoints(measurements, "MEMORY_LIMIT_GB"),
        checkedAt,
      ),
      volumeMaxUtilizationPercent,
    };
  } catch (error) {
    if (error instanceof SafeFailure) {
      throw error;
    }
    throw new SafeFailure("RAILWAY_METRICS_INVALID");
  }
};

const collectResources = async (
  environment: string,
): Promise<OperationalSnapshot["resources"]> => {
  const summaryPromise = runRailway([
    "metrics",
    "--all",
    "--environment",
    environment,
    "--since",
    "15m",
    "--json",
    "--cpu",
    "--memory",
    "--volume",
  ]);
  const rawPromises = RESOURCE_SERVICE_NAMES.map((serviceName) =>
    runRailway([
      "metrics",
      "--service",
      serviceName,
      "--environment",
      environment,
      "--since",
      "15m",
      "--raw",
      "--json",
      "--cpu",
      "--memory",
    ]),
  );
  const [summaryText, rawTexts] = await Promise.all([
    summaryPromise,
    Promise.all(rawPromises),
  ]);
  const volumeUtilization = parseVolumeUtilization(summaryText);
  const checkedAt = new Date().toISOString();
  const resources: Record<string, OperationalResourceSignal> = {};
  for (const [index, serviceName] of RESOURCE_SERVICE_NAMES.entries()) {
    const rawText = rawTexts[index];
    if (rawText === undefined) {
      throw new SafeFailure("RAILWAY_METRICS_INVALID");
    }
    resources[serviceName] = parseResourceSignal(
      rawText,
      serviceName,
      checkedAt,
      volumeUtilization[serviceName],
    );
  }
  return resources;
};

const collectApi = async (
  origin: URL,
  token: string,
): Promise<OperationalSnapshot["api"]> => {
  const [health, ready, metrics] = await Promise.all([
    request(origin, "/healthz"),
    request(origin, "/readyz"),
    request(origin, "/metrics", token),
  ]);
  const metricsAvailable = metrics.status === 200;
  if (!metricsAvailable) {
    return {
      health: healthyJson(health),
      ready: healthyJson(ready),
      metricsAvailable: false,
      reviewQueueDepth: 0,
      reviewOldestAgeSeconds: 0,
      feedRootConcentration: 0,
    };
  }
  const forbidden = [
    token,
    "Bearer ",
    "APP_API_TOKEN",
    "DATABASE_URL",
    "postgresql://",
    "postgres://",
  ];
  if (forbidden.some((value) => metrics.text.includes(value))) {
    throw new SafeFailure("METRICS_RESPONSE_UNSAFE");
  }
  return {
    health: healthyJson(health),
    ready: healthyJson(ready),
    metricsAvailable: true,
    reviewQueueDepth: metricValue(metrics.text, "review_queue_depth"),
    reviewOldestAgeSeconds: metricValue(
      metrics.text,
      "review_queue_oldest_age_seconds",
    ),
    feedRootConcentration: metricValue(metrics.text, "feed_root_concentration"),
  };
};

interface RailwayContext {
  readonly projectId: string;
  readonly projectName: string;
}

const collectContext = async (environment: string): Promise<RailwayContext> => {
  const status = record(
    safeJson(await runRailway(["status", "--json"]), "RAILWAY_STATUS_INVALID"),
    "RAILWAY_STATUS_INVALID",
  );
  const projectId = status["id"];
  const projectName = status["name"];
  if (typeof projectId !== "string" || typeof projectName !== "string") {
    throw new SafeFailure("RAILWAY_STATUS_INVALID");
  }
  const environments = record(
    status["environments"],
    "RAILWAY_ENVIRONMENTS_INVALID",
  )["edges"];
  if (!Array.isArray(environments)) {
    throw new SafeFailure("RAILWAY_ENVIRONMENTS_INVALID");
  }
  const environmentExists = environments.some((edge) => {
    const edgeRecord = record(edge, "RAILWAY_ENVIRONMENTS_INVALID");
    const node = record(edgeRecord["node"], "RAILWAY_ENVIRONMENTS_INVALID");
    return node["name"] === environment && node["canAccess"] === true;
  });
  if (!environmentExists) {
    throw new SafeFailure("RAILWAY_ENVIRONMENT_NOT_FOUND");
  }
  return { projectId, projectName };
};

const collectServices = async (
  environment: string,
): Promise<Readonly<Record<string, string>>> => {
  const parsed = safeJson(
    await runRailway([
      "service",
      "list",
      "--environment",
      environment,
      "--json",
    ]),
    "RAILWAY_SERVICES_INVALID",
  );
  if (!Array.isArray(parsed)) {
    throw new SafeFailure("RAILWAY_SERVICES_INVALID");
  }
  const services: Record<string, string> = {};
  for (const rawService of parsed) {
    const service = record(rawService, "RAILWAY_SERVICES_INVALID");
    const name = service["name"];
    const status = service["status"];
    if (typeof name !== "string" || typeof status !== "string") {
      throw new SafeFailure("RAILWAY_SERVICES_INVALID");
    }
    services[name] = service["stopped"] === true ? "REMOVED" : status;
  }
  return services;
};

const collectDatabase = async (
  context: RailwayContext,
  environment: string,
): Promise<OperationalSnapshot["database"]> => {
  const remoteCommand = `psql "$DATABASE_URL" --no-psqlrc --set ON_ERROR_STOP=1 --tuples-only --no-align --command ${shellQuote(DATABASE_SNAPSHOT_QUERY)}`;
  const output = await runRailway([
    "ssh",
    "--project",
    context.projectId,
    "--environment",
    environment,
    "--service",
    "postgres",
    "--",
    "sh",
    "-lc",
    remoteCommand,
  ]);
  const value = record(
    safeJson(output.trim(), "DATABASE_SNAPSHOT_INVALID"),
    "DATABASE_SNAPSHOT_INVALID",
  );
  return {
    runnableDepth: nonNegativeNumber(
      value["runnableDepth"],
      "DATABASE_SNAPSHOT_INVALID",
    ),
    oldestRunnableAgeSeconds: nonNegativeNumber(
      value["oldestRunnableAgeSeconds"],
      "DATABASE_SNAPSHOT_INVALID",
    ),
    expiredLeaseCount: nonNegativeNumber(
      value["expiredLeaseCount"],
      "DATABASE_SNAPSHOT_INVALID",
    ),
    terminalCount: nonNegativeNumber(
      value["terminalCount"],
      "DATABASE_SNAPSHOT_INVALID",
    ),
    recentClassificationCount: nonNegativeNumber(
      value["recentClassificationCount"],
      "DATABASE_SNAPSHOT_INVALID",
    ),
    recentClassificationSchemaErrors: nonNegativeNumber(
      value["recentClassificationSchemaErrors"],
      "DATABASE_SNAPSHOT_INVALID",
    ),
    classificationP95Seconds: optionalNonNegativeNumber(
      value["classificationP95Seconds"],
      "DATABASE_SNAPSHOT_INVALID",
    ),
    recentExportFailures: nonNegativeNumber(
      value["recentExportFailures"],
      "DATABASE_SNAPSHOT_INVALID",
    ),
  };
};

const booleanEnvironment = (name: string, defaultValue: boolean): boolean => {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    return defaultValue;
  }
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  throw new SafeFailure(`${name}_INVALID`);
};

const integerEnvironment = (name: string, defaultValue: number): number => {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new SafeFailure(`${name}_INVALID`);
  }
  return parsed;
};

const main = async (): Promise<void> => {
  const environment = process.env["OBSERVABILITY_ENVIRONMENT"] ?? "staging";
  if (!SAFE_ENVIRONMENT.test(environment)) {
    throw new SafeFailure("OBSERVABILITY_ENVIRONMENT_INVALID");
  }
  const token = process.env["APP_API_TOKEN"]?.trim();
  if (token === undefined || token.length < 32 || /\s/u.test(token)) {
    throw new SafeFailure("APP_API_TOKEN_INVALID");
  }
  const origin = parseOrigin(
    process.argv[2] ??
      process.env["OBSERVABILITY_API_URL"] ??
      process.env["STAGING_API_URL"],
  );
  const requireScheduler = booleanEnvironment(
    "OBSERVABILITY_REQUIRE_SCHEDULER",
    false,
  );
  const terminalBaseline = integerEnvironment(
    "OBSERVABILITY_TERMINAL_BASELINE",
    0,
  );
  const context = await collectContext(environment);
  const [services, api, workerLogs, schedulerLogs, resources, database] =
    await Promise.all([
      collectServices(environment),
      collectApi(origin, token),
      runRailway([
        "logs",
        "--service",
        "worker",
        "--environment",
        environment,
        "--since",
        "15m",
        "--lines",
        "1000",
        "--json",
      ]),
      runRailway([
        "logs",
        "--service",
        "scheduler",
        "--environment",
        environment,
        "--since",
        "27h",
        "--lines",
        "500",
        "--json",
      ]),
      collectResources(environment),
      collectDatabase(context, environment),
    ]);
  const snapshot: OperationalSnapshot = {
    checkedAt: new Date().toISOString(),
    services,
    api,
    workerEvents: parseLogEvents(workerLogs),
    schedulerEvents: parseLogEvents(schedulerLogs),
    resources,
    database,
  };
  const alerts = evaluateOperationalAlerts(snapshot, {
    requireScheduler,
    terminalBaseline,
  });
  const report = {
    schemaVersion: "observability-check.v1",
    ok: alerts.length === 0,
    checkedAt: snapshot.checkedAt,
    environment,
    project: {
      idSuffix: context.projectId.slice(-4),
      name: context.projectName,
    },
    signals: {
      services,
      api,
      resources,
      database,
      workerEventCount: snapshot.workerEvents.length,
      schedulerEventCount: snapshot.schedulerEvents.length,
      schedulerRequired: requireScheduler,
    },
    alerts,
  };
  const serialized = JSON.stringify(report);
  if (
    serialized.includes(token) ||
    serialized.includes("postgresql://") ||
    serialized.includes("DATABASE_URL")
  ) {
    throw new SafeFailure("OBSERVABILITY_REPORT_UNSAFE");
  }
  process.stdout.write(`${serialized}\n`);
  if (alerts.length > 0) {
    process.exitCode = 2;
  }
};

void main().catch((error: unknown) => {
  const code = error instanceof SafeFailure ? error.code : "UNEXPECTED_FAILURE";
  process.stderr.write(`Observability check failed: ${code}\n`);
  process.exitCode = 1;
});
