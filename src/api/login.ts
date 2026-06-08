import type { AppConfig } from "../types.js";
import { generateCaptcha } from "./captcha.js";
import { ApiSession } from "./http.js";

export type LoginPageData = {
  csrfToken: string;
  captcha: string;
  html: string;
};

export type ApiLoginResult = {
  session: ApiSession;
  redirectUrl: string;
};

function extractCsrfToken(html: string): string {
  const csrfMatch = html.match(/name="_token"\s+value="([^"]+)"/);
  if (!csrfMatch?.[1]) {
    throw new Error("Could not find CSRF _token on login page.");
  }
  return csrfMatch[1];
}

function resolveRedirectUrl(baseUrl: string, location: string | null): string {
  if (!location) {
    throw new Error("Login response missing redirect Location header.");
  }
  return new URL(location, baseUrl).toString();
}

function isSuccessfulLoginRedirect(redirectUrl: string): boolean {
  const path = new URL(redirectUrl).pathname;
  return !path.includes("/login");
}

function extractLoginError(html: string): string | undefined {
  const patterns = [
    /<div[^>]*class="[^"]*alert[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<span[^>]*id="key"[^>]*>([\s\S]*?)<\/span>/i,
    /<div[^>]*class="[^"]*valid_color[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="[^"]*error[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    const text = match?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (text) return text;
  }

  return undefined;
}

function parseForceLoginForm(
  html: string,
  baseUrl: string,
): { action: string; body: URLSearchParams } | undefined {
  const formMatch = html.match(
    /<form[^>]*id="forceLoginForm"[^>]*>([\s\S]*?)<\/form>/i,
  );
  if (!formMatch) return undefined;

  const actionMatch = formMatch[0].match(/action="([^"]*)"/i);
  const action = new URL(actionMatch?.[1] || "/post-login", baseUrl).toString();
  const body = new URLSearchParams();

  const inputPattern =
    /<input[^>]+name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/gi;

  for (const match of formMatch[1].matchAll(inputPattern)) {
    body.set(match[1], match[2]);
  }

  if (!body.has("_token")) return undefined;
  return { action, body };
}

function hasSessionConflict(html: string): boolean {
  return (
    html.includes("Session Already Active") ||
    html.includes('id="forceLoginForm"')
  );
}

function loginPostHeaders(
  config: AppConfig,
  csrfToken: string,
  session: ApiSession,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: config.baseUrl,
    Referer: `${config.baseUrl}/login`,
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
  };

  const xsrf = session.getXsrfToken() ?? csrfToken;
  headers["X-XSRF-TOKEN"] = xsrf;

  return headers;
}

function debugLog(session: ApiSession, message: string): void {
  if (process.env.DEBUG_API_LOGIN === "true") {
    console.log(`[debug] ${message}`);
    console.log(`[debug] cookies: ${session.getCookieNames().join(", ") || "none"}`);
  }
}

async function submitLogin(
  session: ApiSession,
  config: AppConfig,
  csrfToken: string,
  captcha: string,
): Promise<Response> {
  const body = new URLSearchParams({
    _token: csrfToken,
    email: config.email,
    password: config.password,
    captcha,
  });

  return session.fetch(`${config.baseUrl}/post-login`, {
    method: "POST",
    headers: loginPostHeaders(config, csrfToken, session),
    body: body.toString(),
  });
}

async function submitForceLogin(
  session: ApiSession,
  config: AppConfig,
  html: string,
): Promise<Response | undefined> {
  const form = parseForceLoginForm(html, config.baseUrl);
  if (!form) return undefined;

  console.log('→ Session conflict detected — forcing login via "Login Here"...');

  const csrfToken = form.body.get("_token") ?? "";
  return session.fetch(form.action, {
    method: "POST",
    headers: loginPostHeaders(config, csrfToken, session),
    body: form.body.toString(),
  });
}

async function handleLoginResponse(
  session: ApiSession,
  config: AppConfig,
  response: Response,
): Promise<ApiLoginResult> {
  if (response.status === 302) {
    const redirectUrl = resolveRedirectUrl(
      config.baseUrl,
      response.headers.get("location"),
    );

    if (isSuccessfulLoginRedirect(redirectUrl)) {
      console.log(`✓ Login successful → ${redirectUrl}`);
      return { session, redirectUrl };
    }

    const loginPage = await session.fetch(`${config.baseUrl}/login`, {
      method: "GET",
      redirect: "follow",
    });
    const loginHtml = await loginPage.text();

    if (hasSessionConflict(loginHtml)) {
      const forceResponse = await submitForceLogin(session, config, loginHtml);
      if (forceResponse) {
        return handleLoginResponse(session, config, forceResponse);
      }
    }

    const error = extractLoginError(loginHtml);
    throw new Error(
      error
        ? `Login failed: ${error}`
        : `Login failed — redirected back to ${redirectUrl}. Check credentials or close other active sessions.`,
    );
  }

  const responseText = await response.text();

  if (responseText.includes("Session Already Active")) {
    const forceResponse = await submitForceLogin(session, config, responseText);
    if (forceResponse) {
      return handleLoginResponse(session, config, forceResponse);
    }
  }

  const error = extractLoginError(responseText);
  if (error) {
    throw new Error(`Login failed: ${error}`);
  }

  throw new Error(
    `Login failed with status ${response.status}. Check credentials or CAPTCHA.`,
  );
}

export async function fetchLoginPage(
  session: ApiSession,
  baseUrl: string,
): Promise<LoginPageData> {
  let response: Response;
  try {
    response = await session.fetch(`${baseUrl}/login`, {
      method: "GET",
      redirect: "follow",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`GET /login network error: ${message}`);
  }

  if (response.status !== 200) {
    throw new Error(
      `GET /login failed with status ${response.status}. The server may be blocking this IP.`,
    );
  }

  const html = await response.text();
  const csrfToken = extractCsrfToken(html);
  const captcha = generateCaptcha();

  return { csrfToken, captcha, html };
}

export async function apiLogin(config: AppConfig): Promise<ApiLoginResult> {
  const session = new ApiSession();

  console.log("→ GET /login");
  const { csrfToken, captcha } = await fetchLoginPage(session, config.baseUrl);
  debugLog(session, "login page loaded");
  console.log("→ CSRF token found");
  console.log(`→ CAPTCHA generated: ${captcha}`);

  console.log("→ POST /post-login");
  const response = await submitLogin(session, config, csrfToken, captcha);
  return handleLoginResponse(session, config, response);
}
