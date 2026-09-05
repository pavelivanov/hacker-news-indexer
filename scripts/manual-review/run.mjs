import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { parseEnv } from "node:util";
import { checkTarget } from "./target.mjs";

const [mode, script, ...args] = process.argv.slice(2);
if (
  !["test", "local"].includes(mode) ||
  !script ||
  !/^[a-z0-9:-]+$/.test(script)
)
  throw new Error("Invalid local command");
const env = parseEnv(await readFile(`.env.manual-review.${mode}`, "utf8"));
checkTarget(
  env.DATABASE_URL,
  mode === "test" ? "hn_manual_review_test" : "hn_manual_review",
);
if (
  env.CLASSIFIER_ENABLED !== "false" ||
  env.TELEGRAM_ENABLED !== "false" ||
  env.HOST !== "127.0.0.1"
) {
  throw new Error(
    "Local manual review requires loopback and disabled classifier/Telegram",
  );
}
const child = spawn(
  "npm",
  [
    "run",
    script,
    ...(args.length
      ? ["--", ...args.filter((arg, index) => index !== 0 || arg !== "--")]
      : []),
  ],
  {
    env: { ...process.env, ...env },
    stdio: "inherit",
  },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("error", () => {
  console.error("Unable to start local command");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
