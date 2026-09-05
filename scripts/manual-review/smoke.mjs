import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { checkTarget } from "./target.mjs";

const env = parseEnv(await readFile(".env.manual-review.local", "utf8"));
checkTarget(env.DATABASE_URL, "hn_manual_review");
if (
  env.HOST !== "127.0.0.1" ||
  !/^[0-9]+$/.test(env.PORT ?? "") ||
  Number(env.PORT) < 1 ||
  Number(env.PORT) > 65535 ||
  !env.APP_API_TOKEN ||
  env.CLASSIFIER_ENABLED !== "false" ||
  env.TELEGRAM_ENABLED !== "false"
) {
  throw new Error("Invalid local manual-review configuration");
}
const origin = `http://127.0.0.1:${env.PORT}`;
const get = async (path) => {
  const response = await fetch(new URL(path, origin), {
    headers: { authorization: `Bearer ${env.APP_API_TOKEN}` },
    signal: globalThis.AbortSignal.timeout(5000),
  });
  if (!response.ok)
    throw new Error(`Local smoke request failed (${response.status})`);
  return response.json();
};
await get("/healthz");
await get("/readyz");
const unauthenticated = await fetch(`${origin}/v1/manual-review/inbox`, {
  signal: globalThis.AbortSignal.timeout(5000),
});
if (unauthenticated.status !== 401)
  throw new Error("Manual review must require authentication");
let count = 0;
let cursor = null;
let firstId = null;
for (let page = 0; ; page += 1) {
  if (page >= 1000) throw new Error("Inbox pagination did not terminate");
  const response = await get(
    `/v1/manual-review/inbox?state=all${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
  );
  if (!Array.isArray(response.items)) throw new Error("Invalid inbox response");
  count += response.items.length;
  firstId ??= response.items[0]?.comment_id ?? null;
  cursor = response.next_cursor;
  if (cursor === null) break;
  if (typeof cursor !== "string") throw new Error("Invalid inbox cursor");
}
if (firstId !== null) {
  const detail = await get(`/v1/manual-review/comments/${firstId}`);
  if (!/^[a-f0-9]{64}$/.test(detail.source_hash))
    throw new Error("Missing source fingerprint");
}
console.log(
  JSON.stringify({
    ready: true,
    authenticationRequired: true,
    storedComments: count,
    classifierEnabled: false,
    mutations: 0,
  }),
);
