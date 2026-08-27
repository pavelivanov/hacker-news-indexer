import pino, { type Logger } from "pino";

import type { AppConfig } from "./env.js";

const RAILWAY_LOG_BINDINGS = [
  ["RAILWAY_PROJECT_ID", "railwayProjectId"],
  ["RAILWAY_ENVIRONMENT_ID", "railwayEnvironmentId"],
  ["RAILWAY_ENVIRONMENT_NAME", "railwayEnvironmentName"],
  ["RAILWAY_SERVICE_ID", "railwayServiceId"],
  ["RAILWAY_SERVICE_NAME", "railwayServiceName"],
  ["RAILWAY_DEPLOYMENT_ID", "railwayDeploymentId"],
  ["RAILWAY_REPLICA_ID", "railwayReplicaId"],
  ["RAILWAY_REPLICA_REGION", "railwayReplicaRegion"],
  ["RAILWAY_GIT_COMMIT_SHA", "railwayGitCommitSha"],
] as const;

type RailwayConfigKey = (typeof RAILWAY_LOG_BINDINGS)[number][0];
type LoggerConfig = Pick<AppConfig, "LOG_LEVEL"> &
  Partial<Pick<AppConfig, RailwayConfigKey>>;

const SENSITIVE_LOG_KEY =
  /authorization|body|content|database|html|password|prompt|raw|secret|session|text|token|url/iu;
const SENSITIVE_LOG_VALUE = /postgres(?:ql)?:\/\/|bearer\s+|api[_-]?key/iu;

export const redactLogFields = (
  fields: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    Object.entries(fields).map(([key, value]) => {
      if (SENSITIVE_LOG_KEY.test(key)) {
        return [key, "[REDACTED]"];
      }
      if (typeof value === "string" && SENSITIVE_LOG_VALUE.test(value)) {
        return [key, "[REDACTED]"];
      }
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        return [
          key,
          redactLogFields(value as Readonly<Record<string, unknown>>),
        ];
      }
      if (Array.isArray(value)) {
        return [
          key,
          (value as readonly unknown[]).map((entry: unknown): unknown =>
            entry !== null && typeof entry === "object"
              ? redactLogFields(entry as Readonly<Record<string, unknown>>)
              : typeof entry === "string" && SENSITIVE_LOG_VALUE.test(entry)
                ? "[REDACTED]"
                : entry,
          ),
        ];
      }
      return [key, value];
    }),
  );

export const railwayLogBindings = (
  config: Partial<Pick<AppConfig, RailwayConfigKey>>,
): Readonly<Record<string, string>> => {
  const bindings: Record<string, string> = {};
  for (const [configKey, logKey] of RAILWAY_LOG_BINDINGS) {
    const value = config[configKey];
    if (value !== undefined) {
      bindings[logKey] = value;
    }
  }
  return bindings;
};

export const createLogger = (
  config: LoggerConfig,
  bindings: Readonly<Record<string, string>>,
): Logger =>
  pino({
    level: config.LOG_LEVEL,
    base: {
      service: "hn-knowledge",
      ...railwayLogBindings(config),
      ...bindings,
    },
    redact: {
      paths: [
        "authorization",
        "headers.authorization",
        "req.headers.authorization",
        "token",
        "password",
        "session",
      ],
      censor: "[REDACTED]",
    },
    formatters: { log: redactLogFields },
  });
