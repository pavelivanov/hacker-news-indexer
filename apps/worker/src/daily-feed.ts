import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  createMtcuteTelegramSource,
  HackerNewsApiItems,
  OpenAiClassifier,
} from "@hn-knowledge/adapters";
import {
  createDatabase,
  createFeedProcessingRepository,
  acquireFeedLock,
} from "@hn-knowledge/db";
import { getConfig } from "@hn-knowledge/config";
import { createDailyFeedRuntime } from "./daily-feed-runtime.js";

const config = getConfig();
const target = new URL(config.DATABASE_URL);
if (
  target.pathname !== "/hn_manual_review" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
)
  throw new Error("Daily feed requires the isolated local workspace");
const database = createDatabase({ connectionString: config.DATABASE_URL });
const processing = createFeedProcessingRepository(database.client);
const controller = new AbortController();
const stopped = () => controller.signal.aborted;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => controller.abort());
const lock = await acquireFeedLock(config.DATABASE_URL, () => {
  console.error("Daily feed stopped: database ownership was lost.");
  process.exit(1);
});
const hasher = {
  sha256: (value: string) => createHash("sha256").update(value).digest("hex"),
};
let telegram: Awaited<ReturnType<typeof createMtcuteTelegramSource>> | null =
  null;
const closeTelegram = async () => {
  await telegram?.close();
};
await processing.initialize(config.TELEGRAM_SOURCE_KEY);
const heartbeat = setInterval(() => {
  void processing.heartbeat().catch(() => {
    console.error("Daily feed stopped: database heartbeat failed.");
    process.exit(1);
  });
}, 5000);
try {
  await processing.heartbeat(null);
  if (
    !config.CLASSIFIER_API_TOKEN ||
    !config.CLASSIFIER_MODEL ||
    config.CLASSIFIER_PROVIDER !== "openai"
  ) {
    await processing.heartbeat("CLASSIFIER_CONFIG");
    while (!controller.signal.aborted)
      await delay(1000, undefined, { signal: controller.signal });
  } else {
    const runtime = createDailyFeedRuntime({
      database,
      owner: `daily-feed-${randomUUID()}`,
      signal: controller.signal,
      hasher,
      onLeaseLost: () => {
        console.error("Daily feed stopped: job ownership was lost.");
        process.exit(1);
      },
      classifier: new OpenAiClassifier({
        apiToken: config.CLASSIFIER_API_TOKEN,
        modelId: config.CLASSIFIER_MODEL,
        reasoningEffort: config.CLASSIFIER_REASONING_EFFORT,
      }),
      hnItems: new HackerNewsApiItems({
        hasher,
        clock: { now: () => new Date() },
        timeoutMs: config.HN_REQUEST_TIMEOUT_MS,
      }),
      source: async () => {
        if (!telegram) {
          if (
            !config.TELEGRAM_API_ID ||
            !config.TELEGRAM_API_HASH ||
            !config.TELEGRAM_SESSION
          )
            throw new Error("SOURCE_CREDENTIALS_MISSING");
          telegram = await createMtcuteTelegramSource({
            apiId: config.TELEGRAM_API_ID,
            apiHash: config.TELEGRAM_API_HASH,
            session: config.TELEGRAM_SESSION,
            hasher,
            requestTimeoutMs: config.TELEGRAM_REQUEST_TIMEOUT_MS,
            maxFloodWaitMs: config.TELEGRAM_MAX_FLOOD_WAIT_MS,
          });
        }
        return telegram;
      },
    });
    while (!stopped()) {
      try {
        const result = await runtime.tick();
        if (result === "idle")
          await delay(1000, undefined, { signal: controller.signal });
      } catch (error) {
        if (stopped()) break;
        await processing.heartbeat("PROCESSING_ERROR");
        console.error(
          JSON.stringify({
            event: "daily_feed_tick_failed",
            error: error instanceof Error ? error.name : "Error",
          }),
        );
        await delay(5000, undefined, { signal: controller.signal });
      }
    }
  }
} catch (error) {
  if (!controller.signal.aborted) throw error;
} finally {
  clearInterval(heartbeat);
  await closeTelegram();
  await database.client.feedProcessingState.update({
    where: { id: "local" },
    data: { heartbeatAt: null },
  });
  await lock.close();
  await database.close();
}
