import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  FixtureHnItems,
  FixtureSelectionSource,
  type HnFixture,
} from "../packages/adapters/src/index.ts";
import {
  createIngestSelectionRange,
  createResolveSelectedComment,
  createStartIngestion,
  HnParentChainResolver,
} from "../packages/application/src/index.ts";
import {
  createDatabase,
  createHnResolutionRepository,
  createIngestionRunRepository,
  createJobQueue,
  createOccurrenceRepository,
} from "../packages/db/src/index.ts";
import {
  hnItemId,
  ingestionRunId,
  telegramMessageId,
} from "../packages/domain/src/index.ts";

interface TelegramFixtureFile {
  readonly sourceKey: string;
  readonly minId: number;
  readonly maxId: number;
  readonly messages: readonly {
    readonly id: number;
    readonly date: string;
    readonly editDate: string | null;
    readonly text: string;
    readonly entities: readonly {
      readonly kind: string;
      readonly offset: number;
      readonly length: number;
      readonly url?: string;
    }[];
  }[];
}

interface HnFixtureFile extends HnFixture {
  readonly resolutions: readonly {
    readonly selectedCommentId: number;
    readonly displayedStoryId: number | null;
    readonly resolvedRootId: number;
  }[];
}

interface SeedManifest {
  readonly telegramSha256: string;
  readonly hnSha256: string;
  readonly counts: Readonly<Record<string, number>>;
}

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

const telegramPath = path.resolve(
  argument("--fixture") ?? "tests/fixtures/seed/window-32847-32946.json",
);
const fixtureDirectory = path.dirname(telegramPath);
const hnPath = path.join(fixtureDirectory, "hn-items.json");
const manifestPath = path.join(fixtureDirectory, "manifest.json");
const [telegramJson, hnJson, manifestJson] = await Promise.all([
  readFile(telegramPath, "utf8"),
  readFile(hnPath, "utf8"),
  readFile(manifestPath, "utf8"),
]);
const telegram = JSON.parse(telegramJson) as TelegramFixtureFile;
const hn = JSON.parse(hnJson) as HnFixtureFile;
const manifest = JSON.parse(manifestJson) as SeedManifest;
const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
if (
  sha256(telegramJson) !== manifest.telegramSha256 ||
  sha256(hnJson) !== manifest.hnSha256
) {
  throw new Error("Seed fixture hash does not match its manifest");
}

const hasher = { sha256 };
const wait = async (milliseconds: number): Promise<void> =>
  new Promise((resolveWait) => {
    setTimeout(resolveWait, milliseconds);
  });
const selectionSource = new FixtureSelectionSource(
  {
    sourceKey: telegram.sourceKey,
    messages: telegram.messages.map((message) => ({
      ...message,
      date: new Date(message.date),
      editDate: message.editDate === null ? null : new Date(message.editDate),
    })),
  },
  hasher,
);
const hnItems = new FixtureHnItems(hn);
const database = createDatabase({
  connectionString:
    process.env["DATABASE_URL"] ??
    "postgresql://hn_knowledge:hn_knowledge@127.0.0.1:5432/hn_knowledge",
});

try {
  const runs = createIngestionRunRepository(database.client);
  const occurrences = createOccurrenceRepository(database.client);
  const resolutions = createHnResolutionRepository(database.client);
  const queue = createJobQueue(database.client);
  const start = createStartIngestion(runs, hasher);
  const started = await start({
    source: "FIXTURE",
    sourceKey: telegram.sourceKey,
    minId: telegramMessageId(telegram.minId),
    maxId: telegramMessageId(telegram.maxId),
  });
  const runId = ingestionRunId(started.run.id);
  const ingest = createIngestSelectionRange(
    selectionSource,
    runs,
    occurrences,
    queue,
  );
  const resolver = new HnParentChainResolver(hnItems);
  const resolve = createResolveSelectedComment(
    resolver,
    occurrences,
    resolutions,
    { now: () => new Date(hn.capturedAt) },
    hasher,
    queue,
  );

  let idleAttempts = 0;
  for (;;) {
    const job = await queue.claim({
      leaseOwner: "seed-replay",
      leaseDurationMs: 60_000,
      ingestionRunId: runId,
    });
    if (job === null) {
      const run = await runs.reconcile(runId);
      if (run.status !== "RUNNING") {
        break;
      }
      idleAttempts += 1;
      if (idleAttempts > 100) {
        throw new Error("Seed replay jobs remained unavailable");
      }
      await wait(10);
      continue;
    }
    idleAttempts = 0;
    if (job.type === "INGEST_SELECTION_RANGE") {
      await ingest({
        runId,
        range: {
          source: "FIXTURE",
          sourceKey: telegram.sourceKey,
          minId: telegramMessageId(telegram.minId),
          maxId: telegramMessageId(telegram.maxId),
        },
      });
    } else if (job.type === "RESOLVE_HN_COMMENT") {
      const selectedCommentId = job.payload["selectedCommentId"];
      if (typeof selectedCommentId !== "number") {
        throw new TypeError("Resolve job is missing selectedCommentId");
      }
      await resolve({ runId, selectedCommentId: hnItemId(selectedCommentId) });
    } else if (job.type !== "CLASSIFY_COMMENT") {
      throw new TypeError(`Unexpected seed replay job type: ${job.type}`);
    }
    await queue.complete(job.id, "seed-replay");
    await runs.reconcile(runId);
  }

  const selectedIds = [
    ...new Set(hn.resolutions.map((value) => value.selectedCommentId)),
  ];
  const selectedBigInts = selectedIds.map(BigInt);
  const occurrenceCount = await database.client.ingestionRunOccurrence.count({
    where: { ingestionRunId: runId },
  });
  const selectedComments = await database.client.selectedComment.findMany({
    where: { id: { in: selectedBigInts } },
    select: { id: true, rootId: true },
  });
  const displayedReferences = await database.client.hnReference.findMany({
    where: {
      role: "DISPLAYED_STORY_REFERENCE",
      occurrence: { runs: { some: { ingestionRunId: runId } } },
    },
    distinct: ["hnItemId"],
    select: { hnItemId: true },
  });
  const paths = await database.client.resolutionPath.findMany({
    where: { selectedCommentId: { in: selectedBigInts } },
  });
  const multipartGroups = await database.client.multipartGroup.findMany({
    where: { selectedCommentId: { in: selectedBigInts } },
    include: { _count: { select: { parts: true } } },
  });
  const uniqueHnItems = await database.client.hnItem.count({
    where: { id: { in: hn.items.map((item) => BigInt(item.id)) } },
  });
  const jobCount = await database.client.pipelineJob.count({
    where: { ingestionRunId: runId },
  });
  const retainedTelegramBodies = await database.client.telegramMessage.count({
    where: {
      bodySnapshot: { not: null },
      occurrence: { runs: { some: { ingestionRunId: runId } } },
    },
  });
  const finalRun = await runs.reconcile(runId);
  const actual = {
    telegramOccurrences: occurrenceCount,
    uniqueSelectedComments: selectedComments.length,
    currentRoots: new Set(selectedComments.map((value) => String(value.rootId)))
      .size,
    displayedStoryReferences: displayedReferences.length,
    displayedRootMismatches: paths.filter(
      (value) =>
        value.displayedStoryId !== null &&
        value.displayedStoryId !== value.resolvedRootId,
    ).length,
    multipartGroups: multipartGroups.length,
    multipartParts: multipartGroups.reduce(
      (total, group) => total + group._count.parts,
      0,
    ),
    uniqueHnItems,
    siblingRequests: hn.items.some((item) => "kids" in item) ? 1 : 0,
  };
  for (const [key, expected] of Object.entries(manifest.counts)) {
    if (actual[key as keyof typeof actual] !== expected) {
      throw new Error(
        `Seed replay count ${key} was ${actual[key as keyof typeof actual]}, expected ${expected}`,
      );
    }
  }
  if (
    multipartGroups.some((group) => group.state !== "COMPLETE_MATCH") ||
    jobCount !== 197 ||
    retainedTelegramBodies !== 0 ||
    finalRun.status !== "COMPLETED"
  ) {
    throw new Error(
      "Seed replay did not reach its deterministic terminal state",
    );
  }
  const uniqueRequests = new Set(hnItems.requestedIds);
  if (uniqueRequests.size > 0 && uniqueRequests.size !== hn.items.length) {
    throw new Error(
      "Seed replay HN request set differs from the captured parent set",
    );
  }

  console.log(
    JSON.stringify(
      {
        runId,
        status: finalRun.status,
        created: started.created,
        ...actual,
        jobs: jobCount,
        retainedTelegramBodies,
        hnFetchesThisReplay: uniqueRequests.size,
      },
      null,
      2,
    ),
  );
} finally {
  await database.close();
}
