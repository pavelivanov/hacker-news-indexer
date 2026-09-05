import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";
import pg from "pg";
import { checkTarget } from "./target.mjs";

const mode = process.argv[2];
if (!["local", "test"].includes(mode) || process.argv.length !== 3)
  throw new Error("Expected local or test mode");
const target = mode === "test" ? "hn_manual_review_test" : "hn_manual_review";
const file = `.env.manual-review.${mode}`;
const adminUrl = checkTarget(
  process.env.MANUAL_REVIEW_ADMIN_URL ??
    "postgresql://hn_knowledge:hn_knowledge@127.0.0.1:5432/postgres",
  "postgres",
);
const targetUrl = new URL(adminUrl);
targetUrl.pathname = `/${target}`;
let env;
try {
  env = parseEnv(await readFile(file, "utf8"));
  checkTarget(env.DATABASE_URL, target);
  if (
    env.CLASSIFIER_ENABLED !== "false" ||
    env.TELEGRAM_ENABLED !== "false" ||
    !env.APP_API_TOKEN
  ) {
    throw new Error(
      "Local environment must disable classifier/Telegram and supply a private local token",
    );
  }
  // Never migrate a different server from the one this command provisions.
  if (
    new URL(env.DATABASE_URL).origin !== targetUrl.origin ||
    new URL(env.DATABASE_URL).host !== targetUrl.host
  ) {
    throw new Error("Local environment and provisioning server differ");
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  env = {
    DATABASE_URL: targetUrl.href,
    CLASSIFIER_ENABLED: "false",
    TELEGRAM_ENABLED: "false",
    APP_API_TOKEN: randomBytes(32).toString("hex"),
    APP_REVIEW_ACTOR_ID: "owner",
    HOST: "127.0.0.1",
    PORT: mode === "test" ? "3101" : "3100",
    NODE_ENV: mode === "test" ? "test" : "development",
  };
  await writeFile(
    file,
    Object.entries(env)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n") + "\n",
    { flag: "wx", mode: 0o600 },
  );
}
const admin = new pg.Client({ connectionString: adminUrl.href });
await admin.connect();
try {
  const result = await admin.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [target],
  );
  if (result.rowCount === 0) await admin.query(`CREATE DATABASE "${target}"`);
} finally {
  await admin.end();
}

for (const script of mode === "test"
  ? ["db:migrate:deploy"]
  : ["db:migrate:deploy", "seed:replay"]) {
  const result = spawnSync("npm", ["run", script], {
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(
  `Prepared ${target}; environment saved in ${file}. Existing data was preserved.`,
);
