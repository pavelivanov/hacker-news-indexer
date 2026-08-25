import pino, { type Logger } from "pino";

import type { AppConfig } from "./env.js";

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

export const createLogger = (
  config: Pick<AppConfig, "LOG_LEVEL">,
  bindings: Readonly<Record<string, string>>,
): Logger =>
  pino({
    level: config.LOG_LEVEL,
    base: {
      service: "hn-knowledge",
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
