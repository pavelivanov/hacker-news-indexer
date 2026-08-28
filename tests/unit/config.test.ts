import { describe, expect, it } from "vitest";

import {
  parseConfig,
  railwayLogBindings,
  redactConfig,
} from "@hn-knowledge/config";

describe("application configuration", () => {
  it("applies safe defaults without requiring external credentials", () => {
    const config = parseConfig({});

    expect(config).toMatchObject({
      NODE_ENV: "development",
      LOG_LEVEL: "info",
      PORT: 3000,
      APP_REVIEW_ACTOR_ID: "owner",
      TELEGRAM_ENABLED: false,
      CLASSIFIER_ENABLED: false,
      CLASSIFIER_REASONING_EFFORT: "low",
      DATABASE_READY_TIMEOUT_MS: 2_000,
      INGESTION_MAX_RANGE: 1_000,
      WORKER_CONCURRENCY: 4,
      WORKER_HEARTBEAT_INTERVAL_MS: 60_000,
    });
    expect(config.TELEGRAM_API_HASH).toBeUndefined();
    expect(config.TELEGRAM_SESSION).toBeUndefined();
    expect(config.CLASSIFIER_API_TOKEN).toBeUndefined();
    expect(config.EXPORT_CONSUMER_TOKEN).toBeUndefined();
  });

  it.each([
    ["PORT", "0"],
    ["PORT", "65536"],
    ["PORT", "not-a-number"],
    ["DATABASE_READY_TIMEOUT_MS", "99"],
    ["WORKER_HEARTBEAT_INTERVAL_MS", "9"],
    ["TELEGRAM_REQUEST_TIMEOUT_MS", "nope"],
    ["CLASSIFIER_REASONING_EFFORT", "extreme"],
  ])("rejects invalid value for %s", (key, value) => {
    expect(() => parseConfig({ [key]: value })).toThrow();
  });

  it("requires integration credentials only when the integration is enabled", () => {
    expect(() => parseConfig({ TELEGRAM_ENABLED: "true" })).toThrow(
      /TELEGRAM_API_ID/u,
    );
    expect(() =>
      parseConfig({
        TELEGRAM_ENABLED: "true",
        TELEGRAM_API_ID: "12345",
        TELEGRAM_API_HASH: "telegram-hash-value",
      }),
    ).toThrow(/TELEGRAM_SESSION/u);
    expect(() => parseConfig({ CLASSIFIER_ENABLED: "true" })).toThrow(
      /CLASSIFIER_PROVIDER/u,
    );
  });

  it("requires the export consumer credential to differ from the reviewer token", () => {
    expect(() =>
      parseConfig({
        APP_API_TOKEN: "shared-token",
        EXPORT_CONSUMER_TOKEN: "shared-token",
      }),
    ).toThrow(/must differ/u);
  });

  it("redacts every configured secret and database URL", () => {
    const secrets = {
      APP_API_TOKEN: "app-token-value",
      EXPORT_CONSUMER_TOKEN: "export-consumer-token-value",
      DATABASE_URL: "postgresql://user:db-password@db.internal:5432/app",
      TELEGRAM_API_ID: "12345",
      TELEGRAM_API_HASH: "telegram-hash-value",
      TELEGRAM_SESSION: "telegram-session-value",
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

  it("maps optional Railway runtime identity into safe structured-log bindings", () => {
    const config = parseConfig({
      RAILWAY_PROJECT_ID: "project-id",
      RAILWAY_ENVIRONMENT_ID: "environment-id",
      RAILWAY_ENVIRONMENT_NAME: "staging",
      RAILWAY_SERVICE_ID: "service-id",
      RAILWAY_SERVICE_NAME: "worker",
      RAILWAY_DEPLOYMENT_ID: "deployment-id",
      RAILWAY_REPLICA_ID: "replica-id",
      RAILWAY_REPLICA_REGION: "us-west2",
      RAILWAY_GIT_COMMIT_SHA: "commit-sha",
    });

    expect(railwayLogBindings(config)).toEqual({
      railwayProjectId: "project-id",
      railwayEnvironmentId: "environment-id",
      railwayEnvironmentName: "staging",
      railwayServiceId: "service-id",
      railwayServiceName: "worker",
      railwayDeploymentId: "deployment-id",
      railwayReplicaId: "replica-id",
      railwayReplicaRegion: "us-west2",
      railwayGitCommitSha: "commit-sha",
    });
    expect(railwayLogBindings(parseConfig({}))).toEqual({});
  });
});
