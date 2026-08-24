import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import { PrismaClient } from "./generated/prisma/client.js";

const DEFAULT_CONNECTION_TIMEOUT_MS = 2_000;

export interface Database {
  readonly client: PrismaClient;
  check(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  readonly connectionString: string;
  readonly connectionTimeoutMs?: number;
}

const withTimeout = async <T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> => {
  let timeout: NodeJS.Timeout | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error("Database readiness check timed out")),
      timeoutMs,
    );
    timeout.unref();
  });

  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
};

export const createDatabase = (options: DatabaseOptions): Database => {
  const connectionTimeoutMs =
    options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
  const pool = new Pool({
    connectionString: options.connectionString,
    connectionTimeoutMillis: connectionTimeoutMs,
    max: 5,
  });
  const adapter = new PrismaPg(pool);
  const client = new PrismaClient({ adapter });
  let closed = false;

  return {
    client,
    async check(timeoutMs = connectionTimeoutMs): Promise<void> {
      await withTimeout(client.$queryRawUnsafe("SELECT 1"), timeoutMs);
    },
    async close(): Promise<void> {
      if (closed) {
        return;
      }

      closed = true;
      await client.$disconnect();
      await pool.end();
    },
  };
};

let sharedDatabase: Database | undefined;

export const getDatabase = (
  connectionString = process.env["DATABASE_URL"] ??
    "postgresql://hn_knowledge:hn_knowledge@127.0.0.1:5432/hn_knowledge",
): Database => {
  sharedDatabase ??= createDatabase({ connectionString });
  return sharedDatabase;
};

export const checkDatabaseReadiness = async (
  timeoutMs: number,
): Promise<void> => getDatabase().check(timeoutMs);

export const disconnectDatabase = async (): Promise<void> => {
  const database = sharedDatabase;
  sharedDatabase = undefined;
  await database?.close();
};
