import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  loadClassifierInput,
  validateClassifierOutput,
} from "@hn-knowledge/application";
import { getConfig } from "@hn-knowledge/config";
import {
  createClassificationRepository,
  createDatabase,
} from "@hn-knowledge/db";
import { contentDecisionId, hnItemId } from "@hn-knowledge/domain";

const valueAfter = (name: string): string | null => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : (process.argv[index + 1] ?? null);
};

const fixture = valueAfter("--fixture") ?? "seed-v1";
if (!/^[A-Za-z0-9._-]{1,128}$/u.test(fixture)) {
  throw new TypeError("Invalid fixture name");
}

const percentile = (values: readonly number[], fraction: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(fraction * sorted.length) - 1] ?? 0;
};

const hasher = {
  sha256: (value: string): string =>
    createHash("sha256").update(value).digest("hex"),
};
const database = createDatabase({ connectionString: getConfig().DATABASE_URL });
try {
  const repository = createClassificationRepository(database.client);
  const rows = await database.client.selectedComment.findMany({
    where: { availability: "AVAILABLE" },
    select: {
      id: true,
      contentDecisions: {
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: 1,
        select: { id: true, validatedOutput: true },
      },
    },
    orderBy: { id: "asc" },
  });
  const latenciesMs: number[] = [];
  const deferred: { readonly commentId: number; readonly code: string }[] = [];
  let validationFailures = 0;
  const startedAt = performance.now();
  for (const row of rows) {
    const decision = row.contentDecisions[0];
    if (decision === undefined) {
      deferred.push({ commentId: Number(row.id), code: "DECISION_MISSING" });
      continue;
    }
    const caseStartedAt = performance.now();
    try {
      const input = await loadClassifierInput(
        hnItemId(Number(row.id)),
        repository,
        hasher,
      );
      const result = validateClassifierOutput(
        JSON.stringify(decision.validatedOutput),
        input,
        hasher,
      );
      if (!result.ok) {
        validationFailures += 1;
        deferred.push({
          commentId: Number(row.id),
          code: `VALIDATION_${result.code}`,
        });
      } else {
        contentDecisionId(decision.id);
        latenciesMs.push(performance.now() - caseStartedAt);
      }
    } catch (error) {
      deferred.push({
        commentId: Number(row.id),
        code: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
  const p95Ms = percentile(latenciesMs, 0.95);
  const report = {
    reportVersion: 1,
    fixture,
    comments: rows.length,
    completed: latenciesMs.length,
    deferred: deferred.length,
    validationFailures,
    latencyMs: {
      p50: percentile(latenciesMs, 0.5),
      p95: p95Ms,
      max: Math.max(0, ...latenciesMs),
      total: performance.now() - startedAt,
    },
    thresholdMs: 60_000,
    passed:
      latenciesMs.length > 0 && validationFailures === 0 && p95Ms < 60_000,
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.passed) {
    process.exitCode = 1;
  }
} finally {
  await database.close();
}
