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

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid JSON response (${response.status}): ${text.slice(0, 200)}`);
  }
}

export async function selectTimeslot(
  session: ApiSession,
  baseUrl: string,
  booking: BookingConfig,
  csrfToken: string,
): Promise<void> {
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

  console.log("✓ Visitor booking page loaded");
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
      Referer: `${baseUrl}/`,
      ...csrfHeaders(csrfToken),
    },
    body: JSON.stringify({ mobile_no: mobile, purpose: "booking" }),
  });

  const result = await parseJsonResponse<OtpResponse>(response);
  if (!result.success) {
    throw new Error("Failed to generate OTP.");
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
      Referer: `${baseUrl}/`,
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

export async function submitSummaryBlade(
  session: ApiSession,
  baseUrl: string,
  booking: BookingConfig,
  csrfToken: string,
): Promise<string> {
  console.log("→ POST /summaryblade (proceed to payment)");
  const response = await session.fetch(`${baseUrl}/summaryblade`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${baseUrl}/`,
      ...csrfHeaders(csrfToken),
    },
    body: buildSummaryBody(booking, csrfToken).toString(),
  });

  if (response.status !== 200) {
    throw new Error(`summaryblade failed with status ${response.status}`);
  }

  const html = await response.text();
  if (!html) {
    throw new Error("summaryblade returned an empty response.");
  }

  console.log("✓ Payment form received");
  return html;
}

export async function prepareBookingSession(
  session: ApiSession,
  baseUrl: string,
): Promise<string> {
  return fetchCsrfToken(session, baseUrl);
}
