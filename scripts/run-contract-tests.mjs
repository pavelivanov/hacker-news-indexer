import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const targetIndex = args.indexOf("--target");
const target = targetIndex < 0 ? null : (args[targetIndex + 1] ?? null);
const dryRun = args.includes("--dry-run");

if (target === "findthatproject" && !dryRun) {
  throw new Error("FindThatProject contract validation requires --dry-run");
}
if (
  target !== null &&
  !["findthatproject", "hn", "telegram"].includes(target)
) {
  throw new Error(`Unsupported contract target: ${target}`);
}

const result = spawnSync(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    "--config",
    "vitest.contract.config.ts",
  ],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(target === null ? {} : { CONTRACT_SOURCE: target }),
      ...(dryRun ? { CONTRACT_DRY_RUN: "true" } : {}),
    },
    stdio: "inherit",
  },
);

if (result.error !== undefined) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
