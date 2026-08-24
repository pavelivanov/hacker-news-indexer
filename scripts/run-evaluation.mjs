import { spawnSync } from "node:child_process";

const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

run("npm", ["run", "evaluation:validate-corpus"]);
run("npm", [
  "run",
  "eval",
  "--",
  "--corpus",
  "evaluation/gold-v1.jsonl",
  "--provider",
  "fixture",
]);
run("npm", ["run", "classify:shadow", "--", "--corpus", "seed-v1"]);
run("npx", ["vitest", "run", "--config", "vitest.evaluation.config.ts"]);
