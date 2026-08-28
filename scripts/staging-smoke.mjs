import { TextDecoder } from "node:util";

const MAX_RESPONSE_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const EXPECTED_METRIC_NAMES = new Set([
  "ingestion_messages_total",
  "ingestion_gap_total",
  "hn_resolution_depth",
  "hn_cache_hit_total",
  "displayed_root_mismatch_total",
  "multipart_incomplete_total",
  "classification_total",
  "classification_schema_error_total",
  "classification_latency_seconds",
  "url_candidate_rejected_total",
  "review_queue_depth",
  "review_queue_oldest_age_seconds",
  "feed_root_concentration",
  "export_total",
  "pipeline_failure_total",
]);

const fail = (message) => {
  throw new Error(message);
};

const parseBaseUrl = (value) => {
  if (value === undefined || value.trim().length === 0) {
    fail(
      "Pass the staging API URL as the first argument or set STAGING_API_URL",
    );
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    fail("The staging API URL is invalid");
  }

  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    fail("The staging API URL must be an origin without credentials or a path");
  }

  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    fail("The staging API URL must use HTTPS");
  }

  return url;
};

const readBoundedText = async (response, label) => {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    fail(`${label} response exceeds the safe size limit`);
  }
  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    bytes += result.value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      fail(`${label} response exceeds the safe size limit`);
    }
    text += decoder.decode(result.value, { stream: true });
  }
  return text + decoder.decode();
};

const request = async (baseUrl, path, label, authorization) => {
  const headers = { accept: "application/json" };
  if (authorization !== undefined) {
    headers.authorization = `Bearer ${authorization}`;
    headers.accept = "text/plain";
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(new URL(path, baseUrl), {
      cache: "no-store",
      headers,
      redirect: "error",
      signal: controller.signal,
    });
    return {
      response,
      text: await readBoundedText(response, label),
    };
  } finally {
    clearTimeout(timeout);
  }
};

const expectStatus = (label, result, expected) => {
  if (result.response.status !== expected) {
    fail(
      `${label} returned HTTP ${result.response.status}; expected ${expected}`,
    );
  }
};

const expectHealthyJson = (label, result) => {
  expectStatus(label, result, 200);
  let body;
  try {
    body = JSON.parse(result.text);
  } catch {
    fail(`${label} did not return JSON`);
  }
  if (body?.status !== "ok") {
    fail(`${label} did not return the expected status`);
  }
};

const assertSafeMetrics = (metrics, apiToken) => {
  const forbidden = [
    apiToken,
    "Bearer ",
    "APP_API_TOKEN",
    "DATABASE_URL",
    "TELEGRAM_SESSION",
    "postgresql://",
    "postgres://",
    "https://",
    "http://",
  ];
  if (forbidden.some((value) => metrics.includes(value))) {
    fail("Authenticated metrics response contains sensitive material");
  }

  for (const line of metrics.split("\n")) {
    if (line.length === 0) {
      continue;
    }

    const comment = /^# (?:HELP|TYPE) ([a-z_][a-z0-9_]*) /u.exec(line);
    if (comment !== null) {
      if (!EXPECTED_METRIC_NAMES.has(comment[1])) {
        fail("Authenticated metrics response contains an unexpected metric");
      }
      continue;
    }

    const sample =
      /^([a-z_][a-z0-9_]*?)(?:_(bucket|sum|count))?(?:\{([^}]*)\})? ([0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?)$/iu.exec(
        line,
      );
    if (sample === null || !EXPECTED_METRIC_NAMES.has(sample[1])) {
      fail("Authenticated metrics response contains an unexpected metric");
    }
    const [, , suffix, labels] = sample;
    if (
      labels !== undefined &&
      (suffix !== "bucket" ||
        !/^le="(?:\+Inf|[0-9]+(?:\.[0-9]+)?)"$/u.test(labels))
    ) {
      fail("Authenticated metrics response contains an unexpected label");
    }
  }

  for (const name of [
    "pipeline_failure_total",
    "review_queue_depth",
    "review_queue_oldest_age_seconds",
  ]) {
    if (!metrics.includes(name)) {
      fail("Authenticated metrics response is missing an expected metric");
    }
  }
};

const main = async () => {
  const baseUrl = parseBaseUrl(process.argv[2] ?? process.env.STAGING_API_URL);
  const apiToken = process.env.APP_API_TOKEN?.trim();
  if (apiToken === undefined || apiToken.length < 32 || /\s/u.test(apiToken)) {
    fail("APP_API_TOKEN must contain at least 32 non-whitespace characters");
  }

  expectHealthyJson(
    "GET /healthz",
    await request(baseUrl, "/healthz", "GET /healthz"),
  );
  expectHealthyJson(
    "GET /readyz",
    await request(baseUrl, "/readyz", "GET /readyz"),
  );

  expectStatus(
    "Unauthenticated GET /metrics",
    await request(baseUrl, "/metrics", "Unauthenticated GET /metrics"),
    401,
  );
  expectStatus(
    "Unauthenticated GET /v1/feed",
    await request(
      baseUrl,
      "/v1/feed?kind=discovery",
      "Unauthenticated GET /v1/feed",
    ),
    401,
  );

  const metricsResult = await request(
    baseUrl,
    "/metrics",
    "Authenticated GET /metrics",
    apiToken,
  );
  expectStatus("Authenticated GET /metrics", metricsResult, 200);
  if (
    !metricsResult.response.headers.get("content-type")?.includes("text/plain")
  ) {
    fail("Authenticated GET /metrics did not return text/plain");
  }
  assertSafeMetrics(metricsResult.text, apiToken);

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      origin: baseUrl.origin,
      checks: [
        "healthz",
        "readyz",
        "metrics_unauthorized",
        "v1_unauthorized",
        "metrics_authenticated_safe",
      ],
    })}\n`,
  );
};

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`Staging smoke failed: ${message}\n`);
  process.exitCode = 1;
}
