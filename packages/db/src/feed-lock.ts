import { Client } from "pg";

// Shared with classifier-results:generate. Never hold a Prisma transaction
// across network I/O. Loss of this session must stop the local worker.
export const acquireFeedLock = async (
  connectionString: string,
  onLost: () => void,
) => {
  const connection = new Client({
    connectionString,
    connectionTimeoutMillis: 5000,
  });
  let closing = false;
  connection.on("error", () => {
    if (!closing) onLost();
  });
  await connection.connect();
  const result = await connection.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_lock(140014) AS acquired",
  );
  if (!result.rows[0]?.acquired) {
    closing = true;
    await connection.end();
    throw new Error("FEED_WORKER_ALREADY_RUNNING");
  }
  return {
    close: async () => {
      closing = true;
      await connection.end();
    },
  };
};
