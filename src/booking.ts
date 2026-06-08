import type { Page } from "playwright";
import type { BookingConfig, Member } from "./types.js";
import { selectors } from "./selectors.js";
import { loadOtpReaderConfig, waitForOtp } from "./utils/otp-reader.js";
import {
  getDataIndex,
  getGenderValue,
  getVisitorRowId,
} from "./utils/visitors.js";

async function fillMemberFields(
  page: Page,
  member: Member,
  memberIndex: number,
): Promise<void> {
  const dataIndex = getDataIndex(memberIndex);
  const rowId = getVisitorRowId(memberIndex);

  console.log(`→ Filling visitor ${memberIndex + 1} (data[${dataIndex}]): ${member.name}`);

  const row = page.locator(`#${rowId}`);
  await row.waitFor({ state: "visible", timeout: 15_000 });

  await row.locator(selectors.members.name(dataIndex)).fill(member.name);
  await row.locator(selectors.members.idType(dataIndex)).selectOption(member.idType);
  await row.locator(selectors.members.idNumber(dataIndex)).fill(member.idNumber);
  await row.locator(selectors.members.age(dataIndex)).fill(String(member.age));
  await row
    .locator(selectors.members.gender(dataIndex))
    .selectOption(getGenderValue(member, dataIndex));
  await row.locator(selectors.members.mobile(dataIndex)).fill(member.mobile);
}

async function addNextVisitor(page: Page, nextMemberIndex: number): Promise<void> {
  const nextDataIndex = getDataIndex(nextMemberIndex);
  const nextRowId = getVisitorRowId(nextMemberIndex);

  console.log("→ Clicking + Add Visitors...");
  await page.locator(selectors.members.addVisitorButton).click();

  await page.locator(`#${nextRowId}`).waitFor({
    state: "visible",
    timeout: 15_000,
  });
  await page.locator(selectors.members.name(nextDataIndex)).waitFor({
    state: "visible",
    timeout: 15_000,
  });
}

export async function fillMembers(
  page: Page,
  booking: BookingConfig,
): Promise<void> {
  if (booking.members.length > 3) {
    throw new Error("Maximum 3 members allowed per booking.");
  }

  await page.locator(selectors.members.formRow).waitFor({
    state: "visible",
    timeout: 30_000,
  });

  for (let i = 0; i < booking.members.length; i++) {
    await fillMemberFields(page, booking.members[i], i);

    if (i < booking.members.length - 1) {
      await addNextVisitor(page, i + 1);
    }
  }

  console.log("✓ All members filled");
}

export async function verifyOtp(page: Page): Promise<void> {
  console.log("→ Clicking Get OTP...");
  await page.locator(selectors.members.getOtpButton).click();

  const otpInput = page.locator(selectors.members.otpInput).first();
  await otpInput.waitFor({ state: "visible", timeout: 30_000 });

  console.log("\n*** OTP sent — check mobile numbers on the form ***\n");
  const otp = await waitForOtp(loadOtpReaderConfig());

  await otpInput.fill(otp);

  console.log("→ Clicking Verify OTP...");
  await page.locator(selectors.members.verifyOtpButton).click();

  await page.waitForLoadState("networkidle").catch(() => undefined);
  console.log("✓ OTP verified");
}

export async function acceptTermsAndProceed(page: Page): Promise<void> {
  console.log("→ Accepting terms and conditions...");
  const terms = page.locator(selectors.members.termsCheckbox);
  await terms.waitFor({ state: "visible", timeout: 30_000 });
  await terms.check();

  console.log("→ Clicking Proceed to Payment...");
  await page.locator(selectors.members.proceedToPayment).click();
  await page.waitForLoadState("networkidle").catch(() => undefined);

  console.log("✓ Proceeded to payment page");
}
