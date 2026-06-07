import type { Page } from "playwright";
import type { AppConfig } from "./types.js";
import { selectors } from "./selectors.js";
import { promptUser } from "./utils/prompt.js";

async function readCaptcha(page: Page): Promise<string> {
  const captchaLocator = page.locator(selectors.login.captchaImage);
  await captchaLocator.waitFor({ state: "visible", timeout: 10_000 });

  const text = (await captchaLocator.textContent())?.trim() ?? "";
  if (text) {
    console.log(`→ CAPTCHA read from page: ${text}`);
    return text;
  }

  console.log("→ Could not read CAPTCHA automatically.");
  return promptUser("Enter CAPTCHA shown on the page: ");
}

async function handleSessionConflictIfPresent(page: Page): Promise<void> {
  const modal = page.locator(selectors.login.sessionConflictModal);
  const isVisible = await modal
    .waitFor({ state: "visible", timeout: 3_000 })
    .then(() => true)
    .catch(() => false);

  if (!isVisible) {
    return;
  }

  console.log('→ Session already active — clicking "Login Here"...');
  const loginHere = page.locator(selectors.login.sessionConflictLoginHere).first();
  if (await loginHere.isVisible().catch(() => false)) {
    await loginHere.click();
  } else {
    await page.locator(selectors.login.forceLoginForm).evaluate((form) => {
      (form as HTMLFormElement).submit();
    });
  }

  await page.waitForLoadState("networkidle").catch(() => undefined);
}

export async function login(page: Page, config: AppConfig): Promise<void> {
  const loginUrl = `${config.baseUrl}${selectors.login.url}`;
  console.log(`→ Navigating to ${loginUrl}...`);
  await page.goto(loginUrl, { waitUntil: "domcontentloaded" });

  await page.locator(selectors.login.email).waitFor({
    state: "visible",
    timeout: 30_000,
  });

  console.log("→ Filling login credentials...");
  await page.locator(selectors.login.email).fill(config.email);
  await page.locator(selectors.login.password).fill(config.password);

  const captcha = await readCaptcha(page);
  await page.locator(selectors.login.captchaInput).fill(captcha);

  console.log("→ Submitting login...");
  await page.locator(selectors.login.submit).click();

  await page.waitForLoadState("networkidle").catch(() => undefined);
  await handleSessionConflictIfPresent(page);

  const stillOnLogin = page.url().includes("/login");
  if (stillOnLogin) {
    const errorText = await page
      .locator(selectors.login.errorMessage)
      .allTextContents()
      .then((parts) => parts.join(" ").trim())
      .catch(() => "");

    throw new Error(
      errorText
        ? `Login failed: ${errorText}`
        : "Login failed. Check EMAIL, PASSWORD, or CAPTCHA.",
    );
  }

  console.log("✓ Login successful");
}
