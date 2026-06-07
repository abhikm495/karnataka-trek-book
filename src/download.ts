import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type { BookingConfig } from "./types.js";
import { selectors } from "./selectors.js";
import { clickFirstVisible } from "./utils/locators.js";

export async function downloadPermit(
  page: Page,
  booking: BookingConfig,
  outputDir = "downloads",
): Promise<string> {
  console.log("→ Navigating to My Bookings...");

  await clickFirstVisible(page, selectors.download.myBookingsNav).catch(() => undefined);
  await clickFirstVisible(page, selectors.download.upcomingTreks).catch(() => undefined);

  mkdirSync(outputDir, { recursive: true });
  const fileName = `permit-${booking.date.replace(/-/g, "")}.pdf`;
  const filePath = join(outputDir, fileName);

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    clickFirstVisible(page, selectors.download.downloadButton),
  ]);

  await download.saveAs(filePath);
  console.log(`✓ Permit downloaded to ${filePath}`);
  return filePath;
}
