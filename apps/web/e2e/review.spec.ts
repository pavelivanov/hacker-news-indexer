import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createDatabase } from "@hn-knowledge/db";
import { normalizeHnCommentHtml } from "@hn-knowledge/application";
import { browserSource } from "../../../tests/fixtures/manual-review/browser-source.js";
import { seedClassifierResult } from "../../../tests/fixtures/manual-review/classifier-result.js";
import { dailyFeedFixture } from "../../../tests/fixtures/manual-review/daily-feed.js";

const url = process.env["DATABASE_URL"];
const token = process.env["APP_API_TOKEN"];
if (
  !url ||
  new URL(url).pathname !== "/hn_manual_review_test" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname) ||
  !token ||
  process.env["MANUAL_REVIEW_TEST_RUN"] !== "1"
)
  throw new Error(
    "Use the guarded root browser-test alias with the isolated test database",
  );
const browserToken: string = token;
const database = createDatabase({ connectionString: url });
const client = database.client;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const id = browserSource.commentId;
const rootId = browserSource.rootId;
const rootTitle = browserSource.title;
const now = new Date("2026-09-05T00:00:00Z");

test.beforeEach(async ({ context }) => {
  await context.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.hostname !== "127.0.0.1")
      throw new Error("Unexpected external browser request");
    await route.continue();
  });
  await client.$executeRawUnsafe(
    'TRUNCATE TABLE "hn_items", "manual_review_drafts", "manual_review_receipts", "subjects", "classification_runs", "content_decisions", "review_tasks", "manual_override_events", "ingestion_runs", "selection_occurrences", "pipeline_jobs", "feed_processing_state", "feed_request_usage", "feed_command_receipts" CASCADE',
  );
  await client.hnItem.create({
    data: {
      id: BigInt(rootId),
      type: "story",
      title: rootTitle,
      textHtml: browserSource.rootHtml,
      textPlain: null,
      url: browserSource.url,
      availability: "AVAILABLE",
      fetchedAt: now,
      responseHash: hash(rootTitle),
    },
  });
  const html = browserSource.commentHtml;
  const normalized = normalizeHnCommentHtml(html, `hn:item:${id}`, {
    sha256: hash,
  });
  await client.hnItem.create({
    data: {
      id: BigInt(id),
      type: "comment",
      parentId: BigInt(rootId),
      textHtml: html,
      textPlain: normalized.canonicalText,
      fetchedAt: now,
      responseHash: hash(html),
      availability: "AVAILABLE",
    },
  });
  await client.selectedComment.create({
    data: {
      id: BigInt(id),
      rootId: BigInt(rootId),
      canonicalHtml: normalized.canonicalHtml,
      canonicalText: normalized.canonicalText,
      contentHash: normalized.contentHash,
      availability: "AVAILABLE",
      firstSeenAt: now,
      lastSeenAt: now,
      resolutionPath: {
        create: {
          ancestorIds: [BigInt(rootId)],
          displayedStoryId: BigInt(rootId),
          resolvedRootId: BigInt(rootId),
          resolverVersion: "browser-fixture.v1",
          resolvedAt: now,
        },
      },
    },
  });
});
test.afterAll(async () => database.close());

async function settings(page: Page) {
  await page.getByText("Processing details", { exact: true }).click();
  await page
    .getByRole("button", { name: "Feed settings", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Feed settings" }),
  ).toBeVisible();
}

test("browser settings persist across polling and reload without changing pause state or corrections", async ({
  page,
}) => {
  await dailyFeedFixture(database);
  await client.feedProcessingState.update({
    where: { id: "local" },
    data: { enabled: false },
  });
  await unlock(page, "/?view=results");
  await settings(page);
  await page.getByLabel("Check every (minutes)").fill("45");
  await page.getByLabel("Daily request limit").fill("75");
  // Wait for the next real status poll while the form contains unfinished edits.
  await page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/v1/processing",
  );
  await expect(page.getByLabel("Check every (minutes)")).toHaveValue("45");
  await expect(page.getByLabel("Daily request limit")).toHaveValue("75");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(page.getByText(/Settings saved\./)).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.reload();
  await page.getByLabel("Local API token").fill(browserToken);
  await page.getByRole("button", { name: "Unlock workspace" }).click();
  await settings(page);
  await expect(page.getByLabel("Check every (minutes)")).toHaveValue("45");
  await expect(page.getByLabel("Daily request limit")).toHaveValue("75");
  expect(
    await client.feedProcessingState.findUnique({ where: { id: "local" } }),
  ).toMatchObject({
    enabled: false,
    intervalSeconds: 2700,
    dailyRequestLimit: 75,
    settingsVersion: 1,
  });
  expect(await client.classifierFeedback.count()).toBe(0);
  expect(await client.manualOverrideEvent.count()).toBe(0);
});

test("settings validate ranges and Cancel discards changes without saving", async ({
  page,
}) => {
  await dailyFeedFixture(database);
  await unlock(page, "/?view=results");
  await settings(page);
  await page.getByLabel("Check every (minutes)").fill("0");
  await page.getByLabel("Daily request limit").fill("1001");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(page.getByLabel("Check every (minutes)")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(page.getByLabel("Daily request limit")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  expect(await client.feedCommandReceipt.count()).toBe(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Feed settings", exact: true })
    .click();
  await expect(page.getByLabel("Check every (minutes)")).toHaveValue("30");
  await expect(page.getByLabel("Daily request limit")).toHaveValue("100");
});

test("an interrupted settings save retries the same command without a second revision", async ({
  page,
}) => {
  await dailyFeedFixture(database);
  await unlock(page, "/?view=results");
  await settings(page);
  const commands: (string | null)[] = [];
  await page.route("**/v1/processing/settings", async (route) => {
    commands.push(route.request().postData());
    if (commands.length === 1) {
      expect((await route.fetch()).status()).toBe(200);
      await route.abort();
    } else await route.continue();
  });
  await page.getByLabel("Check every (minutes)").fill("60");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(page.getByLabel("Check every (minutes)")).toBeDisabled();
  await page.getByRole("button", { name: "Retry same settings" }).click();
  await expect(page.getByText(/Settings saved\./)).toBeVisible();
  expect(commands).toHaveLength(2);
  expect(commands[1]).toBe(commands[0]);
  expect(await client.feedCommandReceipt.count()).toBe(1);
  expect(
    (
      await client.feedProcessingState.findUniqueOrThrow({
        where: { id: "local" },
      })
    ).settingsVersion,
  ).toBe(1);
});

test("settings conflicts preserve the unfinished values until explicitly reloaded", async ({
  page,
  context,
}) => {
  await dailyFeedFixture(database);
  const second = await context.newPage();
  await unlock(page, "/?view=results");
  await unlock(second, "/?view=results");
  await settings(page);
  await settings(second);
  await page.getByLabel("Check every (minutes)").fill("45");
  await second.getByLabel("Check every (minutes)").fill("60");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(page.getByText(/Settings saved\./)).toBeVisible();
  await second
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    second.getByText(/Settings changed in another tab/),
  ).toBeVisible();
  await expect(second.getByLabel("Check every (minutes)")).toHaveValue("60");
  await second.getByRole("button", { name: "Reload current settings" }).click();
  await expect(second.getByLabel("Check every (minutes)")).toHaveValue("45");
  expect(await client.feedCommandReceipt.count()).toBe(1);
  await second.close();
});

test("@a11y feed settings and validation fit desktop and mobile with keyboard controls", async ({
  page,
}) => {
  await dailyFeedFixture(database);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await unlock(page, "/?view=results");
  await settings(page);
  await expect(page.getByLabel("Check every (minutes)")).toBeFocused();
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const audit = await new AxeBuilder({ page }).analyze();
    expect(
      audit.violations.filter(
        (item) => item.impact === "serious" || item.impact === "critical",
      ),
    ).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await screenshot(
      page,
      viewport.width === 390 ? "settings-mobile" : "settings-desktop",
    );
  }
  await page.getByLabel("Daily request limit").fill("0");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Daily request limit")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  const audit = await new AxeBuilder({ page }).analyze();
  expect(
    audit.violations.filter(
      (item) => item.impact === "serious" || item.impact === "critical",
    ),
  ).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Feed settings", exact: true }),
  ).toBeFocused();
});

test("search and bookmarks persist across list, detail, saved view, and reload", async ({
  page,
}) => {
  const fixture = await seedClassifierResult(client);
  await seedClassifierResult(client, 900002, "REJECTED");
  await unlock(page, "/?view=results");
  await page.getByLabel("Search titles and summaries").fill("BATCHING");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".classifier-result-list li")).toHaveCount(1);
  await page
    .getByRole("button", {
      name: "Save result: Batching storage writes",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Remove bookmark: Batching storage writes",
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Show results").selectOption("saved");
  await page.getByRole("link", { name: /Batching storage writes/ }).click();
  await expect(
    page
      .getByRole("region", { name: "Result details", exact: true })
      .getByRole("button", { name: /Remove bookmark:/ }),
  ).toHaveAttribute("aria-pressed", "true");
  const resultUrl = new URL(page.url());
  expect(resultUrl.searchParams.get("q")).toBe("BATCHING");
  expect(resultUrl.searchParams.get("filter")).toBe("saved");
  await page.reload();
  await page.getByLabel("Local API token").fill(browserToken);
  await page.getByRole("button", { name: "Unlock workspace" }).click();
  const detail = page.getByRole("region", {
    name: "Result details",
    exact: true,
  });
  await detail.getByRole("button", { name: /Remove bookmark:/ }).click();
  await expect(
    page.getByText("No matching results", { exact: true }),
  ).toBeVisible();
  await expect(
    detail.getByRole("button", { name: /Save result:/ }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(
    page.getByText("No saved results yet", { exact: true }),
  ).toBeVisible();
  expect(await client.classifierFeedback.count()).toBe(0);
  expect(await client.manualOverrideEvent.count()).toBe(0);
  expect(
    (
      await client.classifierResultSnapshot.findUniqueOrThrow({
        where: { runId: fixture.id },
      })
    ).originalOutput,
  ).toEqual(fixture.output);
});

test("a lost bookmark response retries the identical command exactly once", async ({
  page,
}) => {
  await seedClassifierResult(client);
  await unlock(page, "/?view=results");
  const commands: (string | null)[] = [];
  await page.route("**/v1/classifier-results/*/bookmark", async (route) => {
    commands.push(route.request().postData());
    if (commands.length === 1) {
      expect((await route.fetch()).status()).toBe(200);
      await route.abort();
    } else await route.continue();
  });
  await page.getByRole("button", { name: /Save result:/ }).click();
  await page.getByRole("button", { name: /Retry bookmark:/ }).click();
  await expect(
    page.getByRole("button", { name: /Remove bookmark:/ }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(commands).toHaveLength(2);
  expect(commands[1]).toBe(commands[0]);
  expect(await client.resultBookmarkReceipt.count()).toBe(1);
  expect(
    (await client.classifierResultSnapshot.findFirstOrThrow()).bookmarkVersion,
  ).toBe(1);
});

test("bookmark conflicts and search navigation preserve unsaved correction text", async ({
  page,
  context,
}) => {
  const fixture = await seedClassifierResult(client);
  const route = `/?view=results&result=${fixture.id}`;
  const second = await context.newPage();
  await unlock(page, route);
  await unlock(second, route);
  const details = second.getByRole("region", {
    name: "Result details",
    exact: true,
  });
  await second
    .getByRole("button", { name: "Correct result", exact: true })
    .click();
  await second.getByLabel(/^Title/).fill("Keep my unfinished correction");
  await second.keyboard.press("Escape");
  await page
    .getByRole("region", { name: "Result details", exact: true })
    .getByRole("button", { name: /Save result:/ })
    .click();
  await expect(
    page.getByRole("button", { name: /Remove bookmark:/ }),
  ).toHaveCount(2);
  await details.getByRole("button", { name: /Save result:/ }).click();
  await expect(
    details.getByText(/This bookmark changed in another tab/),
  ).toBeVisible();
  await second.getByLabel("Search titles and summaries").fill("another phrase");
  await second.getByRole("button", { name: "Search", exact: true }).click();
  await expect(second.getByRole("alertdialog")).toBeVisible();
  await second.getByRole("button", { name: "Keep editing" }).click();
  await second
    .getByRole("button", { name: "Continue correction", exact: true })
    .click();
  await expect(second.getByLabel(/^Title/)).toHaveValue(
    "Keep my unfinished correction",
  );
  expect(await client.classifierFeedback.count()).toBe(0);
  expect(await client.resultBookmarkReceipt.count()).toBe(1);
  await second.close();
});

test("late pagination cannot append results from the previous search", async ({
  page,
}) => {
  for (let n = 0; n < 22; n += 1)
    await seedClassifierResult(client, 900001 + n);
  await unlock(page, "/?view=results");
  let release!: () => void;
  let arrived!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  await page.route("**/v1/classifier-results?**", async (route) => {
    if (new URL(route.request().url()).searchParams.has("cursor")) {
      const response = await route.fetch();
      arrived();
      await held;
      await route.fulfill({ response });
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Load more results" }).click();
  await requested;
  await page
    .getByLabel("Search titles and summaries")
    .fill("nothing matches this");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByText("No matching results", { exact: true }),
  ).toBeVisible();
  const response = page.waitForResponse((item) =>
    new URL(item.url()).searchParams.has("cursor"),
  );
  release();
  await response;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(
    page.getByText("No matching results", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".classifier-result-list li")).toHaveCount(0);
});

test("@a11y search and saved controls work with keyboard on desktop and mobile", async ({
  page,
}) => {
  await seedClassifierResult(client);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await unlock(page, "/?view=results");
  await page.getByLabel("Search titles and summaries").focus();
  await page.keyboard.type("batching");
  await page.keyboard.press("Enter");
  const save = page.getByRole("button", { name: /Save result:/ });
  await save.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: /Remove bookmark:/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Show results").selectOption("saved");
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const report = await new AxeBuilder({ page }).analyze();
    expect(
      report.violations.filter(
        (item) => item.impact === "serious" || item.impact === "critical",
      ),
    ).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await screenshot(
      page,
      viewport.width === 390 ? "search-saved-mobile" : "search-saved-desktop",
    );
  }
});

async function unlock(page: Page, route = `/?view=inbox&comment=${id}`) {
  await page.goto(route);
  await page.getByLabel("Local API token").fill(browserToken);
  await page.getByRole("button", { name: "Unlock workspace" }).click();
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toBeVisible();
}
async function start(page: Page) {
  await unlock(page);
  await page.getByRole("button", { name: "Start draft" }).click();
  await expect(page.getByLabel("Note title")).toBeVisible();
}
async function judgment(page: Page) {
  await page
    .getByLabel("Relevance explanation")
    .fill("The comment explains the performance tradeoff of batched writes.");
  await page.getByLabel("Your confidence").fill("90");
  await page
    .getByRole("checkbox", {
      name: "The selected comment is materially technical",
    })
    .check();
}
async function note(page: Page) {
  await page.getByLabel("Note title").fill("Why WidgetDB batches writes");
  await page
    .getByLabel("Note summary")
    .fill(
      "Batching improves throughput by reducing synchronization, with a short persistence delay.",
    );
  await page.getByRole("button", { name: /Expert note evidence/ }).click();
  await page
    .getByRole("region", { name: "Source evidence" })
    .getByRole("checkbox")
    .first()
    .check();
}
async function save(page: Page) {
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    page.getByText("Draft saved. You can return to it later."),
  ).toBeVisible();
}
async function approve(page: Page) {
  await page
    .getByLabel("Approval or rejection reason")
    .fill("Checked the written claims against the selected source passages.");
  await page.getByRole("button", { name: "Approve saved draft" }).click();
}
async function screenshot(page: Page, name: string) {
  await mkdir("../../output/playwright", { recursive: true });
  await page.locator(".panel-scroll").evaluateAll((panes) => {
    for (const pane of panes) pane.scrollTop = 0;
  });
  await page.screenshot({
    path: `../../output/playwright/${name}.png`,
    fullPage: true,
  });
}

test("partial draft survives reload and approval reaches the real note feed", async ({
  page,
}) => {
  await start(page);
  await page.getByLabel("Note title").fill("Why WidgetDB batches writes");
  await save(page);
  expect(await client.contentDecision.count()).toBe(0);
  await page.reload();
  await expect(page.getByLabel("Local API token")).toHaveValue("");
  expect(
    await page.evaluate(() => localStorage.length + sessionStorage.length),
  ).toBe(0);
  await page.getByLabel("Local API token").fill(browserToken);
  await page.getByRole("button", { name: "Unlock workspace" }).click();
  await expect(page.getByLabel("Note title")).toHaveValue(
    "Why WidgetDB batches writes",
  );
  await note(page);
  await judgment(page);
  await save(page);
  await screenshot(page, "review-desktop");
  await approve(page);
  await expect(
    page
      .getByRole("article")
      .getByRole("heading", { name: "Why WidgetDB batches writes" }),
  ).toBeVisible();
  expect(
    await client.contentDecision.count({
      where: { source: "MANUAL", classificationRunId: null },
    }),
  ).toBe(1);
  expect(await client.classificationRun.count()).toBe(0);
  await screenshot(page, "feed-desktop");
  await page.getByRole("button", { name: "Lock", exact: true }).click();
  await expect(page.getByLabel("Local API token")).toHaveValue("");
});

for (const supportingNote of [false, true])
  test(`Discovery approval${supportingNote ? " with supporting note" : ""}`, async ({
    page,
  }) => {
    await start(page);
    await page.getByText("Discovery", { exact: true }).click();
    await page.getByLabel("Discovery name 1").fill("WidgetDB");
    await page
      .getByLabel("Discovery description 1")
      .fill("A database that batches writes to reduce disk synchronization.");
    await page
      .getByRole("region", { name: "Source evidence" })
      .getByRole("checkbox")
      .first()
      .check();
    await page
      .getByRole("checkbox", { name: "https://widgetdb.example/", exact: true })
      .check();
    if (supportingNote) {
      await page
        .getByRole("checkbox", { name: "Include a supporting Expert note" })
        .check();
      await note(page);
    }
    await judgment(page);
    await save(page);
    await approve(page);
    await expect(
      page
        .getByRole("article")
        .getByRole("heading", { name: "WidgetDB", exact: true }),
    ).toBeVisible();
    expect(await client.discovery.count()).toBe(1);
    expect(await client.expertNote.count()).toBe(supportingNote ? 1 : 0);
    expect(await client.classificationRun.count()).toBe(0);
  });

test("explicit rejection records a human judgment without feed items", async ({
  page,
}) => {
  await start(page);
  await page.getByText("Reject", { exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Generic opinion", exact: true })
    .check();
  await judgment(page);
  await save(page);
  await page
    .getByLabel("Approval or rejection reason")
    .fill("The comment is outside the useful collection for this review.");
  await page.getByRole("button", { name: "Confirm rejection" }).click();
  await expect(
    page.getByText("Comment rejected. Your reason has been recorded."),
  ).toBeVisible();
  expect(
    await client.contentDecision.count({
      where: { source: "MANUAL", primaryDecision: "REJECTED" },
    }),
  ).toBe(1);
  expect(
    (await client.discovery.count()) + (await client.expertNote.count()),
  ).toBe(0);
});

test("two-tab conflict preserves writing and requires explicit reconciliation", async ({
  page,
  context,
}) => {
  await start(page);
  await page.getByLabel("Note title").fill("Initial title");
  await save(page);
  const other = await context.newPage();
  await unlock(other);
  await other.getByLabel("Note title").fill("Saved in another tab");
  await save(other);
  await page.getByLabel("Note title").fill("My unsaved revision");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    page.getByText(/A newer draft was saved elsewhere/),
  ).toBeVisible();
  await expect(page.getByLabel("Note title")).toHaveValue(
    "My unsaved revision",
  );
  await page.getByRole("button", { name: "Compare saved version" }).click();
  await expect(
    page.getByRole("dialog").getByText("Saved in another tab"),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Keep my edits on latest version" })
    .click();
  await save(page);
  await other.close();
});

test("source changes require rebase while preserving unsaved text", async ({
  page,
}) => {
  await start(page);
  await note(page);
  await save(page);
  await client.hnItem.update({
    where: { id: BigInt(rootId) },
    data: {
      title: "Updated WidgetDB context",
      responseHash: hash("updated root"),
    },
  });
  await page.getByLabel("Note title").fill("Keep this unsaved writing");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText(/The source has changed/)).toBeVisible();
  await page.getByRole("button", { name: "Rebase evidence" }).click();
  await page
    .getByRole("button", { name: "Rebase and clear selections" })
    .click();
  await expect(
    page.getByText(/Source refreshed. Your writing is preserved/),
  ).toBeVisible();
  await expect(page.getByLabel("Note title")).toHaveValue(
    "Keep this unsaved writing",
  );
  await expect(
    page
      .getByRole("region", { name: "Source evidence" })
      .getByRole("checkbox")
      .first(),
  ).not.toBeChecked();
  await save(page);
});

test("lost approval response retries the same command with one decision", async ({
  page,
}) => {
  await start(page);
  await note(page);
  await judgment(page);
  await save(page);
  let dropped = false;
  await page.route("**/v1/manual-review/drafts/*/approve", async (route) => {
    if (!dropped) {
      dropped = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await approve(page);
  await expect(page.getByText("Approval response is uncertain")).toBeVisible();
  await page.getByRole("button", { name: "Retry saved approval" }).click();
  await expect(page.getByRole("article")).toHaveCount(1);
  expect(await client.contentDecision.count()).toBe(1);
  expect(await client.manualReviewReceipt.count()).toBe(1);
});

test("rapid duplicate approval submits one command", async ({ page }) => {
  await start(page);
  await note(page);
  await judgment(page);
  await save(page);
  await page
    .getByLabel("Approval or rejection reason")
    .fill("Checked the source before approving.");
  let requests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/approve")) requests += 1;
  });
  await page
    .getByRole("button", { name: "Approve saved draft" })
    .evaluate((element) => {
      (element as HTMLButtonElement).click();
      (element as HTMLButtonElement).click();
    });
  await expect(page.getByRole("article")).toHaveCount(1);
  expect(requests).toBe(1);
  expect(await client.contentDecision.count()).toBe(1);
});

test("navigation guards edits and a 401 clears the in-memory session", async ({
  page,
}) => {
  await start(page);
  await page.getByLabel("Note title").fill("Unsaved text");
  await page.getByRole("link", { name: "Discoveries", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Stay and review" }).click();
  await expect(page.getByLabel("Note title")).toHaveValue("Unsaved text");
  await page.route("**/v1/manual-review/inbox?**", async (route) => {
    const headers = {
      ...route.request().headers(),
      authorization: "Bearer expired",
    };
    await route.continue({ headers });
  });
  await page.getByRole("button", { name: "Refresh inbox" }).click();
  await expect(page.getByLabel("Local API token")).toHaveValue("");
  expect(
    await page.evaluate(() => localStorage.length + sessionStorage.length),
  ).toBe(0);
});

test("@a11y keyboard review and responsive screens have no serious accessibility violations", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?view=inbox");
  await screenshot(page, "unlock-desktop");
  const audit = async () => {
    const result = await new AxeBuilder({ page }).analyze();
    expect(
      result.violations.filter(
        (item) => item.impact === "serious" || item.impact === "critical",
      ),
    ).toEqual([]);
  };
  await audit();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Local API token")).toBeFocused();
  await page.keyboard.type(browserToken);
  await page.keyboard.press("Enter");
  await page.getByRole("link", { name: /HN #900001/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".evidence-label").first()).toHaveCSS(
    "opacity",
    "1",
  );
  await audit();
  await page.getByRole("button", { name: "Start draft" }).focus();
  await page.keyboard.press("Enter");
  await note(page);
  await judgment(page);
  const evidence = page
    .getByRole("region", { name: "Source evidence" })
    .getByRole("checkbox")
    .first();
  await evidence.focus();
  await page.keyboard.press("Space");
  await expect(evidence).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(evidence).toBeChecked();
  await page.getByRole("button", { name: "Save draft", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("Draft saved. You can return to it later."),
  ).toBeVisible();
  await audit();
  await screenshot(page, "editor-keyboard-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await audit();
  await screenshot(page, "review-mobile");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page
    .getByLabel("Approval or rejection reason")
    .fill("Reviewed using keyboard evidence selection.");
  await page.getByRole("button", { name: "Approve saved draft" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("article")).toHaveCount(1);
  await audit();
  await screenshot(page, "feed-mobile");
});
test("classifier results need no approval and corrections survive reload", async ({
  page,
}) => {
  const fixture = await seedClassifierResult(client);
  await unlock(page, "/");
  await page.getByRole("link", { name: /Batching storage writes/ }).click();
  await expect(
    page.getByRole("heading", { name: "Read the source" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Approve/ })).toHaveCount(0);
  await page
    .getByRole("button", { name: "Correct result", exact: true })
    .click();
  await page.getByLabel(/^Title/).fill("A corrected storage lesson");
  await page
    .getByLabel("Anything else?")
    .fill("The distinction matters in practice.");
  await page
    .getByRole("button", { name: "Save correction", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "A corrected storage lesson", level: 1 }),
  ).toBeVisible();
  await page.reload();
  await page.getByLabel("Local API token").fill(browserToken);
  await page.getByRole("button", { name: "Unlock workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "A corrected storage lesson", level: 1 }),
  ).toBeVisible();
  await page.getByText("Original prediction & model details").click();
  await expect(
    page.getByRole("heading", { name: "Batching storage writes" }),
  ).toBeVisible();
  const original = await client.classifierResultSnapshot.findUniqueOrThrow({
    where: { runId: fixture.id },
  });
  expect(original.originalOutput).toEqual(fixture.output);
  expect(await client.classifierFeedback.count()).toBe(1);
  expect(await client.reviewTask.count()).toBe(0);
  expect(await client.manualOverrideEvent.count()).toBe(0);
  expect(
    (
      await client.selectedComment.findUniqueOrThrow({
        where: { id: BigInt(id) },
      })
    ).activeDecisionId,
  ).toBeNull();
  await screenshot(page, "classifier-results-desktop");
});

test("classifier correction conflicts preserve text and reconcile explicitly", async ({
  page,
  context,
}) => {
  const fixture = await seedClassifierResult(client);
  const route = `/?view=results&result=${fixture.id}`;
  const second = await context.newPage();
  await unlock(page, route);
  await unlock(second, route);
  for (const tab of [page, second])
    await tab
      .getByRole("button", { name: "Correct result", exact: true })
      .click();
  await page.getByLabel(/^Title/).fill("First correction");
  await second.getByLabel(/^Title/).fill("My later correction");
  await page
    .getByRole("button", { name: "Save correction", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await second
    .getByRole("button", { name: "Save correction", exact: true })
    .click();
  await expect(second.getByText("A newer correction exists")).toBeVisible();
  await expect(second.getByLabel(/^Title/)).toHaveValue("My later correction");
  await second
    .getByRole("button", { name: "Use latest version, keep my text" })
    .click();
  await second
    .getByRole("button", { name: "Save correction", exact: true })
    .click();
  await expect(second.getByRole("dialog")).toHaveCount(0);
  expect(await client.classifierFeedback.count()).toBe(2);
  await second.close();
});

test("a lost correction response retries without duplicating feedback", async ({
  page,
}) => {
  const fixture = await seedClassifierResult(client);
  await unlock(page, `/?view=results&result=${fixture.id}`);
  await page
    .getByRole("button", { name: "Correct result", exact: true })
    .click();
  await page
    .getByLabel("Anything else?")
    .fill("Keep this context for improvement.");
  let dropped = false;
  await page.route("**/v1/classifier-results/*/corrections", async (route) => {
    if (!dropped) {
      dropped = true;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await page
    .getByRole("button", { name: "Save correction", exact: true })
    .click();
  await page.getByRole("button", { name: "Retry same correction" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await client.classifierFeedback.count()).toBe(1);
});

test("@a11y classifier results and correction form work on desktop and mobile", async ({
  page,
}) => {
  const fixture = await seedClassifierResult(client);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await unlock(page, `/?view=results&result=${fixture.id}`);
  await page
    .getByRole("button", { name: "Correct result", exact: true })
    .waitFor();
  const audit = async () => {
    const report = await new AxeBuilder({ page }).analyze();
    expect(
      report.violations.filter(
        (item) => item.impact === "serious" || item.impact === "critical",
      ),
    ).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  };
  await audit();
  await screenshot(page, "classifier-results-desktop");
  await page
    .getByRole("button", { name: "Correct result", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await audit();
  await screenshot(page, "classifier-correction-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await audit();
  await screenshot(page, "classifier-correction-mobile");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await audit();
  await screenshot(page, "classifier-results-mobile");
});

test("automatic feed controls bring fresh results into the browser without approval", async ({
  page,
}) => {
  const fixture = await dailyFeedFixture(database);
  await client.feedProcessingState.update({
    where: { id: "local" },
    data: { enabled: false },
  });
  await unlock(page, "/?view=results");
  await expect(
    page.getByText("Automatic updates paused", { exact: true }),
  ).toBeVisible();
  await page.getByText("Processing details", { exact: true }).click();
  await page.getByRole("button", { name: "Resume updates" }).click();
  await expect(
    page.getByRole("button", { name: "Pause updates" }),
  ).toBeVisible();
  await fixture.drain();
  await page.getByRole("button", { name: "Show new results" }).click();
  await expect(page.locator(".classifier-result-list li")).toHaveCount(2);
  expect(fixture.state.calls).toBe(2);
  expect(await client.reviewTask.count()).toBe(0);
  await page.getByRole("button", { name: "Sync now" }).click();
  await fixture.drain();
  expect(fixture.state.calls).toBe(2);
  await page.getByRole("button", { name: "Pause updates" }).click();
  await expect(
    page.getByText("Automatic updates paused", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByLabel("Local API token").fill(browserToken);
  await page.getByRole("button", { name: "Unlock workspace" }).click();
  await expect(
    page.getByText("Automatic updates paused", { exact: true }),
  ).toBeVisible();
});

test("failed processing recovers a lost retry response and preserves the original attempt", async ({
  page,
}) => {
  const fixture = await dailyFeedFixture(database);
  fixture.state.invalidOutput = true;
  await fixture.drain();
  const original = await client.classifierResultSnapshot.findFirstOrThrow();
  await unlock(page, `/?view=results&result=${original.runId}`);
  const retryPath = `**/v1/processing/results/${original.runId}/retry`;
  let dropped = false;
  await page.route(retryPath, async (route) => {
    if (!dropped) {
      dropped = true;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort("failed");
    } else await route.continue();
  });
  await page
    .getByRole("button", { name: "Retry processing", exact: true })
    .click();
  await expect(
    page.getByText(/The retry could not be confirmed/),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Retry processing", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Retry queued", exact: true }),
  ).toBeVisible();
  expect(await client.feedCommandReceipt.count()).toBe(1);
  fixture.state.invalidOutput = false;
  await fixture.drain();
  expect(
    (
      await client.classifierResultSnapshot.findUniqueOrThrow({
        where: { runId: original.runId },
      })
    ).originalOutput,
  ).toEqual(original.originalOutput);
  expect(
    await client.classificationRun.count({
      where: { attempt: 2, errorCode: null },
    }),
  ).toBe(1);
  await expect(
    page.getByText("Processing did not complete", { exact: true }),
  ).toBeVisible();
});

test("@a11y processing status and recovery controls fit desktop and mobile", async ({
  page,
}) => {
  const fixture = await dailyFeedFixture(database);
  fixture.state.invalidOutput = true;
  await fixture.drain();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await unlock(page, "/?view=results");
  await page
    .getByText("Processing details · 2 failed", { exact: true })
    .click();
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const report = await new AxeBuilder({ page }).analyze();
    expect(
      report.violations.filter(
        (item) => item.impact === "serious" || item.impact === "critical",
      ),
    ).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await screenshot(
      page,
      viewport.width === 390 ? "processing-mobile" : "processing-desktop",
    );
  }
  const retry = page.getByRole("button", { name: "Retry #910001" });
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText(
      "Retry queued. Earlier predictions and corrections are preserved.",
      { exact: true },
    ),
  ).toBeVisible();
});
