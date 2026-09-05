import type { ClassifierResultsService } from "@hn-knowledge/application";
import { ClassifierResultsError } from "@hn-knowledge/domain";
import type { Context, Hono } from "hono";
import type { HealthBindings } from "./health.js";
import { readBoundedJsonBody } from "./manual-review.js";

const id = (context: Context<HealthBindings>) => {
  const value = context.req.param("id");
  if (
    !value ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new TypeError("Invalid result ID");
  return value;
};
const execute = async (
  context: Context<HealthBindings>,
  action: () => Promise<unknown>,
  keys: readonly string[] = [],
) => {
  try {
    const query = new URL(context.req.url).searchParams;
    for (const key of query.keys())
      if (!keys.includes(key) || query.getAll(key).length !== 1)
        throw new TypeError("Invalid query");
    return context.json(await action());
  } catch (error) {
    if (error instanceof TypeError)
      return context.json({ error: "invalid_request" }, 400);
    if (error instanceof ClassifierResultsError)
      return context.json(
        { error: error.code.toLowerCase() },
        error.code === "NOT_FOUND" ? 404 : 409,
      );
    throw error;
  }
};
export const registerClassifierResultsRoutes = (
  app: Hono<HealthBindings>,
  service: ClassifierResultsService,
): void => {
  app.get("/v1/classifier-results", (context) =>
    execute(
      context,
      () =>
        service.list(
          (context.req.query("filter") ?? "all") as Parameters<
            ClassifierResultsService["list"]
          >[0],
          context.req.query("cursor") ?? null,
        ),
      ["filter", "cursor"],
    ),
  );
  app.get("/v1/classifier-results/:id", (context) =>
    execute(context, () => service.get(id(context))),
  );
  app.post("/v1/classifier-results/:id/corrections", (context) =>
    execute(context, async () =>
      service.correct(id(context), await readBoundedJsonBody(context)),
    ),
  );
};
