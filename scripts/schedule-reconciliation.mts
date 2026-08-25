import { createScheduleHnReconciliation } from "@hn-knowledge/application";
import {
  createDatabase,
  createHnReconciliationRepository,
} from "@hn-knowledge/db";
import { getConfig } from "@hn-knowledge/config";

const valueAfter = (name: string): string | null => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : (process.argv[index + 1] ?? null);
};

const now = new Date();
const scheduleKey = valueAfter("--key") ?? now.toISOString().slice(0, 10);
const rawLimit = valueAfter("--limit");
const limit = rawLimit === null ? 10_000 : Number(rawLimit);
const rawAvailableAt = valueAfter("--available-at");
const availableAt = rawAvailableAt === null ? now : new Date(rawAvailableAt);

if (
  !/^[A-Za-z0-9._:-]{1,128}$/u.test(scheduleKey) ||
  !Number.isSafeInteger(limit) ||
  limit <= 0 ||
  limit > 10_000 ||
  Number.isNaN(availableAt.getTime())
) {
  throw new TypeError("Invalid reconciliation schedule arguments");
}

const database = createDatabase({ connectionString: getConfig().DATABASE_URL });
try {
  const schedule = createScheduleHnReconciliation(
    createHnReconciliationRepository(database.client),
  );
  const result = await schedule(scheduleKey, availableAt, limit);
  process.stdout.write(
    `${JSON.stringify({
      scheduleKey,
      availableAt: availableAt.toISOString(),
      limit,
      ...result,
    })}\n`,
  );
} finally {
  await database.close();
}
