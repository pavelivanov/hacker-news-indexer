import { fileURLToPath } from "node:url";

export const checkTarget = (connectionString, target) => {
  if (!connectionString)
    throw new Error("An explicit local database target is required");
  const url = new URL(connectionString);
  if (
    url.protocol !== "postgresql:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.pathname !== `/${target}` ||
    url.search ||
    url.hash
  ) {
    throw new Error("Refusing an unexpected manual-review database target");
  }
  return url;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  checkTarget(process.env.DATABASE_URL, "hn_manual_review_test");
  console.log("Disposable manual-review test target verified.");
}
