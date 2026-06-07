import { existsSync } from "node:fs";
import type { Step } from "./types.js";
import { loadAppConfig, loadBookingConfig } from "./config.js";
import { login } from "./login.js";
import { checkAvailability, selectTimeSlot } from "./availability.js";
import { acceptTermsAndProceed, fillMembers, verifyOtp } from "./booking.js";
import { handlePayment } from "./payment.js";
import { downloadPermit } from "./download.js";
import { createBrowserSession, saveSession } from "./utils/browser.js";
import { ensureLoggedIn } from "./utils/session.js";

function parseArgs(argv: string[]): { step: Step; saveSession: boolean } {
  let step: Step = "all";
  let shouldSaveSession = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--step" && argv[i + 1]) {
      step = argv[i + 1] as Step;
      i++;
    }
    if (argv[i] === "--save-session") {
      shouldSaveSession = true;
    }
  }

  return { step, saveSession: shouldSaveSession };
}

async function main(): Promise<void> {
  const { step, saveSession: shouldSaveSession } = parseArgs(process.argv.slice(2));
  const appConfig = loadAppConfig();
  const booking = loadBookingConfig();

  const useSavedSession = existsSync(appConfig.authPath) && step !== "login";
  const session = await createBrowserSession(
    useSavedSession ? appConfig.authPath : undefined,
    false,
  );

  try {
    console.log(`\nAranya Vihaara Booking Bot`);
    console.log(`Mode: ${appConfig.testMode} | Step: ${step}\n`);

    if (step === "login" || step === "all") {
      await login(session.page, appConfig);
      await saveSession(session.context, appConfig.authPath);
      console.log(`✓ Session saved to ${appConfig.authPath}`);
      if (step === "login") return;
    }

    if (!existsSync(appConfig.authPath)) {
      throw new Error(
        "No saved session found. Run `npm run save-session` first.",
      );
    }

    if (step === "availability" || step === "all") {
      await session.page.goto(`${appConfig.baseUrl}/`, {
        waitUntil: "domcontentloaded",
      });
      await ensureLoggedIn(session.page, appConfig, session.context);
      await checkAvailability(session.page, booking);
      await selectTimeSlot(session.page, booking, {
        appConfig,
        context: session.context,
      });
      if (step === "availability") {
        await session.page.pause();
        return;
      }
    }

    if (step === "booking" || step === "all") {
      if (step === "booking") {
        console.log("Assuming you are already on the member details page.");
      }
      await fillMembers(session.page, booking);
      await verifyOtp(session.page);
      await acceptTermsAndProceed(session.page);
      if (step === "booking") {
        await session.page.pause();
        return;
      }
    }

    if (step === "payment" || step === "all") {
      await handlePayment(session.page, appConfig.testMode, booking.upiVpa);
      if (step === "payment" || appConfig.testMode !== "live") return;
    }

    if (step === "download" || (step === "all" && appConfig.testMode === "live")) {
      await downloadPermit(session.page, booking);
    }

    if (shouldSaveSession) {
      await saveSession(session.context, appConfig.authPath);
    }
  } finally {
    await session.browser.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n✗ Bot failed: ${message}`);
  process.exit(1);
});
