import { ManualReviewError } from "@hn-knowledge/domain";
import type { ManualReviewService } from "@hn-knowledge/application";
import type { ManualInboxState } from "@hn-knowledge/ports";
import { parseManualRebase } from "@hn-knowledge/contracts";
import type { Context, Hono } from "hono";
import type { HealthBindings } from "./health.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const identifier = (
  context: Context<HealthBindings>,
  numeric = false,
): string => {
  const id = context.req.param("id");
  if (
    !id ||
    (numeric
      ? !/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))
      : !UUID.test(id))
  ) {
    throw new TypeError("Invalid identifier");
  }
  return id;
};
const textBody = async (context: Context<HealthBindings>): Promise<string> => {
  const reader = context.req.raw.body?.getReader();
  if (!reader) return "";
  let size = 0;
  let text = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      const bytes: unknown = chunk.value;
      if (!(bytes instanceof Uint8Array))
        throw new TypeError("Invalid request stream");
      size += bytes.byteLength;
      if (size > 131_072) {
        await reader.cancel();
        throw new TypeError("Request too large");
      }
      text += decoder.decode(bytes, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
};
export const readBoundedJsonBody = async (
  context: Context<HealthBindings>,
): Promise<unknown> => {
  const raw = await textBody(context);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new TypeError("Invalid JSON");
  }
};
const execute = async (
  context: Context<HealthBindings>,
  action: () => Promise<unknown>,
  queries: readonly string[] = [],
) => {
  try {
    const params = new URL(context.req.url).searchParams;
    for (const key of params.keys()) {
      if (!queries.includes(key) || params.getAll(key).length !== 1)
        throw new TypeError("Invalid query");
    }
    return context.json(await action());
  } catch (error) {
    if (error instanceof ManualReviewError) {
      const status =
        error.code === "NOT_FOUND"
          ? 404
          : error.code === "OUTPUT_INVALID"
            ? 422
            : 409;
      return context.json(
        {
          error: error.code.toLowerCase(),
          detail: error.detail,
          requestId: context.get("requestId"),
        },
        status,
      );
    }
    if (error instanceof TypeError)
      return context.json(
        { error: "invalid_request", requestId: context.get("requestId") },
        400,
      );
    throw error;
  }
};
export const registerManualReviewRoutes = (
  app: Hono<HealthBindings>,
  service: ManualReviewService,
): void => {
  app.get("/v1/manual-review/inbox", (context) =>
    execute(
      context,
      () =>
        service.inbox(
          (context.req.query("state") ?? "unreviewed") as ManualInboxState,
          context.req.query("cursor") ?? null,
        ),
      ["state", "cursor"],
    ),
  );
  app.get("/v1/manual-review/comments/:id", (context) =>
    execute(context, () =>
      service.getComment(Number(identifier(context, true))),
    ),
  );
  app.post("/v1/manual-review/comments/:id/draft", (context) =>
    execute(context, async () => {
      const raw = await textBody(context);
      if (raw.trim() && raw.trim() !== "{}")
        throw new TypeError("Unexpected body");
      return { draft: await service.create(Number(identifier(context, true))) };
    }),
  );
  app.put("/v1/manual-review/drafts/:id", (context) =>
    execute(context, async () => ({
      draft: await service.save(
        identifier(context),
        await readBoundedJsonBody(context),
      ),
    })),
  );
  app.post("/v1/manual-review/drafts/:id/rebase", (context) =>
    execute(context, async () => {
      const request = await readBoundedJsonBody(context);
      return {
        draft: await service.rebase(
          identifier(context),
          parseManualRebase(request),
        ),
      };
    }),
  );
  for (const [action, outcome] of [
    ["approve", "APPROVED"],
    ["reject", "REJECTED"],
  ] as const) {
    app.post(`/v1/manual-review/drafts/:id/${action}`, (context) =>
      execute(context, async () =>
        service.finalize(
          identifier(context),
          outcome,
          await readBoundedJsonBody(context),
        ),
      ),
    );
  }
};
