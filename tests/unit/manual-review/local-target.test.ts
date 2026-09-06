import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const check = (databaseUrl: string) =>
  execFileSync(process.execPath, ["scripts/manual-review/target.mjs"], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
    encoding: "utf8",
  });
describe("destructive test target guard", () => {
  it("accepts the explicit disposable loopback database", () => {
    expect(
      check("postgresql://fixture@127.0.0.1:5432/hn_manual_review_test"),
    ).toContain("verified");
  });
  it.each([
    "",
    "postgresql://fixture@127.0.0.1/hn_manual_review",
    "postgresql://fixture@remote.example/hn_manual_review_test",
    "postgresql://fixture@127.0.0.1/hn_manual_review_test?host=remote.example",
    "postgresql://fixture@127.0.0.1/hn_knowledge",
  ])("refuses unsafe target %s", (value) => {
    expect(() => check(value)).toThrow();
  });
});
