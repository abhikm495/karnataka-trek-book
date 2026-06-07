import type { BrowserContext, Page } from "playwright";
import type { AppConfig, BookingConfig } from "./types.js";
import { selectors } from "./selectors.js";
import { toSiteDate } from "./utils/date.js";
import { ensureLoggedIn, isLoginPage } from "./utils/session.js";

async function setReadonlyDate(page: Page, isoDate: string): Promise<void> {
  const displayDate = toSiteDate(isoDate);
  await page.locator(selectors.availability.date).evaluate((el, value) => {
    const input = el as HTMLInputElement;
    input.removeAttribute("readonly");
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, displayDate);
}

export async function checkAvailability(
  page: Page,
  booking: BookingConfig,
): Promise<void> {
  console.log("→ Waiting for availability form...");
  const districtField = page.locator(selectors.availability.district);
  if (!(await districtField.isVisible().catch(() => false))) {
    await page.getByText("Search Trek Availability", { exact: false }).first().click();
  }
  await districtField.waitFor({ state: "visible", timeout: 30_000 });

  console.log(`→ Selecting district: ${booking.district}`);
  const districtSelect = page.locator(selectors.availability.district);
  if (booking.districtId) {
    await districtSelect.selectOption(booking.districtId);
  } else {
    await districtSelect.selectOption({ label: booking.district });
  }

  console.log("→ Waiting for trek list to load...");
  const trekOption = booking.trekId
    ? page.locator(`${selectors.availability.trek} option[value="${booking.trekId}"]`)
    : page
        .locator(`${selectors.availability.trek} option`)
        .filter({ hasText: booking.trek })
        .first();
  await trekOption.waitFor({ state: "attached", timeout: 15_000 });

  console.log(`→ Selecting trek: ${booking.trek}`);
  const trekSelect = page.locator(selectors.availability.trek);
  if (booking.trekId) {
    await trekSelect.selectOption(booking.trekId);
  } else {
    await trekSelect.selectOption({ label: booking.trek });
  }

  console.log(`→ Selecting date: ${booking.date} (${toSiteDate(booking.date)})`);
  await setReadonlyDate(page, booking.date);

  console.log("→ Checking availability...");
  await page.locator(selectors.availability.checkButton).click();
  await page.waitForLoadState("networkidle").catch(() => undefined);

  await page.locator(selectors.availability.slotResults).first().waitFor({
    state: "visible",
    timeout: 30_000,
  });

  console.log("✓ Availability results loaded");
}

type SelectTimeSlotOptions = {
  appConfig: AppConfig;
  context: BrowserContext;
};

async function selectSlotRadio(page: Page, booking: BookingConfig): Promise<void> {
  if (booking.timeSlotMappingId) {
    const radio = page.locator(
      selectors.slot.slotRadio(booking.timeSlotMappingId),
    );
    await radio.waitFor({ state: "visible", timeout: 15_000 });
    await radio.check();
    return;
  }

  if (booking.timeSlotId) {
    const card = page.locator(selectors.slot.slotCard(booking.timeSlotId));
    await card.waitFor({ state: "visible", timeout: 15_000 });
    await card.click();
    return;
  }

  const slotText = page.locator(selectors.slot.slotByTime(booking.timeSlot));
  await slotText.waitFor({ state: "visible", timeout: 15_000 });
  await slotText.click();
}

async function retryAfterSessionExpiry(
  page: Page,
  booking: BookingConfig,
  options: SelectTimeSlotOptions,
): Promise<void> {
  await ensureLoggedIn(page, options.appConfig, options.context);

  await page.goto(`${options.appConfig.baseUrl}/`, {
    waitUntil: "domcontentloaded",
  });
  await checkAvailability(page, booking);
  await selectSlotRadio(page, booking);

  console.log("→ Clicking Book Now (retry)...");
  await page.locator(selectors.slot.bookNow).click();
  await page.waitForLoadState("networkidle").catch(() => undefined);

  if (await isLoginPage(page)) {
    throw new Error("Session expired again after retry. Run `npm run save-session`.");
  }
}

export async function selectTimeSlot(
  page: Page,
  booking: BookingConfig,
  options: SelectTimeSlotOptions,
): Promise<void> {
  console.log(`→ Selecting time slot: ${booking.timeSlot}`);
  await selectSlotRadio(page, booking);

  console.log("→ Clicking Book Now...");
  await page.locator(selectors.slot.bookNow).click();
  await page.waitForLoadState("networkidle").catch(() => undefined);

  if (await isLoginPage(page)) {
    console.log("→ Redirected to login after Book Now — recovering...");
    await retryAfterSessionExpiry(page, booking, options);
  }

  console.log("✓ Time slot selected and Book Now clicked");
}
