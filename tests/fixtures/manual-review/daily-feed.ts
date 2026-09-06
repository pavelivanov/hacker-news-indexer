import { FixtureHnItems, TelegramMtprotoSource } from "@hn-knowledge/adapters";
import { setTimeout as delay } from "node:timers/promises";
import { createDailyFeedRuntime } from "@hn-knowledge/worker/daily-feed-runtime";
import {
  createFeedProcessingRepository,
  type Database,
} from "@hn-knowledge/db";
import {
  ClassifierProviderError,
  type ClassifierPort,
  type SelectionSource,
} from "@hn-knowledge/ports";
import { resultHasher } from "./classifier-result.js";
import { manualOutput } from "./output.js";

export const dailyFeedFixture = async (database: Database) => {
  const url = process.env["DATABASE_URL"];
  if (
    !url ||
    new URL(url).pathname !== "/hn_manual_review_test" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)
  )
    throw new Error("Daily feed fixtures require the isolated test database");
  const state = {
    latest: 2,
    sourceFails: false,
    invalidOutput: false,
    providerFails: false,
    calls: 0,
    latestCalls: 0,
    onLatest: null as (() => Promise<void>) | null,
    ranges: [] as Array<[number, number]>,
  };
  const messages = new TelegramMtprotoSource(
    {
      getMessages: async (_source, ids) => {
        if (state.sourceFails) throw new Error("fixture-source-failure");
        return ids.map((id) => ({
          id,
          date: new Date(),
          editDate: null,
          text: "Story Comment",
          entities: [
            {
              kind: "text_link",
              offset: 0,
              length: 5,
              url: "https://news.ycombinator.com/item?id=910000",
            },
            {
              kind: "text_link",
              offset: 6,
              length: 7,
              url: `https://news.ycombinator.com/item?id=${910000 + id}`,
            },
          ],
        }));
      },
    },
    { hasher: resultHasher, retryCount: 0 },
  );
  const source: SelectionSource = {
    async *readRange(range) {
      state.ranges.push([Number(range.minId), Number(range.maxId)]);
      yield* messages.readRange(range);
    },
  };
  const classifier: ClassifierPort = {
    provider: "fixture",
    modelId: "daily-fixture",
    modelConfigId: "daily-fixture:v1",
    async classify(request) {
      state.calls += 1;
      if (state.providerFails)
        throw new ClassifierProviderError("CLASSIFIER_AUTH", false);
      return {
        rawOutput: state.invalidOutput
          ? "{}"
          : JSON.stringify(manualOutput(request.input, "EXPERT_NOTE")),
        provider: "fixture",
        modelId: "daily-fixture",
        modelConfigId: "daily-fixture:v1",
        latencyMs: 1,
        inputTokens: 10,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 10,
      };
    },
  };
  const processing = createFeedProcessingRepository(database.client);
  await processing.initialize("fixture-channel");
  await processing.heartbeat();
  await database.client.feedProcessingState.update({
    where: { id: "local" },
    data: { batchSize: 2 },
  });
  const runtime = createDailyFeedRuntime({
    database,
    classifier,
    hasher: resultHasher,
    owner: "fixture-worker",
    source: async () => ({
      source,
      latestId: async () => {
        state.latestCalls += 1;
        await state.onLatest?.();
        return state.latest;
      },
    }),
    hnItems: new FixtureHnItems({
      capturedAt: "2026-09-05T00:00:00Z",
      items: [
        {
          id: 910000,
          type: "story",
          title: "WidgetDB internals",
          responseHash: "fixture-root",
        },
        ...[1, 2, 3, 4].map((id) => ({
          id: 910000 + id,
          type: "comment",
          parent: 910000,
          text: "<p>WidgetDB batches writes to reduce disk synchronization.</p>",
          responseHash: `fixture-${id}`,
        })),
      ],
    }),
  });
  const drain = async () => {
    // Like the real polling worker, allow newly timestamped jobs to become ready.
    // A single idle tick is not proof that the immediate queue has settled.
    let idleTicks = 0;
    for (let i = 0; i < 40; i += 1) {
      if ((await runtime.tick()) === "idle") {
        idleTicks += 1;
        if (idleTicks === 3) return;
        await delay(10);
      } else idleTicks = 0;
    }
    throw new Error("Fixture did not drain within its bound");
  };
  return { state, classifier, runtime, drain };
};
