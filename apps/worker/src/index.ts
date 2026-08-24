import { createLogger, getConfig, redactConfig } from "@hn-knowledge/config";

const config = getConfig();
const logger = createLogger(config, { component: "worker", role: "worker" });

const waitForShutdownSignal = async (): Promise<NodeJS.Signals> =>
  new Promise((resolve) => {
    let settled = false;
    const handlers = new Map<NodeJS.Signals, () => void>();
    const keepAlive = setInterval(() => undefined, 2_147_000_000);

    const cleanup = (): void => {
      clearInterval(keepAlive);
      for (const [signal, handler] of handlers) {
        process.off(signal, handler);
      }
    };

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(signal);
      };
      handlers.set(signal, handler);
      process.once(signal, handler);
    }
  });

logger.info(
  { config: redactConfig(config), event: "worker_started" },
  "Worker started without job claiming enabled",
);

const signal = await waitForShutdownSignal();
logger.info({ event: "worker_stopped", signal }, "Worker stopped");
