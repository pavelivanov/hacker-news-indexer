import { createHash } from "node:crypto";
import {
  createClassifyComment,
  captureClassifierResult,
  loadClassifierInput,
  normalizeHnCommentHtml,
} from "@hn-knowledge/application";
import {
  createClassificationRepository,
  createClassifierResultsRepository,
  type Database,
} from "@hn-knowledge/db";
import { hnItemId } from "@hn-knowledge/domain";
import type { ClassifierPort } from "@hn-knowledge/ports";
import { manualOutput } from "./output.js";

export const resultHasher = {
  sha256: (value: string) => createHash("sha256").update(value).digest("hex"),
};
export const seedClassifierResult = async (
  client: Database["client"],
  id = 900001,
  kind: "DISCOVERY" | "EXPERT_NOTE" | "REJECTED" = "EXPERT_NOTE",
) => {
  const databaseUrl = process.env["DATABASE_URL"];
  if (
    !databaseUrl ||
    new URL(databaseUrl).pathname !== "/hn_manual_review_test" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(new URL(databaseUrl).hostname)
  )
    throw new Error(
      "Synthetic classifier fixtures require the isolated test database",
    );
  const now = new Date("2026-09-05T00:00:00Z");
  const html = "<p>WidgetDB batches writes to reduce disk synchronization.</p>";
  const text = normalizeHnCommentHtml(html, `hn:item:${id}`, resultHasher);
  await client.hnItem.upsert({
    where: { id: 900000n },
    update: {},
    create: {
      id: 900000n,
      type: "story",
      title: "WidgetDB internals",
      textHtml: "<p>WidgetDB storage implementation.</p>",
      url: "https://widgetdb.example/",
      availability: "AVAILABLE",
      fetchedAt: now,
      responseHash: "fixture",
    },
  });
  await client.hnItem.upsert({
    where: { id: BigInt(id) },
    update: {},
    create: {
      id: BigInt(id),
      type: "comment",
      parentId: 900000n,
      textHtml: html,
      textPlain: text.canonicalText,
      availability: "AVAILABLE",
      fetchedAt: now,
      responseHash: "fixture",
    },
  });
  await client.selectedComment.upsert({
    where: { id: BigInt(id) },
    update: {},
    create: {
      id: BigInt(id),
      rootId: 900000n,
      canonicalHtml: text.canonicalHtml,
      canonicalText: text.canonicalText,
      contentHash: text.contentHash,
      availability: "AVAILABLE",
      firstSeenAt: now,
      lastSeenAt: now,
    },
  });
  const classifications = createClassificationRepository(client);
  const source = await loadClassifierInput(
    hnItemId(id),
    classifications,
    resultHasher,
  );
  const output = manualOutput(source, kind);
  let calls = 0;
  const classifier: ClassifierPort = {
    provider: "fixture",
    modelId: "synthetic-classifier",
    modelConfigId: "synthetic-classifier:results-v1",
    classify: async () => {
      calls += 1;
      return {
        rawOutput: JSON.stringify(output),
        provider: "fixture",
        modelId: "synthetic-classifier",
        modelConfigId: "synthetic-classifier:results-v1",
        latencyMs: 1,
        inputTokens: 10,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 10,
      };
    },
  };
  const classified = await createClassifyComment(
    classifier,
    classifications,
    resultHasher,
    null,
  )({ commentId: hnItemId(id), boundedInput: source });
  await captureClassifierResult(
    createClassifierResultsRepository(client),
    classifications,
    classified.run.id,
    source,
    resultHasher,
  );
  return { id: classified.run.id, source, output, calls };
};
