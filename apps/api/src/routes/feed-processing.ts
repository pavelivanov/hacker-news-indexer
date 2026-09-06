import type { FeedProcessingService } from "@hn-knowledge/application";
import { FeedProcessingError } from "@hn-knowledge/domain";
import type { Context, Hono } from "hono";
import type { HealthBindings } from "./health.js";
import { readBoundedJsonBody } from "./manual-review.js";

const execute = async (
  context: Context<HealthBindings>,
  action: () => Promise<unknown>,
) => {
  try {
    if ([...new URL(context.req.url).searchParams].length)
      throw new TypeError("Invalid query");
    return context.json(await action());
  } catch (error) {
    if (error instanceof TypeError)
      return context.json({ error: "invalid_request" }, 400);
    if (error instanceof FeedProcessingError)
      return context.json(
        { error: error.code.toLowerCase() },
        error.code === "NOT_FOUND" ? 404 : 409,
      );
    throw error;
  }
};
export const registerFeedProcessingRoutes = (
  app: Hono<HealthBindings>,
  service: FeedProcessingService,
) => {
  app.get("/v1/processing", (context) =>
    execute(context, () => service.status()),
  );
  app.put("/v1/processing/settings", (context) =>
    execute(context, async () =>
      service.saveSettings(await readBoundedJsonBody(context)),
    ),
  );
  app.post("/v1/processing/control", (context) =>
    execute(context, async () =>
      service.control(await readBoundedJsonBody(context)),
    ),
  );
  for (const kind of ["job", "result"] as const) {
    app.post(`/v1/processing/${kind}s/:id/retry`, (context) =>
      execute(context, async () =>
        service.retry(
          kind,
          context.req.param("id"),
          await readBoundedJsonBody(context),
        ),
      ),
    );
  }
};
