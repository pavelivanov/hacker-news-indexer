import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { chromium } from "@playwright/test";
import { checkTarget } from "./manual-review/target.mjs";

const env = parseEnv(await readFile(".env.manual-review.local", "utf8"));
checkTarget(env.DATABASE_URL, "hn_manual_review");
if (
  !env.APP_API_TOKEN ||
  env.HOST !== "127.0.0.1" ||
  env.CLASSIFIER_ENABLED !== "false" ||
  env.TELEGRAM_ENABLED !== "false"
)
  throw new Error("Invalid local configuration");
const origin = "http://127.0.0.1:5173";
const headers = { Authorization: `Bearer ${env.APP_API_TOKEN}` };
const items = [];
let cursor = null;
do {
  const query = new globalThis.URLSearchParams({ filter: "all" });
  if (cursor) query.set("cursor", cursor);
  const response = await fetch(`${origin}/v1/classifier-results?${query}`, {
    headers,
    signal: globalThis.AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  const page = await response.json();
  items.push(...page.items);
  cursor = page.next_cursor;
  if (items.length > 1000)
    throw new Error("Local smoke exceeded its read bound");
} while (cursor);
assert.ok(items.length > 0, "Generate classifier results before this smoke");
assert.equal(new Set(items.map((item) => item.id)).size, items.length);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  await page.route("**/*", async (route) => {
    if (
      new URL(route.request().url()).origin !== origin ||
      route.request().method() !== "GET"
    )
      throw new Error("Results smoke permits only read-only local requests");
    await route.continue();
  });
  await page.goto(`${origin}/?view=results`);
  await page.getByLabel("Local API token").fill(env.APP_API_TOKEN);
  await page.getByRole("button", { name: "Unlock workspace" }).click();
  await page.locator(".classifier-result-list a").first().waitFor();
  await mkdir("output/playwright", { recursive: true });
  await page.screenshot({
    path: "output/playwright/local-classifier-results.png",
    fullPage: true,
  });
  const processing = page.getByRole("region", { name: "Feed processing" });
  await processing.locator("summary").click();
  await page.screenshot({
    path: "output/playwright/local-processing-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: "output/playwright/local-processing-mobile.png",
    fullPage: false,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const categories = [
    "EXPERT_NOTE",
    "DISCOVERY",
    "REJECTED",
    "REVIEW",
    "FAILED",
  ];
  let opened = 0;
  for (const category of categories) {
    const item = items.find((entry) => entry.category === category);
    if (!item) continue;
    await page.goto(`${origin}/?view=results&result=${item.id}`);
    await page.getByLabel("Local API token").fill(env.APP_API_TOKEN);
    await page.getByRole("button", { name: "Unlock workspace" }).click();
    await page
      .getByRole("region", { name: "Original source snapshot" })
      .waitFor();
    await page
      .getByText("Original prediction & model details", { exact: true })
      .click();
    await page
      .getByRole("button", { name: "Correct result", exact: true })
      .click();
    await page.getByRole("dialog", { name: "Correct this result" }).waitFor();
    await page
      .getByRole("button", { name: "Close", exact: true })
      .first()
      .click();
    if (opened === 0) {
      await page.screenshot({
        path: "output/playwright/local-classifier-detail.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth <=
            globalThis.innerWidth,
        ),
        true,
      );
      await page.screenshot({
        path: "output/playwright/local-classifier-mobile.png",
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "Correct result", exact: true })
        .click();
      await page.screenshot({
        path: "output/playwright/local-classifier-correction.png",
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "Close", exact: true })
        .first()
        .click();
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    opened += 1;
  }
  assert.equal(
    await page.evaluate(
      () => globalThis.localStorage.length + globalThis.sessionStorage.length,
    ),
    0,
  );
  await page.getByRole("button", { name: "Lock", exact: true }).click();
  assert.equal(await page.getByLabel("Local API token").inputValue(), "");
  const counts = Object.fromEntries(
    categories.map((category) => [
      category,
      items.filter((item) => item.category === category).length,
    ]),
  );
  console.log(
    JSON.stringify({
      results: items.length,
      categories: counts,
      correctedResults: items.filter((item) => item.feedback_version > 0)
        .length,
      resultScreensOpened: opened,
      mutations: 0,
      persistentBrowserEntries: 0,
      lockClearsToken: true,
    }),
  );
} finally {
  await browser.close();
}
