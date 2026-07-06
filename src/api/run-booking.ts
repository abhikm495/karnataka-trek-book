import { loadAppConfig, loadBookingConfig } from "../config.js";
import type { TestMode } from "../types.js";
import { loadOtpReaderConfig, waitForOtp } from "../utils/otp-reader.js";
import { promptUser } from "../utils/prompt.js";
import {
  checkAvailability,
  fetchBookingCaptcha,
  generateOtp,
  prepareBookingSession,
  selectTimeslot,
  submitSummaryBlade,
  verifyOtpApi,
} from "./booking.js";
import { apiLogin } from "./login.js";
import { initiateSurepayPayment } from "./payment-api.js";
import { payViaUpiApi } from "./upi-payment.js";
import { resolve } from "node:path";

async function completeUpiPayment(
  session: Awaited<ReturnType<typeof apiLogin>>["session"],
  paymentUrl: string,
  upiVpa: string,
  testMode: TestMode,
): Promise<void> {
  if (testMode === "dry-run") {
    console.log(`\n[dry-run] Stopping before UPI. Payment URL:\n${paymentUrl}`);
    return;
  }

  await payViaUpiApi(session, paymentUrl, upiVpa);
}

async function main(): Promise<void> {
  const appConfig = loadAppConfig();
  const booking = loadBookingConfig();

  console.log("\nAranya Vihaara API Booking\n");

  const { session } = await apiLogin(appConfig);
  const csrfToken = await prepareBookingSession(session, appConfig.baseUrl);
  console.log("→ CSRF token ready");

  await checkAvailability(session, appConfig.baseUrl, booking, csrfToken);

  const bookingToken = await selectTimeslot(
    session,
    appConfig.baseUrl,
    booking,
    csrfToken,
  );

  if (appConfig.testMode === "preview") {
    console.log(
      "\n[preview] Slots available and booking page loaded. Stopping before " +
        "OTP/payment — no booking is created, so nothing is left pending.",
    );
    return;
  }

  const otpMobile = booking.members[0].mobile;
  await generateOtp(session, appConfig.baseUrl, otpMobile, bookingToken);

  console.log(`\n*** OTP sent to ${otpMobile} ***\n`);
  const otp = await waitForOtp(loadOtpReaderConfig());

  await verifyOtpApi(session, appConfig.baseUrl, otp, otpMobile, bookingToken);

  const captchaPath = await fetchBookingCaptcha(session, appConfig.baseUrl);
  console.log(`\n*** Booking CAPTCHA saved: ${resolve(captchaPath)} ***`);
  console.log("   Open that image and type the characters you see.");
  const captcha = await promptUser("Enter booking captcha: ");
  if (!captcha) throw new Error("Booking captcha is required.");

  const summaryHtml = await submitSummaryBlade(
    session,
    appConfig.baseUrl,
    booking,
    bookingToken,
    captcha,
  );

  const surepayUrl = await initiateSurepayPayment(session, summaryHtml);
  await completeUpiPayment(session, surepayUrl, booking.upiVpa, appConfig.testMode);

  console.log("\n✓ API booking flow complete");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n✗ API booking failed: ${message}`);
  process.exit(1);
});
