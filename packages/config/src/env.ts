import { z } from "zod";

const DEFAULT_DATABASE_URL =
  "postgresql://hn_knowledge:hn_knowledge@127.0.0.1:5432/hn_knowledge";

const emptyToUndefined = (value: unknown): unknown => {
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }

  return value;
};

const optionalString = z.preprocess(
  emptyToUndefined,
  z.string().trim().min(1).optional(),
);

const integer = (defaultValue: number, minimum: number, maximum: number) =>
  z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(minimum).max(maximum).default(defaultValue),
  );

const optionalPositiveInteger = z.preprocess(
  emptyToUndefined,
  z.coerce.number().int().positive().optional(),
);

const booleanWithDefault = (defaultValue: boolean) =>
  z.preprocess((value) => {
    const normalized = emptyToUndefined(value);
    if (normalized === undefined) {
      return defaultValue;
    }
    if (normalized === true || normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === false || normalized === "false" || normalized === "0") {
      return false;
    }

    return normalized;
  }, z.boolean());

const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    PORT: integer(3000, 1, 65_535),
    DATABASE_URL: z.preprocess(
      emptyToUndefined,
      z.url().startsWith("postgresql://").default(DEFAULT_DATABASE_URL),
    ),
    APP_API_TOKEN: optionalString,
    INGESTION_MAX_RANGE: integer(1_000, 1, 100_000),
    DATABASE_READY_TIMEOUT_MS: integer(2_000, 100, 60_000),
    SHUTDOWN_TIMEOUT_MS: integer(10_000, 100, 60_000),
    TELEGRAM_ENABLED: booleanWithDefault(false),
    TELEGRAM_API_ID: optionalPositiveInteger,
    TELEGRAM_API_HASH: optionalString,
    TELEGRAM_SESSION_PATH: z.preprocess(
      emptyToUndefined,
      z.string().trim().min(1).default(".sessions/telegram.session"),
    ),
    TELEGRAM_SOURCE_KEY: z.preprocess(
      emptyToUndefined,
      z.string().trim().min(1).default("hn_best_comments"),
    ),
    TELEGRAM_REQUEST_TIMEOUT_MS: integer(15_000, 100, 120_000),
    TELEGRAM_MAX_FLOOD_WAIT_MS: integer(30_000, 0, 3_600_000),
    HN_REQUEST_TIMEOUT_MS: integer(10_000, 100, 120_000),
    WORKER_CONCURRENCY: integer(4, 1, 32),
    WORKER_POLL_INTERVAL_MS: integer(500, 10, 60_000),
    WORKER_LEASE_DURATION_MS: integer(60_000, 1_000, 3_600_000),
    WORKER_MAX_ATTEMPTS: integer(4, 1, 20),
    WORKER_RETRY_BASE_MS: integer(1_000, 10, 3_600_000),
    CLASSIFIER_ENABLED: booleanWithDefault(false),
    CLASSIFIER_PROVIDER: optionalString,
    CLASSIFIER_API_TOKEN: optionalString,
    CLASSIFIER_MODEL: optionalString,
    CLASSIFIER_REASONING_EFFORT: z.preprocess(
      emptyToUndefined,
      z.enum(["none", "low", "medium", "high", "xhigh", "max"]).default("low"),
    ),
    CLASSIFIER_REQUEST_TIMEOUT_MS: integer(45_000, 100, 180_000),
  })
  .superRefine((value, context) => {
    if (value.TELEGRAM_ENABLED) {
      for (const key of ["TELEGRAM_API_ID", "TELEGRAM_API_HASH"] as const) {
        if (value[key] === undefined) {
          context.addIssue({
            code: "custom",
            message: `${key} is required when TELEGRAM_ENABLED=true`,
            path: [key],
          });
        }
      }
    }

    if (value.CLASSIFIER_ENABLED) {
      for (const key of [
        "CLASSIFIER_PROVIDER",
        "CLASSIFIER_API_TOKEN",
        "CLASSIFIER_MODEL",
      ] as const) {
        if (value[key] === undefined) {
          context.addIssue({
            code: "custom",
            message: `${key} is required when CLASSIFIER_ENABLED=true`,
            path: [key],
          });
        }
      }
    }
  });

export type AppConfig = z.infer<typeof environmentSchema>;

export const parseConfig = (
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
): AppConfig => environmentSchema.parse(source);

let cachedConfig: AppConfig | undefined;

export const getConfig = (): AppConfig => {
  cachedConfig ??= parseConfig(process.env);
  return cachedConfig;
};

const SENSITIVE_KEY = /TOKEN|SECRET|HASH|SESSION|PASSWORD|DATABASE_URL/i;

export const redactConfig = (
  config: AppConfig,
): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    Object.entries(config).map(([key, value]) => [
      key,
      SENSITIVE_KEY.test(key) && value !== undefined ? "[REDACTED]" : value,
    ]),
  );
