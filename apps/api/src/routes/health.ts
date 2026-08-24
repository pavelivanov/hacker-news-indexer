import type { Context, Hono } from "hono";

import type { HealthResponse } from "@hn-knowledge/contracts";

export interface HealthBindings {
  Variables: {
    requestId: string;
  };
}

export const registerHealthRoutes = (
  app: Hono<HealthBindings>,
  checkReadiness: () => Promise<void>,
): void => {
  app.get("/healthz", (context: Context<HealthBindings>) => {
    const response: HealthResponse = { status: "ok" };
    return context.json(response, 200);
  });

  app.get("/readyz", async (context: Context<HealthBindings>) => {
    try {
      await checkReadiness();
      const response: HealthResponse = { status: "ok" };
      return context.json(response, 200);
    } catch {
      return context.json(
        {
          error: "not_ready" as const,
          requestId: context.get("requestId"),
        },
        503,
      );
    }
  });
};
