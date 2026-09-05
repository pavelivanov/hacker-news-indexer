import { readFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { chromium } from "@playwright/test";
import { checkTarget } from "./target.mjs";

const env = parseEnv(await readFile(".env.manual-review.local", "utf8"));
checkTarget(env.DATABASE_URL, "hn_manual_review");
if (
  !env.APP_API_TOKEN ||
  env.HOST !== "127.0.0.1" ||
  env.CLASSIFIER_ENABLED !== "false" ||
  env.TELEGRAM_ENABLED !== "false"
)
  throw new Error("Invalid local configuration");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  await page.route("**/*", async (route) => {
    if (
      new URL(route.request().url()).origin !== "http://127.0.0.1:5173" ||
      route.request().method() !== "GET"
    )
      throw new Error("Browser smoke permits only read-only local requests");
    await route.continue();
  });
  await page.goto("http://127.0.0.1:5173/?view=inbox");
  await page.getByLabel("Local API token").fill(env.APP_API_TOKEN);
  await page.getByRole("button", { name: "Unlock workspace" }).click();
  await page.getByRole("navigation", { name: "Main navigation" }).waitFor();
  const rows = page.locator(".inbox-list a");
  await rows.first().waitFor();
  await mkdir("output/playwright", { recursive: true });
  await page.screenshot({
    path: "output/playwright/local-inbox.png",
    fullPage: true,
  });
  const count = Math.min(5, await rows.count());
  for (let i = 0; i < count; i += 1) {
    await rows.nth(i).click();
    await page.getByRole("region", { name: "Source evidence" }).waitFor();
    await page.getByRole("heading", { name: "Evidence & context" }).waitFor();
    if (i === 0)
      await page.screenshot({
        path: "output/playwright/local-source.png",
        fullPage: true,
      });
  }
  if (
    (await page.evaluate(
      () => globalThis.localStorage.length + globalThis.sessionStorage.length,
    )) !== 0
  )
    throw new Error("Unexpected browser persistence");
  await page.getByRole("button", { name: "Lock", exact: true }).click();
  if ((await page.getByLabel("Local API token").inputValue()) !== "")
    throw new Error("Token input was not cleared");
  console.log(
    JSON.stringify({
      capturedCommentsOpened: count,
      mutations: 0,
      persistentBrowserEntries: 0,
      lockClearsToken: true,
    }),
  );
} finally {
  await browser.close();
}
