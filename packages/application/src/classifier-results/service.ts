import { createHmac, timingSafeEqual } from "node:crypto";
import {
  parseClassifierFeedbackV1,
  parseResultBookmarkV1,
  validateClassificationV1,
} from "@hn-knowledge/contracts";
import { ClassifierResultsError } from "@hn-knowledge/domain";
import type {
  BoundedClassifierInput,
  ClassificationRepository,
  ClassifierResultRecord,
  ClassifierResultsRepository,
  Hasher,
  ResultsFilter,
} from "@hn-knowledge/ports";
import { validateClassifierOutput } from "../classification/validate-output.js";

export const resultPresentation = (output: unknown, commentId: number) => {
  const parsed = validateClassificationV1(output);
  if (!parsed.ok)
    return {
      category: "FAILED" as const,
      title: `Comment #${commentId}`,
      summary: "The classifier could not produce a usable result.",
    };
  const value = parsed.value;
  return {
    category: value.primary_decision,
    title:
      value.primary_decision === "DISCOVERY"
        ? value.discoveries
            .map((item) => item.name)
            .join(" · ")
            .slice(0, 240)
        : (value.expert_note?.title ?? `Comment #${commentId}`),
    summary:
      value.primary_decision === "DISCOVERY"
        ? value.discoveries.map((item) => item.description_claim).join("\n\n")
        : (value.expert_note?.summary ?? value.comment_relevance.reason),
  };
};
export const captureClassifierResult = async (
  results: ClassifierResultsRepository,
  classifications: ClassificationRepository,
  runId: Parameters<ClassificationRepository["getRun"]>[0],
  source: BoundedClassifierInput,
  hasher: Hasher,
): Promise<void> => {
  const run = await classifications.getRun(runId);
  if (!run || run.inputHash !== hasher.sha256(JSON.stringify(source)))
    throw new TypeError("Run does not match source snapshot");
  const validation =
    run.errorCode === null
      ? validateClassifierOutput(
          JSON.stringify(run.providerOutput),
          source,
          hasher,
        )
      : null;
  const output = validation?.ok ? validation.output : null;
  await results.capture({
    runId,
    source,
    output,
    ...resultPresentation(output, source.selectedCommentId),
    errorCode:
      run.errorCode ?? (validation && !validation.ok ? validation.code : null),
  });
};

const summary = (row: ClassifierResultRecord) => ({
  id: row.id,
  comment_id: row.commentId,
  created_at: row.createdAt.toISOString(),
  category: row.category,
  title: row.title,
  summary: row.summary,
  feedback_version: row.feedbackVersion,
  bookmarked: row.bookmarked,
  bookmark_version: row.bookmarkVersion,
  available: row.available,
  model: row.modelId,
  prompt_version: row.promptVersion,
});
export const createClassifierResultsService = (
  repository: ClassifierResultsRepository,
  hasher: Hasher,
  options: { actorId: string; cursorSecret: string },
) => {
  const sign = (value: string) =>
    createHmac("sha256", options.cursorSecret)
      .update(value)
      .digest("base64url");
  const filters: ResultsFilter[] = [
    "all",
    "discovery",
    "expert_note",
    "skipped",
    "uncertain",
    "corrected",
    "saved",
  ];
  return {
    async list(
      filter: ResultsFilter = "all",
      cursor: string | null = null,
      search = "",
    ) {
      if (!filters.includes(filter))
        throw new TypeError("Invalid result filter");
      if (typeof search !== "string" || search.length > 200)
        throw new TypeError("Invalid result search");
      const query = search.trim().toLowerCase();
      let after: { createdAt: Date; id: string } | null = null;
      if (cursor) {
        if (cursor.length > 2000) throw new TypeError("Invalid cursor");
        const [body, signature, extra] = cursor.split(".");
        if (
          !body ||
          !signature ||
          extra ||
          signature.length !== sign(body).length ||
          !timingSafeEqual(Buffer.from(signature), Buffer.from(sign(body)))
        )
          throw new TypeError("Invalid cursor");
        const value = JSON.parse(
          Buffer.from(body, "base64url").toString("utf8"),
        ) as Record<string, unknown>;
        if (
          value["filter"] !== filter ||
          (value["query"] ?? "") !== query ||
          typeof value["date"] !== "string" ||
          typeof value["id"] !== "string" ||
          !/^[a-f0-9-]{36}$/i.test(value["id"])
        )
          throw new TypeError("Invalid cursor");
        const createdAt = new Date(value["date"]);
        if (!Number.isFinite(createdAt.getTime()))
          throw new TypeError("Invalid cursor");
        after = { createdAt, id: value["id"] };
      }
      const rows = await repository.list(filter, after, query);
      const page = rows.slice(0, 20);
      const last = page.at(-1);
      const next =
        rows.length > 20 && last
          ? Buffer.from(
              JSON.stringify({
                filter,
                query,
                date: last.createdAt.toISOString(),
                id: last.id,
              }),
            ).toString("base64url")
          : null;
      return {
        items: page.map(summary),
        next_cursor: next ? `${next}.${sign(next)}` : null,
      };
    },
    async get(id: string) {
      const row = await repository.get(id);
      if (!row) throw new ClassifierResultsError("NOT_FOUND");
      const parsed = validateClassificationV1(row.output);
      return {
        ...summary(row),
        source: row.input,
        original: parsed.ok ? parsed.value : null,
        error_code: row.errorCode,
        input_hash: row.inputHash,
        provider: row.provider,
        model_config: row.modelConfigId,
        prompt_hash: row.promptHash,
        feedback: row.feedback.map((item) => ({
          id: item.id,
          version: item.version,
          ...item.values,
          actor: item.actorId,
          created_at: item.createdAt.toISOString(),
        })),
      };
    },
    async correct(id: string, body: unknown) {
      const request = parseClassifierFeedbackV1(body);
      const { expected_version, command_key } = request;
      const values = {
        category: request.category,
        title: request.title,
        summary: request.summary,
        issue: request.issue,
        explanation: request.explanation,
      };
      const result = await repository.correct({
        id,
        expectedVersion: expected_version,
        commandKey: command_key,
        values,
        actorId: options.actorId,
        requestHash: hasher.sha256(
          JSON.stringify({
            id,
            expected_version,
            values,
            actor: options.actorId,
          }),
        ),
      });
      return { version: result.feedback.version, replayed: result.replayed };
    },
    async bookmark(id: string, body: unknown) {
      const request = parseResultBookmarkV1(body);
      return repository.bookmark({
        id,
        bookmarked: request.bookmarked,
        expectedVersion: request.expected_version,
        commandKey: request.command_key,
        requestHash: hasher.sha256(
          JSON.stringify({
            id,
            bookmarked: request.bookmarked,
            version: request.expected_version,
            actor: options.actorId,
          }),
        ),
      });
    },
  };
};
export type ClassifierResultsService = ReturnType<
  typeof createClassifierResultsService
>;
