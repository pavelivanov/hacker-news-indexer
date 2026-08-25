import { createKnowledgeReader } from "@hn-knowledge/application";
import { getConfig } from "@hn-knowledge/config";
import {
  createDatabase,
  createKnowledgeReaderRepository,
} from "@hn-knowledge/db";
import type { FeedItemV1 } from "@hn-knowledge/contracts";

const valueAfter = (name: string): string | null => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : (process.argv[index + 1] ?? null);
};

const corpus = valueAfter("--corpus") ?? "seed-v1";
if (!/^[A-Za-z0-9._-]{1,128}$/u.test(corpus)) {
  throw new TypeError("Invalid corpus name");
}

const database = createDatabase({ connectionString: getConfig().DATABASE_URL });
try {
  const reader = createKnowledgeReader(
    createKnowledgeReaderRepository(database.client),
    { cursorSecret: getConfig().APP_API_TOKEN ?? "feed-audit-only" },
  );
  const primary: FeedItemV1[] = [];
  const clustered = new Map<string, FeedItemV1>();
  let clusterCount = 0;
  for (const kind of ["discovery", "expert_note"] as const) {
    let cursor: string | null = null;
    const cursors = new Set<string>();
    do {
      const page = await reader.getFeed({ kind, cursor });
      primary.push(...page.items);
      clusterCount += page.story_clusters.length;
      for (const cluster of page.story_clusters) {
        for (const item of cluster.items) {
          clustered.set(item.id, item);
        }
      }
      cursor = page.next_cursor;
      if (cursor !== null && cursors.has(cursor)) {
        throw new Error("Feed cursor loop detected");
      }
      if (cursor !== null) {
        cursors.add(cursor);
      }
    } while (cursor !== null);
  }
  const all = new Map(
    [...primary, ...clustered.values()].map((item) => [item.id, item] as const),
  );
  const rootCounts = new Map<number, number>();
  for (const item of all.values()) {
    rootCounts.set(
      item.resolved_root_id,
      (rootCounts.get(item.resolved_root_id) ?? 0) + 1,
    );
  }
  const firstTwentyRoots = new Map<number, number>();
  for (const item of primary.slice(0, 20)) {
    firstTwentyRoots.set(
      item.resolved_root_id,
      (firstTwentyRoots.get(item.resolved_root_id) ?? 0) + 1,
    );
  }
  const provenanceGaps = [...all.values()].filter(
    (item) =>
      item.source_occurrence_ids.length === 0 || item.evidence.length === 0,
  ).length;
  const servedCommentIds = [
    ...new Set(
      [...all.values()].map((item) => BigInt(item.selected_comment_id)),
    ),
  ];
  const [
    discoveryStatuses,
    noteStatuses,
    openReviews,
    activeDecisions,
    tombstones,
    servedUnavailable,
  ] = await Promise.all([
    database.client.discovery.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
    database.client.expertNote.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
    database.client.reviewTask.count({ where: { state: "OPEN" } }),
    database.client.selectedComment.count({
      where: { activeDecisionId: { not: null } },
    }),
    database.client.selectedComment.count({
      where: { availability: { not: "AVAILABLE" } },
    }),
    database.client.selectedComment.count({
      where: {
        id: { in: servedCommentIds },
        availability: { not: "AVAILABLE" },
      },
    }),
  ]);
  const statusCounts = {
    discovery: Object.fromEntries(
      discoveryStatuses.map((row) => [row.status, row._count._all]),
    ),
    expert_note: Object.fromEntries(
      noteStatuses.map((row) => [row.status, row._count._all]),
    ),
  };
  const materializedCount =
    discoveryStatuses.reduce((sum, row) => sum + row._count._all, 0) +
    noteStatuses.reduce((sum, row) => sum + row._count._all, 0);
  const maximumFirstTwentyRootCount = Math.max(0, ...firstTwentyRoots.values());
  const rootConcentration =
    all.size === 0 ? 0 : Math.max(0, ...rootCounts.values()) / all.size;
  const gates = {
    provenanceComplete: provenanceGaps === 0,
    firstTwentyRootCap: maximumFirstTwentyRootCount <= 2,
    approvedOnly: [...all.values()].every((item) => item.status === "APPROVED"),
    availableOnly: servedUnavailable === 0,
  };
  const report = {
    reportVersion: 1,
    corpus,
    generatedAt: new Date().toISOString(),
    materializedCount,
    statusCounts,
    served: {
      total: all.size,
      discovery: [...all.values()].filter((item) => item.kind === "discovery")
        .length,
      expertNote: [...all.values()].filter(
        (item) => item.kind === "expert_note",
      ).length,
      primaryCards: primary.length,
      storyClusters: clusterCount,
    },
    provenanceGaps,
    rootConcentration,
    maximumFirstTwentyRootCount,
    reviewExclusions: Math.max(0, materializedCount - all.size),
    openReviews,
    activeDecisions,
    tombstones,
    gates,
    passed: Object.values(gates).every(Boolean),
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.passed) {
    process.exitCode = 1;
  }
} finally {
  await database.close();
}
