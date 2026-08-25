import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("evaluation source capture", () => {
  it("refuses to overwrite the frozen seed before making requests", () => {
    const result = spawnSync(process.execPath, ["scripts/capture-seed.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Refusing to overwrite existing capture");
    expect(result.stderr).not.toContain("Capture request failed");
  });

  it("rejects an unbounded window before creating a capture", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/capture-seed.mjs",
        "--min-id",
        "1",
        "--max-id",
        "1000",
        "--output-dir",
        "/tmp/hn-evaluation-invalid-window",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Capture window must contain 90 to 150 messages",
    );
  });
});
