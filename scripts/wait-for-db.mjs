import pg from "pg";

const { Pool } = pg;
const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://hn_knowledge:hn_knowledge@127.0.0.1:5432/hn_knowledge";
const pool = new Pool({
  connectionString,
  connectionTimeoutMillis: 1_000,
  max: 1,
});
const maximumAttempts = 30;

try {
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      console.log(`PostgreSQL is ready after ${attempt} attempt(s).`);
      process.exitCode = 0;
      break;
    } catch {
      if (attempt === maximumAttempts) {
        throw new Error("PostgreSQL did not become ready within 30 seconds");
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
} finally {
  await pool.end();
}
