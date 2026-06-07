import type { BrowserContext, Page } from "playwright";
import type { AppConfig } from "../types.js";
import { login } from "../login.js";
import { selectors } from "../selectors.js";
import { saveSession } from "./browser.js";

export async function isLoginPage(page: Page): Promise<boolean> {
  if (page.url().includes("/login")) {
    return true;
  }

  return page
    .locator(selectors.login.email)
    .first()
    .isVisible()
    .catch(() => false);
}

export async function ensureLoggedIn(
  page: Page,
  config: AppConfig,
  context: BrowserContext,
): Promise<void> {
  if (!(await isLoginPage(page))) {
    return;
  }

  console.log("→ Session expired — logging in again...");
  await login(page, config);
  await saveSession(context, config.authPath);
  console.log("✓ Session refreshed");
}
