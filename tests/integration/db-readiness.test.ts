import { afterAll, describe, expect, it } from "vitest";

import { createApp } from "@hn-knowledge/api";
import { createDatabase, type Database } from "@hn-knowledge/db";

const databaseUrl =
  process.env["DATABASE_URL"] ??
  "postgresql://hn_knowledge:hn_knowledge@127.0.0.1:5432/hn_knowledge";

const databases: Database[] = [];

afterAll(async () => {
  await Promise.all(databases.map(async (database) => database.close()));
});

describe("database readiness", () => {
  it("reports ready when PostgreSQL is reachable", async () => {
    const database = createDatabase({ connectionString: databaseUrl });
    databases.push(database);
    const app = createApp({
      checkReadiness: async () => database.check(2_000),
    });

    const response = await app.request("/readyz", {
      headers: { "x-request-id": "database-ready" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("reports not ready without exposing connection details", async () => {
    const invalidDatabase = createDatabase({
      connectionString:
        "postgresql://private-user:private-password@127.0.0.1:1/private-db",
      connectionTimeoutMs: 150,
    });
    databases.push(invalidDatabase);
    const app = createApp({
      checkReadiness: async () => invalidDatabase.check(250),
    });

    const response = await app.request("/readyz", {
      headers: { "x-request-id": "database-not-ready" },
    });
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(body)).toEqual({
      error: "not_ready",
      requestId: "database-not-ready",
    });
    expect(body).not.toContain("private-user");
    expect(body).not.toContain("private-password");
    expect(body).not.toContain("private-db");
  });
});
