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

function buildSummaryBody(booking: BookingConfig, csrfToken: string): URLSearchParams {
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

  return body;
}

function summaryHeaders(baseUrl: string): Record<string, string> {
  // The site submits summaryblade as a native form navigation, not XHR.
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: baseUrl,
    Referer: `${baseUrl}/getTimeslot`,
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
  };
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
  console.log(`→ POST /availability (district ${districtId}, ${toSiteDate(booking.date)})`);

  const body = new URLSearchParams({
    _token: csrfToken,
    district: districtId,
    trek: booking.trekId,
    check_in: toSiteDate(booking.date),
  });

  const response = await session.fetch(`${baseUrl}/availability`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${baseUrl}/`,
      ...csrfHeaders(csrfToken),
    },
    body: body.toString(),
  });

  const location = response.headers.get("location");
  const html = await response.text().catch(() => "");
  debugDump(
    "availability.html",
    `status=${response.status}\nlocation=${location}\n\n${html}`,
  );

  if (response.status === 302 && location) {
    const followUrl = new URL(location, baseUrl).toString();
    if (/\/(home|login)(\/|$|\?)/.test(new URL(followUrl).pathname)) {
      throw new Error(
        `availability redirected to ${followUrl} — date/district likely rejected.`,
      );
    }
    await session.fetch(followUrl, { method: "GET", redirect: "follow" });
  } else if (response.status !== 200) {
    throw new Error(
      `availability failed with status ${response.status} (location=${location}).`,
    );
  }

  console.log("✓ Availability selected (date stored in session)");
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
  const response = await session.fetch(`${baseUrl}/getTimeslot`, {
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
  const response = await session.fetch(`${baseUrl}/summary-generate-otp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Referer: `${baseUrl}/getTimeslot`,
      ...csrfHeaders(csrfToken),
    },
    body: JSON.stringify({ mobile_no: mobile, purpose: "booking" }),
  });

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
  const response = await session.fetch(`${baseUrl}/summary-verify-otp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Referer: `${baseUrl}/getTimeslot`,
      ...csrfHeaders(csrfToken),
    },
    body: JSON.stringify({ otp, mobile_no: mobile }),
  });

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

async function fetchWithRetry(
  label: string,
  attempts: number,
  request: () => Promise<Response>,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await request();
    } catch (error) {
      lastError = error;
      console.log(
        `⚠ ${label} network error (attempt ${attempt}/${attempts}): ${describeNetworkError(error)}`,
      );
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      }
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${describeNetworkError(lastError)}`);
}

/** Pull the user-facing flash/alert message the site renders on /home. */
function extractFlashReason(html: string): string | undefined {
  const alert = [
    ...html.matchAll(/<div[^>]*class="[^"]*alert[^"]*"[^>]*>([\s\S]*?)<\/div>/gi),
  ]
    .map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .find((t) => t.length > 0 && t.length < 200);
  if (alert) return alert;

  const notifyBlock = html.match(
    /<div[^>]*id="laravel-notify"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
  )?.[1];
  return notifyBlock?.match(/"message"\s*:\s*"([^"]*)"/)?.[1];
}

export async function submitSummaryBlade(
  session: ApiSession,
  baseUrl: string,
  booking: BookingConfig,
  csrfToken: string,
): Promise<string> {
  console.log("→ POST /summaryblade (proceed to payment)");
  const body = buildSummaryBody(booking, csrfToken);

  let status = 0;
  let location: string | null = null;
  let networkError: string | null = null;
  let html = "";
  try {
    const response = await fetchWithRetry("summaryblade", 2, () =>
      session.fetch(`${baseUrl}/summaryblade`, {
        method: "POST",
        headers: summaryHeaders(baseUrl),
        body: body.toString(),
      }),
    );
    status = response.status;
    location = response.headers.get("location");
    html = await response.text();
  } catch (error) {
    networkError = describeNetworkError(error);
  }

  if (status === 200 && html) {
    console.log("✓ Payment form received");
    return html;
  }

  // A 302 → /home means the server rejected the booking with a flashed reason
  // (e.g. the "only one booking per day per account" rule). Surface it.
  if (status === 302 && location) {
    const reason = await session
      .fetch(new URL(location, baseUrl).toString(), { method: "GET", redirect: "follow" })
      .then((r) => r.text())
      .then(extractFlashReason)
      .catch(() => undefined);

    if (reason) {
      throw new Error(
        `Booking blocked by the site: "${reason}"\n` +
          `→ Complete or cancel the pending booking (My Bookings / payment-status), or try again the next day.`,
      );
    }
  }

  throw new Error(
    `summaryblade failed (status ${status}${location ? `, → ${location}` : ""}${networkError ? `, ${networkError}` : ""}).`,
  );
}

export async function prepareBookingSession(
  session: ApiSession,
  baseUrl: string,
): Promise<string> {
  return fetchCsrfToken(session, baseUrl);
}
