import type { ApiSession } from "./http.js";

function extractTokenFromHtml(html: string): string | undefined {
  const match = html.match(/name="_token"\s+value="([^"]+)"/);
  return match?.[1];
}

function extractTokenFromCookie(xsrfToken: string): string | undefined {
  try {
    const decoded = decodeURIComponent(xsrfToken);
    const json = JSON.parse(
      Buffer.from(decoded, "base64").toString("utf-8"),
    ) as { value?: string };
    return json.value;
  } catch {
    return undefined;
  }
}

export async function fetchCsrfToken(
  session: ApiSession,
  baseUrl: string,
): Promise<string> {
  const response = await session.fetch(`${baseUrl}/home`, { method: "GET" });

  if (response.status === 200) {
    const html = await response.text();
    const token = extractTokenFromHtml(html);
    if (token) return token;
  }

  const xsrf = session.getCookie("XSRF-TOKEN");
  if (xsrf) {
    const token = extractTokenFromCookie(xsrf);
    if (token) return token;
  }

  throw new Error("Could not find CSRF token after login.");
}

export function csrfHeaders(token: string): Record<string, string> {
  return {
    "X-CSRF-TOKEN": token,
    "X-Requested-With": "XMLHttpRequest",
  };
}
