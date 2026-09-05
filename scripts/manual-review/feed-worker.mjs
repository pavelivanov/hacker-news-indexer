import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
import { checkTarget } from "./target.mjs";

const local = parseEnv(await readFile(".env.manual-review.local", "utf8"));
checkTarget(local.DATABASE_URL, "hn_manual_review");
if (
  local.HOST !== "127.0.0.1" ||
  local.CLASSIFIER_ENABLED !== "false" ||
  local.TELEGRAM_ENABLED !== "false"
)
  throw new Error("Daily feed requires the isolated local workspace");
let source = {};
try {
  source = parseEnv(await readFile(".env", "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const allowed = [
  "TELEGRAM_API_ID",
  "TELEGRAM_API_HASH",
  "TELEGRAM_SESSION",
  "TELEGRAM_SOURCE_KEY",
  "CLASSIFIER_PROVIDER",
  "CLASSIFIER_MODEL",
  "CLASSIFIER_API_TOKEN",
  "CLASSIFIER_REASONING_EFFORT",
];
const provider = Object.fromEntries(
  allowed.filter((key) => source[key]).map((key) => [key, source[key]]),
);
const child = spawn(
  "node",
  ["--enable-source-maps", "apps/worker/dist/daily-feed.js"],
  {
    env: { ...process.env, ...local, ...provider },
    stdio: "inherit",
  },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => {
  process.exitCode = code ?? 0;
});
child.on("error", () => {
  console.error("Unable to start daily feed worker");
  process.exitCode = 1;
});
