import { mkdirSync, writeFileSync } from "node:fs";
import type { BookingConfig } from "../types.js";
import { toSiteDate } from "../utils/date.js";
import { getDataIndex, getGenderValue } from "../utils/visitors.js";
import { csrfHeaders, fetchCsrfToken } from "./csrf.js";
import type { ApiSession } from "./http.js";

type OtpResponse = {
  success: boolean;
  maskedMobile?: string;
  message?: string;
};

function debugDump(name: string, content: string): void {
  try {
    mkdirSync("debug", { recursive: true });
    writeFileSync(`debug/${name}`, content, "utf-8");
  } catch {
    // best-effort debug only
  }
}

function extractPageToken(html: string): string | undefined {
  return (
    html.match(/name="_token"\s+value="([^"]+)"/)?.[1] ??
    html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/i)?.[1]
  );
}

function buildSummaryBody(
  booking: BookingConfig,
  csrfToken: string,
  captcha: string,
): URLSearchParams {
  const body = new URLSearchParams();
  body.set("_token", csrfToken);

  booking.members.forEach((member, index) => {
    const dataIndex = getDataIndex(index);
    body.set(`data[${dataIndex}][name]`, member.name);
    body.set(`data[${dataIndex}][govt_id_type]`, member.idType);
    body.set(`data[${dataIndex}][govt_id]`, member.idNumber);
    body.set(`data[${dataIndex}][age]`, String(member.age));
    body.set(`data[${dataIndex}][gender]`, getGenderValue(member, dataIndex));
    body.set(`data[${dataIndex}][mobile_no]`, member.mobile);
  });

  body.set("trek_id", booking.trekId);
  body.set("timeslot_mapping_id", booking.timeSlotMappingId);
  body.set("check_in", toSiteDate(booking.date));
  body.set("TimeslotId", booking.timeSlotId);
  body.set("captcha", captcha);

  return body;
}

/**
 * Fetches the server-generated booking captcha image (GET /captcha) within the
 * authenticated session. The site stores the expected answer in the session, so
 * this MUST run in the same session that later POSTs /summaryblade. Saves the
 * PNG so the user can read and type it. Returns the saved file path.
 */
export async function fetchBookingCaptcha(
  session: ApiSession,
  baseUrl: string,
): Promise<string> {
  const maxAttempts = 3;
  let lastInfo = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await session.fetch(`${baseUrl}/captcha?${Date.now()}`, {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "image/avif,image/webp,image/png,image/svg+xml,image/*,*/*;q=0.8",
        Referer: `${baseUrl}/getTimeslot`,
      },
    });
    const status = response.status;
    const contentType = response.headers.get("content-type") ?? "";
    const location = response.headers.get("location");
    const bytes = Buffer.from(await response.arrayBuffer());
    // #region agent log
    fetch('http://127.0.0.1:7376/ingest/96710515-8200-419e-92fd-efa26743fc27',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'e16102'},body:JSON.stringify({sessionId:'e16102',hypothesisId:'CAPTCHA-HTML',location:'booking.ts:fetchBookingCaptcha',message:'captcha fetch attempt',data:{attempt,status,contentType,location,bytes:bytes.length,isImage:contentType.startsWith('image/'),bodyStart:bytes.slice(0,60).toString('utf-8').replace(/\s+/g,' '),cookies:session.getCookieNames()},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    mkdirSync("debug", { recursive: true });
    if (status === 200 && contentType.startsWith("image/") && bytes.length > 0) {
      const path = "debug/booking-captcha.png";
      writeFileSync(path, bytes);
      return path;
    }

    // Not an image — the site served a redirect/HTML page instead (session or
    // rate-limit state). Save it for inspection and retry.
    writeFileSync("debug/captcha-nonimage.html", bytes);
    lastInfo = `status ${status}, content-type "${contentType || "?"}"` +
      `${location ? `, → ${location}` : ""}, ${bytes.length} bytes`;
    console.log(`⚠ captcha not an image (attempt ${attempt}): ${lastInfo} — retrying`);
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(
    `Could not load the booking captcha image after ${maxAttempts} attempts ` +
      `(${lastInfo}). The site returned a page instead of the image — saved to ` +
      `debug/captcha-nonimage.html. This usually means the booking session lapsed ` +
      `(re-run) or the captcha endpoint is rate-limited.`,
  );
}

/** Headers matching a native browser form navigation (not XHR). The site
 * returns slot HTML for these, but 302s to "/" for XHR-flavored requests. */
function navigationHeaders(baseUrl: string, referer: string): Record<string, string> {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    Origin: baseUrl,
    Referer: referer,
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
  };
}

function summaryHeaders(baseUrl: string): Record<string, string> {
  return navigationHeaders(baseUrl, `${baseUrl}/getTimeslot`);
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid JSON response (${response.status}): ${text.slice(0, 200)}`);
  }
}

export async function checkAvailability(
  session: ApiSession,
  baseUrl: string,
  booking: BookingConfig,
  csrfToken: string,
): Promise<void> {
  const districtId = booking.districtId;
  if (!districtId) {
    throw new Error("Missing DISTRICT_ID in .env — required for the API booking flow.");
  }
  const siteDate = toSiteDate(booking.date);
  const trekName = await fetchTrekName(session, baseUrl, districtId, booking.trekId, csrfToken);

  console.log("");
  console.log("──────── Booking context ────────");
  console.log(`  District : ${districtId}`);
  console.log(`  Trek     : ${booking.trekId}${trekName ? ` — ${trekName}` : ""}`);
  console.log(`  Date     : ${siteDate}`);
  console.log(`  Slot     : mapping ${booking.timeSlotMappingId}, timeslot ${booking.timeSlotId}`);
  console.log(`  Party    : ${booking.members.length} member(s)`);
  console.log("─────────────────────────────────");

  console.log(`→ POST /availability (district ${districtId}, ${siteDate})`);

  const body = new URLSearchParams({
    _token: csrfToken,
    district: districtId,
    trek: booking.trekId,
    check_in: siteDate,
  });

  // Native-navigation headers make the site return the slot HTML; XHR-style
  // headers make it 302 to "/" with no slots.
  const response = await session.fetch(`${baseUrl}/availability`, {
    method: "POST",
    headers: navigationHeaders(baseUrl, `${baseUrl}/`),
    body: body.toString(),
    redirect: "manual",
  });
  const status = response.status;
  const location = response.headers.get("location");
  let pageHtml = await response.text().catch(() => "");

  if (status === 302 && location) {
    pageHtml = await session
      .fetch(new URL(location, baseUrl).toString(), { method: "GET", redirect: "follow" })
      .then((r) => r.text())
      .catch(() => "");
  } else if (status !== 200) {
    throw new Error(
      `availability failed with status ${status} (location=${location}).`,
    );
  }

  debugDump(
    "availability.html",
    `status=${status}\nlocation=${location}\n\n${pageHtml}`,
  );

  // The site disables the availability form and blocks EVERY date while a prior
  // booking is mid-processing (e.g. an initiated-but-unpaid UPI collect). This
  // otherwise looks like "no slots for this date", so detect it explicitly.
  const processingBlock = /previous booking is still being processed/i.test(pageHtml);
  if (processingBlock) {
    throw new Error(
      `The site is still processing your previous booking, so availability is blocked ` +
        `for ALL dates until its status updates.\n` +
        `→ Complete the pending payment, or let it expire/fail, then retry. Note: reaching ` +
        `the payment form (/summaryblade) already creates a booking, so even TEST_MODE=dry-run ` +
        `leaves one pending. Use TEST_MODE=preview to test up to slot selection without ` +
        `creating any booking.`,
    );
  }

  const slots = extractAllSlots(pageHtml);

  if (slots.length > 0) {
    console.log(`→ Slots for ${siteDate}:`);
    for (const s of slots) {
      const full = s.disabled || s.available <= 0;
      console.log(
        `   • ${s.time} — ${s.available}/${s.total} available` +
          `  [mapping ${s.mappingId}]${full ? "  ✗ FULL" : "  ✓ open"}`,
      );
    }
  } else {
    console.log(`⚠ No slot cards returned for ${siteDate} (date may be blocked/unavailable).`);
  }

  console.log("✓ Availability selected (date stored in session)");

  const target = slots.find((s) => s.mappingId === booking.timeSlotMappingId);
  if (!target) {
    throw new Error(
      `Slot mapping ${booking.timeSlotMappingId} is not offered for ${siteDate} ` +
        `(the site returned ${slots.length} slot(s) for this date). The date may be blocked/` +
        `unavailable, or TIME_SLOT_MAPPING_ID/TREK_ID/DATE in .env don't match. ` +
        `Aborting before OTP/payment.`,
    );
  }

  if (target.disabled || target.available <= 0) {
    throw new Error(
      `Slot ${booking.timeSlotMappingId} (${target.time}) is FULL — ` +
        `${target.available}/${target.total} available for ${siteDate}. The site would still let ` +
        `you reach payment, but the booking is rejected/refunded at settlement. ` +
        `Pick another date or slot in .env.`,
    );
  }

  const party = booking.members.length;
  if (target.available < party) {
    throw new Error(
      `Slot ${booking.timeSlotMappingId} (${target.time}) has only ${target.available} seat(s) ` +
        `left but your party is ${party}. Reduce members or choose another slot.`,
    );
  }
}

type SlotAvailability = {
  mappingId: string;
  time: string;
  available: number;
  total: number;
  disabled: boolean;
};

/** Parse every timeslot card: time label, mapping id, "N/M Available", disabled. */
function extractAllSlots(html: string): SlotAvailability[] {
  const slots: SlotAvailability[] = [];
  const inputRe = /<input[^>]*name="timeslot_mapping_id"[^>]*value="(\d+)"[^>]*>/gi;
  for (const m of html.matchAll(inputRe)) {
    const mappingId = m[1];
    const start = m.index ?? 0;
    const disabled = /\sdisabled\b/i.test(m[0]);

    const before = html.slice(Math.max(0, start - 700), start);
    const time =
      [...before.matchAll(/slot_text[^>]*>([\s\S]*?)<\/div>/gi)]
        .pop()?.[1]
        ?.replace(/&nbsp;/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim() ?? "slot";

    // The count sits in the `available_text` div right after the radio. The
    // label word is localized (English "Available" / Kannada "ಲಭ್ಯವಿದೆ"), so
    // key off the "N/M" number pair, not the word.
    const after = html.slice(start, start + 500);
    const seats =
      after.match(/available_text[^>]*>[\s\S]*?(\d+)\s*\/\s*(\d+)/i) ??
      after.match(/(\d+)\s*\/\s*(\d+)/);
    slots.push({
      mappingId,
      time,
      available: seats ? Number(seats[1]) : disabled ? 0 : Number.NaN,
      total: seats ? Number(seats[2]) : Number.NaN,
      disabled,
    });
  }
  return slots;
}

/** Look up the English trek name via the site's /get-treks dropdown endpoint. */
async function fetchTrekName(
  session: ApiSession,
  baseUrl: string,
  districtId: string,
  trekId: string,
  csrfToken: string,
): Promise<string | undefined> {
  try {
    const response = await session.fetch(`${baseUrl}/get-treks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...csrfHeaders(csrfToken),
      },
      body: new URLSearchParams({ _token: csrfToken, district_id: districtId }).toString(),
    });
    const treks = (await response.json()) as Array<{ id: number; name?: string }>;
    return treks.find((t) => String(t.id) === trekId)?.name;
  } catch {
    return undefined;
  }
}

export async function selectTimeslot(
  session: ApiSession,
  baseUrl: string,
  booking: BookingConfig,
  csrfToken: string,
): Promise<string> {
  const body = new URLSearchParams({
    _token: csrfToken,
    trek_id: booking.trekId,
    timeslot_mapping_id: booking.timeSlotMappingId,
  });

  console.log("→ POST /getTimeslot");
  const response = await fetchUnderLoad(session, "getTimeslot", `${baseUrl}/getTimeslot`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${baseUrl}/`,
      ...csrfHeaders(csrfToken),
    },
    body: body.toString(),
  });

  if (response.status !== 200) {
    throw new Error(`getTimeslot failed with status ${response.status}`);
  }

  const html = await response.text();
  debugDump("getTimeslot.html", html);
  const pageToken = extractPageToken(html);

  console.log("✓ Visitor booking page loaded");
  return pageToken ?? csrfToken;
}

export async function generateOtp(
  session: ApiSession,
  baseUrl: string,
  mobile: string,
  csrfToken: string,
): Promise<void> {
  console.log(`→ POST /summary-generate-otp (${mobile})`);
  const response = await fetchUnderLoad(
    session,
    "generate-otp",
    `${baseUrl}/summary-generate-otp`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Referer: `${baseUrl}/getTimeslot`,
        ...csrfHeaders(csrfToken),
      },
      body: JSON.stringify({ mobile_no: mobile, purpose: "booking" }),
    },
  );

  const text = await response.text();

  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    const wait = retryAfter ? ` Retry after ${retryAfter}s.` : "";
    throw new Error(
      `OTP request rate-limited (429 Too Many Attempts).${wait} Wait before retrying — don't request OTPs back-to-back.`,
    );
  }

  let result: OtpResponse;
  try {
    result = JSON.parse(text) as OtpResponse;
  } catch {
    throw new Error(
      `generate-otp returned non-JSON (status ${response.status}): ${text.slice(0, 200)}`,
    );
  }

  if (!result.success) {
    throw new Error(
      `Failed to generate OTP (status ${response.status}): ${result.message ?? text.slice(0, 200)}`,
    );
  }

  console.log(`✓ OTP sent to ${result.maskedMobile ?? mobile}`);
}

export async function verifyOtpApi(
  session: ApiSession,
  baseUrl: string,
  otp: string,
  mobile: string,
  csrfToken: string,
): Promise<void> {
  console.log("→ POST /summary-verify-otp");
  const response = await fetchUnderLoad(
    session,
    "verify-otp",
    `${baseUrl}/summary-verify-otp`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Referer: `${baseUrl}/getTimeslot`,
        ...csrfHeaders(csrfToken),
      },
      body: JSON.stringify({ otp, mobile_no: mobile }),
    },
  );

  const result = await parseJsonResponse<OtpResponse>(response);
  if (!result.success) {
    throw new Error(result.message ?? "OTP verification failed.");
  }

  console.log(`✓ ${result.message ?? "OTP verified"}`);
}

function describeNetworkError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  const detail = cause?.code ?? cause?.message;
  return detail ? `${error.message} (${detail})` : error.message;
}

/** Retry budget/timeout for surviving the booking-open (midnight) rush.
 * Floors guard against a stray tiny value (e.g. a leftover RUSH_RETRY_BUDGET_MS=1
 * from debugging) silently disabling retries so one transient timeout kills the run. */
function rushConfig(): { attemptTimeoutMs: number; budgetMs: number } {
  return {
    attemptTimeoutMs: Math.max(Number(process.env.RUSH_ATTEMPT_TIMEOUT_MS) || 25000, 5000),
    budgetMs: Math.max(Number(process.env.RUSH_RETRY_BUDGET_MS) || 90000, 15000),
  };
}

/** Fetch that survives the rush: per-attempt timeout, and retries on
 * timeout / network error / 302 / 5xx within a time budget. Returns the first
 * response whose status is NOT retryable (caller handles 200/4xx like 429). */
async function fetchUnderLoad(
  session: ApiSession,
  label: string,
  url: string,
  init: RequestInit,
  retryOn: (status: number) => boolean = (status) => status === 302 || status >= 500,
): Promise<Response> {
  const { attemptTimeoutMs, budgetMs } = rushConfig();
  const deadline = Date.now() + budgetMs;
  let attempt = 0;
  let lastInfo = "";

  while (true) {
    attempt++;
    try {
      const response = await session.fetch(url, {
        ...init,
        signal: AbortSignal.timeout(attemptTimeoutMs),
      });
      if (!retryOn(response.status)) return response;
      lastInfo = `status ${response.status}`;
      console.log(`⚠ ${label} ${lastInfo} (attempt ${attempt}) — retrying`);
    } catch (error) {
      lastInfo = describeNetworkError(error);
      console.log(`⚠ ${label} slow/failed (attempt ${attempt}): ${lastInfo} — retrying`);
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `${label} did not succeed within ${Math.round(budgetMs / 1000)}s after ${attempt} ` +
          `attempts (last: ${lastInfo}). The rush may be too heavy — rerun immediately.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
}

/** Pull a user-facing flash/alert/notify message out of a rendered page. */
function extractFlashReason(html: string): string | undefined {
  const alert = [
    ...html.matchAll(/<div[^>]*class="[^"]*alert[^"]*"[^>]*>([\s\S]*?)<\/div>/gi),
  ]
    .map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .find((t) => t.length > 0 && t.length < 250);
  if (alert) return alert;

  const notify = html.match(/"message"\s*:\s*"([^"]{3,250})"/)?.[1];
  if (notify) return notify;

  const toastr = html.match(
    /toastr\.(?:error|warning|info|success)\(\s*['"]([^'"]{3,250})['"]/i,
  )?.[1];
  return toastr;
}

/** Ask the site why a booking was rejected: follow the /home flash, and (in
 * deep mode) also the persistent "still being processed" banner on /bookinginfo.
 * Light mode (deep=false) only hits /home — used inside the fast retry loop. */
async function fetchBookingRejectionReason(
  session: ApiSession,
  baseUrl: string,
  redirectLocation: string,
  deep = true,
): Promise<string | undefined> {
  const homeHtml = await session
    .fetch(new URL(redirectLocation, baseUrl).toString(), {
      method: "GET",
      redirect: "follow",
    })
    .then((r) => r.text())
    .catch(() => "");
  if (homeHtml) debugDump("home-after-302.html", homeHtml);

  const homeReason = extractFlashReason(homeHtml);
  if (homeReason || !deep) return homeReason;

  const bookingsHtml = await session
    .fetch(`${baseUrl}/bookinginfo`, { method: "GET", redirect: "follow" })
    .then((r) => r.text())
    .catch(() => "");
  if (bookingsHtml) debugDump("bookinginfo-after-302.html", bookingsHtml);

  return extractFlashReason(bookingsHtml);
}

/** Reasons where retrying is pointless — an account-level/business-rule block. */
const HARD_BLOCK_PATTERNS = [
  /one booking per day/i,
  /only one booking/i,
  /already initiated/i,
  /already booked/i,
  /already have (a )?booking/i,
  /pending payment/i,
  /still being processed/i,
  /still processing/i,
  /under process/i,
  /previous booking/i,
  /no longer available/i,
];

function isHardBlock(reason: string | undefined): boolean {
  return !!reason && HARD_BLOCK_PATTERNS.some((re) => re.test(reason));
}

export async function submitSummaryBlade(
  session: ApiSession,
  baseUrl: string,
  booking: BookingConfig,
  csrfToken: string,
  captcha: string,
): Promise<string> {
  const body = buildSummaryBody(booking, csrfToken, captcha);

  // At the midnight rush /summaryblade is slow and frequently 302s under load.
  // Keep re-submitting within a time budget (a re-POST is safe — a booking is
  // only committed at payment), but bail instantly on a real business block.
  const { attemptTimeoutMs, budgetMs } = rushConfig();
  const deadline = Date.now() + budgetMs;

  console.log(
    `→ POST /summaryblade (proceed to payment) — retrying up to ${Math.round(budgetMs / 1000)}s ` +
      `on 302/slow (${Math.round(attemptTimeoutMs / 1000)}s per attempt)`,
  );

  let attempt = 0;
  let lastStatus = 0;
  let lastLocation: string | null = null;
  let lastError: string | null = null;

  while (true) {
    attempt++;
    let status = 0;
    let location: string | null = null;
    let retryAfter: string | null = null;
    let html = "";
    let netError: string | null = null;

    try {
      const response = await session.fetch(`${baseUrl}/summaryblade`, {
        method: "POST",
        headers: summaryHeaders(baseUrl),
        body: body.toString(),
        signal: AbortSignal.timeout(attemptTimeoutMs),
      });
      status = response.status;
      location = response.headers.get("location");
      retryAfter = response.headers.get("retry-after");
      html = await response.text();
    } catch (error) {
      netError = describeNetworkError(error);
    }

    lastStatus = status;
    lastLocation = location;
    lastError = netError;

    if (status === 200 && html) {
      console.log(`✓ Payment form received (attempt ${attempt})`);
      return html;
    }

    // 429 = rate limited. Retrying only extends the ban (and can trigger an
    // account-level booking block), so bail immediately.
    if (status === 429) {
      const wait = retryAfter ? ` Retry after ${retryAfter}s.` : "";
      throw new Error(
        `summaryblade rate-limited (429 Too Many Attempts).${wait} ` +
          `Stop retrying and wait — repeated hammering can get the account temporarily ` +
          `blocked from booking ("selected timeslot is no longer available").`,
      );
    }

    if (status === 302 && location) {
      // Light reason check (only /home) to stay snappy during the rush.
      const reason = await fetchBookingRejectionReason(session, baseUrl, location, false).catch(
        () => undefined,
      );
      if (isHardBlock(reason)) {
        throw new Error(
          `Booking blocked by the site: "${reason}"\n` +
            `→ This is a server-side block, not a request error. If it persists across ` +
            `different dates/slots, the account is temporarily blocked (one-per-day / too many ` +
            `attempts) — wait for the cooldown (try later or the next day) or use an account ` +
            `that hasn't attempted a booking today.`,
        );
      }
      console.log(
        `⚠ summaryblade 302 → ${location}${reason ? ` ("${reason}")` : ""} — ` +
          `likely server load / lost seat; retrying (attempt ${attempt})`,
      );
    } else if (netError) {
      console.log(`⚠ summaryblade slow/failed (attempt ${attempt}): ${netError} — retrying`);
    } else {
      console.log(`⚠ summaryblade status ${status} (attempt ${attempt}) — retrying`);
    }

    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 700));
    if (Date.now() >= deadline) break;
  }

  // Out of budget — do a full (deep) reason lookup for the final message.
  const finalReason =
    lastStatus === 302 && lastLocation
      ? await fetchBookingRejectionReason(session, baseUrl, lastLocation).catch(() => undefined)
      : undefined;

  throw new Error(
    `summaryblade did not reach payment within ${Math.round(budgetMs / 1000)}s after ${attempt} ` +
      `attempts (last status ${lastStatus}${lastLocation ? `, → ${lastLocation}` : ""}` +
      `${lastError ? `, ${lastError}` : ""}${finalReason ? `, reason: "${finalReason}"` : ""}). ` +
      `The rush may be too heavy — rerun immediately.`,
  );
}

export async function prepareBookingSession(
  session: ApiSession,
  baseUrl: string,
): Promise<string> {
  return fetchCsrfToken(session, baseUrl);
}
