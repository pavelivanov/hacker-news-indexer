import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { checkTarget } from "./target.mjs";

const mode = process.argv[2];
if (!["local", "test"].includes(mode) || process.argv.length !== 3)
  throw new Error("Expected local or test mode");
const env =
  mode === "test" && process.env.MANUAL_REVIEW_TEST_RUN === "1"
    ? process.env
    : parseEnv(await readFile(`.env.manual-review.${mode}`, "utf8"));
checkTarget(
  env.DATABASE_URL,
  mode === "test" ? "hn_manual_review_test" : "hn_manual_review",
);
const apiPort = mode === "test" ? 3101 : 3100;
const webPort = mode === "test" ? 5174 : 5173;
if (
  env.HOST !== "127.0.0.1" ||
  env.CLASSIFIER_ENABLED !== "false" ||
  env.TELEGRAM_ENABLED !== "false" ||
  !env.APP_API_TOKEN ||
  env.PORT !== String(apiPort)
)
  throw new Error("Invalid local manual-review configuration");

for (const port of [apiPort, webPort]) {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () =>
      reject(
        new Error(
          `Port ${port} is occupied. Stop that service before starting manual review.`,
        ),
      ),
    );
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
}

const children = [];
let stopping = false;
const signalGroup = (child, signal) => {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};
const stop = (code) => {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) signalGroup(child, "SIGINT");
  const timer = setTimeout(() => {
    for (const child of children) signalGroup(child, "SIGKILL");
  }, 8000);
  timer.unref();
};
const start = (script, environment) => {
  const child = spawn("npm", ["run", script], {
    env: environment,
    stdio: "inherit",
    detached: true,
  });
  children.push(child);
  child.on("error", () => {
    console.error(`Unable to start ${script}`);
    stop(1);
  });
  child.on("exit", (code) => {
    if (!stopping) stop(code ?? 1);
  });
};
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
start("start:api", { ...process.env, ...env });
if (mode === "local") start("feed:worker", { ...process.env, ...env });
// Only process essentials and the public loopback ports reach the Vite process.
const webEnv = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "SystemRoot"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
start("dev:web", {
  ...webEnv,
  MANUAL_REVIEW_API_PORT: String(apiPort),
  MANUAL_REVIEW_WEB_PORT: String(webPort),
});
console.log(
  `Knowledge workspace: http://127.0.0.1:${webPort} (API on loopback port ${apiPort}). Ctrl-C stops the workspace and its workers.`,
);
