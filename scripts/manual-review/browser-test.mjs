import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { checkTarget } from "./target.mjs";

const [suite, ...args] = process.argv.slice(2);
if (!["e2e", "a11y"].includes(suite))
  throw new Error("Expected e2e or a11y suite");
let env;
try {
  env = parseEnv(await readFile(".env.manual-review.test", "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  env = {};
}
const databaseUrl = process.env.DATABASE_URL ?? env.DATABASE_URL;
checkTarget(databaseUrl, "hn_manual_review_test");
const child = spawn(
  "npm",
  [
    "run",
    "e2e",
    "-w",
    "@hn-knowledge/web",
    "--",
    suite === "a11y" ? "--grep" : "--grep-invert",
    "@a11y",
    ...args,
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      APP_API_TOKEN: randomBytes(32).toString("hex"),
      APP_REVIEW_ACTOR_ID: "browser-test",
      HOST: "127.0.0.1",
      PORT: "3101",
      NODE_ENV: "test",
      CLASSIFIER_ENABLED: "false",
      TELEGRAM_ENABLED: "false",
      MANUAL_REVIEW_TEST_RUN: "1",
    },
  },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("error", () => {
  console.error("Unable to start browser tests");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
