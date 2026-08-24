import pino, { type Logger } from "pino";

import type { AppConfig } from "./env.js";

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
  });
