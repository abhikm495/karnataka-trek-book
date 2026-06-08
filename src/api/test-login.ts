import { loadAppConfig } from "../config.js";
import { apiLogin } from "./login.js";

async function main(): Promise<void> {
  const config = loadAppConfig();

  console.log("\nAPI Login Test\n");

  const { session, redirectUrl } = await apiLogin(config);

  console.log("\n--- Session cookies ---");
  const cookieNames = session.getCookieNames();
  console.log(cookieNames.length ? cookieNames.join(", ") : "none");
  if (session.getXsrfToken()) {
    console.log("XSRF token decoded: present");
  }

  console.log("\n→ Verifying session with GET /home");
  const homeResponse = await session.fetch(`${config.baseUrl}/home`, {
    method: "GET",
  });

  if (homeResponse.status === 302) {
    const location = homeResponse.headers.get("location") ?? "";
    throw new Error(
      `Session verification failed. /home redirected to ${location}`,
    );
  }

  const homeHtml = await homeResponse.text();
  const loggedIn =
    homeResponse.status === 200 &&
    !homeHtml.includes('name="email"') &&
    !homeHtml.includes("/post-login");

  if (loggedIn) {
    console.log("✓ Session verified — /home loaded as authenticated user");
    console.log(`Redirect after login: ${redirectUrl}`);
    return;
  }

  throw new Error(`Session verification failed. /home returned ${homeResponse.status}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n✗ API login test failed: ${message}`);
  process.exit(1);
});
