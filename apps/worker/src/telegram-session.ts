import { createHash } from "node:crypto";

import { createMtcuteTelegramSource } from "@hn-knowledge/adapters";
import { getConfig } from "@hn-knowledge/config";

const main = async (): Promise<void> => {
  const config = getConfig();
  if (
    config.TELEGRAM_API_ID === undefined ||
    config.TELEGRAM_API_HASH === undefined ||
    config.TELEGRAM_SESSION === undefined
  ) {
    throw new Error("Telegram session credentials are not configured");
  }
  const telegram = await createMtcuteTelegramSource({
    apiId: config.TELEGRAM_API_ID,
    apiHash: config.TELEGRAM_API_HASH,
    session: config.TELEGRAM_SESSION,
    hasher: {
      sha256: (value) => createHash("sha256").update(value).digest("hex"),
    },
    requestTimeoutMs: config.TELEGRAM_REQUEST_TIMEOUT_MS,
    maxFloodWaitMs: config.TELEGRAM_MAX_FLOOD_WAIT_MS,
  });
  try {
    console.log(
      JSON.stringify({
        event: "telegram_session_ready",
        sessionFormat: telegram.sessionFormat,
      }),
    );
  } finally {
    await telegram.close();
  }
};

try {
  await main();
} catch (error) {
  console.error(
    JSON.stringify({
      errorName: error instanceof Error ? error.name : "UnknownError",
      event: "telegram_session_init_failed",
    }),
  );
  process.exitCode = 1;
}
