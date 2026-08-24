import { serve } from "@hono/node-server";
import { createLogger, getConfig, redactConfig } from "@hn-knowledge/config";
import { disconnectDatabase } from "@hn-knowledge/db";

import { app } from "./app.js";

const config = getConfig();
const logger = createLogger(config, { component: "server", role: "api" });
const server = serve({
  fetch: app.fetch,
  hostname: "0.0.0.0",
  port: config.PORT,
});

logger.info(
  {
    config: redactConfig(config),
    event: "api_started",
    host: "0.0.0.0",
    port: config.PORT,
  },
  "API started",
);

let shutdownStarted = false;

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;

  logger.info({ event: "api_shutdown_started", signal }, "API stopping");
  const forceExit = setTimeout(() => {
    logger.error(
      { event: "api_shutdown_timed_out", signal },
      "API shutdown timed out",
    );
    process.exitCode = 1;
  }, config.SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await disconnectDatabase();
    logger.info({ event: "api_stopped", signal }, "API stopped");
  } catch (error) {
    logger.error(
      {
        event: "api_shutdown_failed",
        errorName: error instanceof Error ? error.name : "UnknownError",
        signal,
      },
      "API shutdown failed",
    );
    process.exitCode = 1;
  } finally {
    clearTimeout(forceExit);
  }
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}
