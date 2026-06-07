import type { Page } from "playwright";
import type { TestMode } from "./types.js";
import { selectors } from "./selectors.js";

async function resolveSurepayPage(page: Page): Promise<Page> {
  const popup = await page
    .context()
    .waitForEvent("page", { timeout: 5_000 })
    .catch(() => null);

  const paymentPage = popup ?? page;

  await paymentPage.waitForURL(
    (url) => url.href.includes(selectors.payment.surepayUrl),
    { timeout: 60_000 },
  );

  console.log(`→ Payment gateway loaded: ${paymentPage.url()}`);
  return paymentPage;
}

async function openUpiSection(paymentPage: Page): Promise<void> {
  if (paymentPage.url().includes(selectors.payment.upiPageUrl)) {
    console.log("→ Already on UPI page, skipping UPI link click.");
    return;
  }

  console.log("→ Clicking UPI payment option...");
  const upiLink = paymentPage.locator(selectors.payment.upiOption).first();
  await upiLink.waitFor({ state: "visible", timeout: 30_000 });
  await upiLink.click();

  await paymentPage.waitForURL(
    (url) => url.href.includes(selectors.payment.upiPageUrl),
    { timeout: 30_000 },
  );

  console.log(`→ UPI page loaded: ${paymentPage.url()}`);
}

async function fillUpiPayment(
  paymentPage: Page,
  upiVpa: string,
): Promise<void> {
  await openUpiSection(paymentPage);

  const vpaInput = paymentPage.locator(selectors.payment.vpaInput).first();
  await vpaInput.waitFor({ state: "visible", timeout: 30_000 });
  await vpaInput.fill(upiVpa);
  console.log(`→ VPA filled: ${upiVpa}`);

  console.log("→ Clicking Pay Now...");
  await paymentPage.locator(selectors.payment.payNowButton).first().click();

  console.log("\n*** UPI request sent — approve the payment on your phone. ***");
  console.log("    Waiting up to 5 minutes for confirmation...\n");

  const failed = paymentPage.locator(selectors.payment.failureMessage).first();
  const succeeded = paymentPage.locator(selectors.payment.successMessage).first();

  await Promise.race([
    failed.waitFor({ state: "visible", timeout: 300_000 }),
    succeeded.waitFor({ state: "visible", timeout: 300_000 }),
    paymentPage
      .waitForURL((url) => url.href.includes(selectors.payment.confirmationUrl), {
        timeout: 300_000,
      })
      .catch(() => undefined),
  ]).catch(() => undefined);

  if (await failed.isVisible().catch(() => false)) {
    console.log("✗ Payment failed or was declined.");
    return;
  }

  console.log("✓ Payment step finished — verify booking confirmation.");
}

export async function handlePayment(
  page: Page,
  _testMode: TestMode,
  upiVpa: string,
): Promise<void> {
  const paymentPage = await resolveSurepayPage(page);
  await fillUpiPayment(paymentPage, upiVpa);
}
