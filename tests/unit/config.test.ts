import { describe, expect, it } from "vitest";

import { parseConfig, redactConfig } from "@hn-knowledge/config";

describe("application configuration", () => {
  it("applies safe defaults without requiring external credentials", () => {
    const config = parseConfig({});

    expect(config).toMatchObject({
      NODE_ENV: "development",
      LOG_LEVEL: "info",
      PORT: 3000,
      TELEGRAM_ENABLED: false,
      CLASSIFIER_ENABLED: false,
      DATABASE_READY_TIMEOUT_MS: 2_000,
    });
    expect(config.TELEGRAM_API_HASH).toBeUndefined();
    expect(config.CLASSIFIER_API_TOKEN).toBeUndefined();
  });

  it.each([
    ["PORT", "0"],
    ["PORT", "65536"],
    ["PORT", "not-a-number"],
    ["DATABASE_READY_TIMEOUT_MS", "99"],
    ["TELEGRAM_REQUEST_TIMEOUT_MS", "nope"],
  ])("rejects invalid numeric value for %s", (key, value) => {
    expect(() => parseConfig({ [key]: value })).toThrow();
  });

  it("requires integration credentials only when the integration is enabled", () => {
    expect(() => parseConfig({ TELEGRAM_ENABLED: "true" })).toThrow(
      /TELEGRAM_API_ID/u,
    );
    expect(() => parseConfig({ CLASSIFIER_ENABLED: "true" })).toThrow(
      /CLASSIFIER_PROVIDER/u,
    );
  });

  it("redacts every configured secret and database URL", () => {
    const secrets = {
      APP_API_TOKEN: "app-token-value",
      DATABASE_URL: "postgresql://user:db-password@db.internal:5432/app",
      TELEGRAM_API_ID: "12345",
      TELEGRAM_API_HASH: "telegram-hash-value",
      TELEGRAM_SESSION_PATH: "/private/session-value",
      CLASSIFIER_API_TOKEN: "classifier-token-value",
    };
    const redactedJson = JSON.stringify(redactConfig(parseConfig(secrets)));

    for (const secret of Object.values(secrets)) {
      if (secret === secrets.TELEGRAM_API_ID) {
        continue;
      }
      expect(redactedJson).not.toContain(secret);
    }
    expect(redactedJson).toContain("[REDACTED]");
    expect(redactedJson).toContain("12345");
  });
});
