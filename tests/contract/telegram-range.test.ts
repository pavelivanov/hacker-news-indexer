import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createMtcuteTelegramSource } from "@hn-knowledge/adapters";
import { parseConfig } from "@hn-knowledge/config";
import { telegramMessageId } from "@hn-knowledge/domain";

describe.skipIf(process.env["CONTRACT_SOURCE"] !== "telegram")(
  "Telegram exact range contract",
  () => {
    it("reads the documented 100 IDs without source-body logging", async () => {
      const config = parseConfig(process.env);
      if (
        !config.TELEGRAM_ENABLED ||
        config.TELEGRAM_API_ID === undefined ||
        config.TELEGRAM_API_HASH === undefined
      ) {
        throw new Error("Telegram contract credentials are not enabled");
      }
      const telegram = createMtcuteTelegramSource({
        apiId: config.TELEGRAM_API_ID,
        apiHash: config.TELEGRAM_API_HASH,
        sessionPath: config.TELEGRAM_SESSION_PATH,
        hasher: {
          sha256: (value) => createHash("sha256").update(value).digest("hex"),
        },
        requestTimeoutMs: config.TELEGRAM_REQUEST_TIMEOUT_MS,
        maxFloodWaitMs: config.TELEGRAM_MAX_FLOOD_WAIT_MS,
      });
      try {
        const ids: number[] = [];
        for await (const occurrence of telegram.source.readRange({
          source: "TELEGRAM",
          sourceKey: config.TELEGRAM_SOURCE_KEY,
          minId: telegramMessageId(32_847),
          maxId: telegramMessageId(32_946),
        })) {
          ids.push(occurrence.externalId);
        }
        expect(ids).toEqual(
          Array.from({ length: 100 }, (_value, index) => 32_847 + index),
        );
      } finally {
        await telegram.close();
      }
    });
  },
);
