import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(projectRoot, "browsers");

export type BrowserSession = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
};

export async function createBrowserSession(
  authPath?: string,
  headless = false,
): Promise<BrowserSession> {
  const browser = await chromium.launch({ headless });

  const contextOptions =
    authPath && existsSync(authPath) ? { storageState: authPath } : {};

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (["image", "font", "media"].includes(type)) {
      return route.abort();
    }
    route.continue();
  });

  return { browser, context, page };
}

export async function saveSession(
  context: BrowserContext,
  authPath: string,
): Promise<void> {
  mkdirSync(dirname(authPath), { recursive: true });
  await context.storageState({ path: authPath });
}
