import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiSession } from "./http.js";

const SUREPAY_ORIGIN = "https://surepay.ndml.in";
const SUREPAY_PROCESS_URL = `${SUREPAY_ORIGIN}/SurePayPayment/sp/processRequest`;

type ParsedForm = {
  action: string;
  method: string;
  fields: URLSearchParams;
};

function debugSaveHtml(label: string, html: string): void {
  if (process.env.DEBUG_PAYMENT_HTML !== "true") return;
  const path = join(process.cwd(), `debug-${label}.html`);
  writeFileSync(path, html, "utf-8");
  console.log(`[debug] saved ${path}`);
}

function parseFormInputs(formHtml: string): URLSearchParams {
  const fields = new URLSearchParams();
  const inputPattern =
    /<input[^>]*\bname=["']([^"']+)["'][^>]*\bvalue=["']([^"']*)["'][^>]*>|<input[^>]*\bvalue=["']([^"']*)["'][^>]*\bname=["']([^"']+)["'][^>]*>/gi;

  for (const match of formHtml.matchAll(inputPattern)) {
    const name = match[1] ?? match[4];
    const value = match[2] ?? match[3] ?? "";
    if (name) fields.set(name, value);
  }

  return fields;
}

function parseHtmlForm(html: string, baseUrl: string): ParsedForm | undefined {
  const formMatch = html.match(/<form[^>]*>([\s\S]*?)<\/form>/i);
  if (!formMatch) return undefined;

  const formTag = formMatch[0];
  const actionMatch = formTag.match(/\baction=["']([^"']*)["']/i);
  const methodMatch = formTag.match(/\bmethod=["']([^"']*)["']/i);
  const action = new URL(actionMatch?.[1] || SUREPAY_PROCESS_URL, baseUrl).toString();
  const method = (methodMatch?.[1] || "POST").toUpperCase();
  const fields = parseFormInputs(formMatch[1]);

  return { action, method, fields };
}

export function parseSurepayForm(html: string): URLSearchParams {
  const form = parseHtmlForm(html, SUREPAY_ORIGIN);
  if (!form) {
    throw new Error(
      "Could not parse SurePay form from summaryblade response. Payment fields missing.",
    );
  }

  if (!form.fields.has("checksum") || !form.fields.has("orderId")) {
    throw new Error(
      "Could not parse SurePay form from summaryblade response. Payment fields missing.",
    );
  }

  return form.fields;
}

const TOKEN_FIELD_NAMES = ["token", "surePayOrderId", "paymentToken"] as const;

function hasPaymentToken(url: string): boolean {
  try {
    return new URL(url).searchParams.has("token");
  } catch {
    return url.includes("token=");
  }
}

function extractTokenFromFields(fields: URLSearchParams): string | undefined {
  for (const name of TOKEN_FIELD_NAMES) {
    const value = fields.get(name);
    if (value) return value;
  }
  return undefined;
}

function extractTokenFromHtml(html: string): string | undefined {
  for (const name of TOKEN_FIELD_NAMES) {
    const pattern = new RegExp(
      `<input[^>]*\\bname=["']${name}["'][^>]*\\bvalue=["']([^"']+)["'][^>]*>`,
      "i",
    );
    const match = html.match(pattern);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function buildPaymentUrl(token: string): string {
  return `${SUREPAY_ORIGIN}/surepay-webapp-v2/?token=${encodeURIComponent(token)}`;
}

function buildPaymentUrlFromForm(form: ParsedForm): string | undefined {
  const token = extractTokenFromFields(form.fields);
  if (!token) return undefined;

  if (form.method === "GET" && form.action.includes("surepay-webapp-v2")) {
    return buildUrlWithParams(form.action, form.fields);
  }

  return buildPaymentUrl(token);
}

function extractSurepayUrl(html: string): string | undefined {
  const patterns = [
    /surepay-webapp-v2\/?\?token=([^"'&\s<>]+)/i,
    /window\.location(?:\.href)?\s*=\s*['"]([^'"]*surepay-webapp-v2[^'"]*token=[^'"]+)['"]/i,
    /<meta[^>]+url=([^>]*surepay-webapp-v2[^>]*token=[^>]*)/i,
    /href=["']([^"']*surepay-webapp-v2[^"']*token=[^"']*)["']/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match?.[1]) continue;

    const raw = match[1].replace(/&amp;/g, "&");
    const url = raw.startsWith("http")
      ? raw
      : new URL(raw, `${SUREPAY_ORIGIN}/`).toString();

    if (hasPaymentToken(url)) return url;
  }

  const token = extractTokenFromHtml(html);
  if (token) return buildPaymentUrl(token);

  return undefined;
}

function buildUrlWithParams(base: string, params: URLSearchParams): string {
  const url = new URL(base);
  for (const [key, value] of params.entries()) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

async function submitParsedForm(
  session: ApiSession,
  form: ParsedForm,
  referer: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    Referer: referer,
    Origin: SUREPAY_ORIGIN,
  };

  if (form.method === "GET") {
    const url = buildUrlWithParams(form.action, form.fields);
    return session.fetch(url, {
      method: "GET",
      headers,
      redirect: "manual",
    });
  }

  headers["Content-Type"] = "application/x-www-form-urlencoded";

  return session.fetch(form.action, {
    method: "POST",
    headers,
    body: form.fields.toString(),
    redirect: "manual",
  });
}

async function resolvePaymentUrl(
  session: ApiSession,
  response: Response,
  referer: string,
  depth = 0,
): Promise<string | undefined> {
  if (depth > 5) return undefined;

  const location = response.headers.get("location");
  if ((response.status === 302 || response.status === 301) && location) {
    const redirectUrl = location.startsWith("http")
      ? location
      : new URL(location, SUREPAY_ORIGIN).toString();

    if (hasPaymentToken(redirectUrl)) {
      return redirectUrl;
    }

    const followResponse = await session.fetch(redirectUrl, {
      method: "GET",
      headers: { Referer: referer },
      redirect: "manual",
    });
    return resolvePaymentUrl(session, followResponse, redirectUrl, depth + 1);
  }

  const html = await response.text();
  debugSaveHtml(`surepay-response-${depth}`, html);

  const nestedForm = parseHtmlForm(html, SUREPAY_ORIGIN);
  if (nestedForm) {
    const formUrl = buildPaymentUrlFromForm(nestedForm);
    if (formUrl && nestedForm.method === "GET") {
      console.log(`→ SurePay token found in form — opening payment page`);
      return formUrl;
    }

    console.log(
      `→ Submitting SurePay intermediate form (${nestedForm.method} ${nestedForm.action})`,
    );
    const nestedResponse = await submitParsedForm(session, nestedForm, referer);
    const resolved = await resolvePaymentUrl(
      session,
      nestedResponse,
      nestedForm.action,
      depth + 1,
    );
    if (resolved) return resolved;

    if (formUrl) return formUrl;
  }

  return extractSurepayUrl(html);
}

export async function initiateSurepayPayment(
  session: ApiSession,
  summaryHtml: string,
): Promise<string> {
  debugSaveHtml("summaryblade", summaryHtml);

  const formData = parseSurepayForm(summaryHtml);

  console.log("→ POST SurePay processRequest");
  const response = await session.fetch(SUREPAY_PROCESS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: "https://aranyavihaara.karnataka.gov.in/",
      Origin: "https://aranyavihaara.karnataka.gov.in",
    },
    body: formData.toString(),
    redirect: "manual",
  });

  const paymentUrl = await resolvePaymentUrl(
    session,
    response,
    "https://aranyavihaara.karnataka.gov.in/",
  );

  if (!paymentUrl || !hasPaymentToken(paymentUrl)) {
    throw new Error(
      `SurePay initiation failed (${response.status}). Payment token missing from URL.`,
    );
  }

  console.log(`✓ SurePay URL: ${paymentUrl}`);
  return paymentUrl;
}
