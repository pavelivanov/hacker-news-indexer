import {
  KnowledgeReaderError,
  type KnowledgeReader,
} from "@hn-knowledge/application";
import type { Context, Hono } from "hono";

import type { HealthBindings } from "./health.js";

export interface RegisterReaderRoutesOptions {
  readonly reader: KnowledgeReader;
}

const POSITIVE_HN_ID = /^[1-9][0-9]{0,15}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const parseHnId = (value: string): number => {
  if (!POSITIVE_HN_ID.test(value)) {
    throw new TypeError("Invalid HN item ID");
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new TypeError("Invalid HN item ID");
  }
  return id;
};

const exactQuery = (
  context: Context<HealthBindings>,
  allowed: ReadonlySet<string>,
): URLSearchParams => {
  const params = new URL(context.req.url).searchParams;
  if ([...params.keys()].some((key) => !allowed.has(key))) {
    throw new TypeError("Unexpected query parameter");
  }
  for (const key of allowed) {
    if (params.getAll(key).length > 1) {
      throw new TypeError("Duplicate query parameter");
    }
  }
  return params;
};

const readerError = (
  context: Context<HealthBindings>,
  error: unknown,
): Response | null => {
  const requestId = context.get("requestId");
  if (error instanceof TypeError) {
    return context.json({ error: "invalid_request" as const, requestId }, 400);
  }
  if (!(error instanceof KnowledgeReaderError)) {
    return null;
  }
  if (error.code === "NOT_FOUND") {
    return context.json({ error: "not_found" as const, requestId }, 404);
  }
  if (error.code === "RESULT_WINDOW_EXCEEDED") {
    return context.json(
      { error: "result_window_exceeded" as const, requestId },
      503,
    );
  }
  return context.json({ error: "invalid_request" as const, requestId }, 400);
};

const execute = async (
  context: Context<HealthBindings>,
  action: () => Promise<unknown>,
): Promise<Response> => {
  try {
    return context.json(await action());
  } catch (error) {
    const response = readerError(context, error);
    if (response !== null) {
      return response;
    }
    throw error;
  }
};

export const registerReaderRoutes = (
  app: Hono<HealthBindings>,
  options: RegisterReaderRoutesOptions,
): void => {
  app.get("/v1/feed", (context) =>
    execute(context, async () => {
      const params = exactQuery(context, new Set(["kind", "cursor"]));
      const kind = params.get("kind");
      if (kind !== "discovery" && kind !== "expert_note") {
        throw new TypeError("Feed kind is required");
      }
      return options.reader.getFeed({ kind, cursor: params.get("cursor") });
    }),
  );

  app.get("/v1/comments/:id", (context) =>
    execute(context, async () => {
      exactQuery(context, new Set());
      return options.reader.getComment(parseHnId(context.req.param("id")));
    }),
  );

  app.get("/v1/stories/:id", (context) =>
    execute(context, async () => {
      exactQuery(context, new Set());
      return options.reader.getStory(parseHnId(context.req.param("id")));
    }),
  );

  app.get("/v1/subjects/:id", (context) =>
    execute(context, async () => {
      exactQuery(context, new Set());
      const id = context.req.param("id");
      if (!UUID.test(id)) {
        throw new TypeError("Invalid subject ID");
      }
      return options.reader.getSubject(id);
    }),
  );

  app.get("/v1/subjects/:id/notes", (context) =>
    execute(context, async () => {
      const params = exactQuery(context, new Set(["cursor"]));
      const id = context.req.param("id");
      if (!UUID.test(id)) {
        throw new TypeError("Invalid subject ID");
      }
      return options.reader.getSubjectNotes({
        subjectId: id,
        cursor: params.get("cursor"),
      });
    }),
  );
};
