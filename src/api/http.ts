const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

function readSetCookies(response: Response): string[] {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }

  const raw = response.headers.get("set-cookie");
  return raw ? [raw] : [];
}

export class ApiSession {
  private readonly cookies = new Map<string, string>();

  storeCookies(response: Response): void {
    for (const raw of readSetCookies(response)) {
      const [pair] = raw.split(";");
      const [name, ...valueParts] = pair.split("=");
      if (name && valueParts.length > 0) {
        this.cookies.set(name.trim(), valueParts.join("=").trim());
      }
    }
  }

  cookieHeader(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  getCookie(name: string): string | undefined {
    return this.cookies.get(name);
  }

  getCookieNames(): string[] {
    return [...this.cookies.keys()];
  }

  getXsrfToken(): string | undefined {
    const xsrf = this.getCookie("XSRF-TOKEN");
    if (!xsrf) return undefined;

    try {
      const decoded = decodeURIComponent(xsrf);
      const json = JSON.parse(
        Buffer.from(decoded, "base64").toString("utf-8"),
      ) as { value?: string };
      return json.value;
    } catch {
      return xsrf;
    }
  }

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers ?? {});
    const cookie = this.cookieHeader();

    for (const [key, value] of Object.entries(DEFAULT_HEADERS)) {
      if (!headers.has(key)) headers.set(key, value);
    }

    if (cookie) headers.set("Cookie", cookie);

    const response = await fetch(url, {
      ...init,
      headers,
      redirect: init.redirect ?? "manual",
    });

    this.storeCookies(response);
    return response;
  }
}
