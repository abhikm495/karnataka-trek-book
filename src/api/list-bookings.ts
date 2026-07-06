import { mkdirSync, writeFileSync } from "node:fs";
import { loadAppConfig } from "../config.js";
import { apiLogin } from "./login.js";

function dump(name: string, content: string): void {
  mkdirSync("debug", { recursive: true });
  writeFileSync(`debug/${name}`, content, "utf-8");
}

function summarize(label: string, html: string): void {
  const count = (re: RegExp) => (html.match(re) || []).length;
  const processing = /previous booking is still being processed/i.test(html);
  console.log(`\n── ${label} ──`);
  console.log(`  length            : ${html.length}`);
  console.log(`  "still processing": ${processing ? "YES ⚠" : "no"}`);
  console.log(`  initiated/pending : ${count(/initiat/gi)} / ${count(/pending/gi)}`);
  console.log(`  processing/success: ${count(/process/gi)} / ${count(/success/gi)}`);
  console.log(`  confirmed/failed  : ${count(/confirm/gi)} / ${count(/fail/gi)}`);
}

async function main(): Promise<void> {
  const appConfig = loadAppConfig();
  const { session } = await apiLogin(appConfig);

  const pages = ["/home", "/payment-status", "/bookinginfo", "/completedtreks"];
  for (const path of pages) {
    const html = await session
      .fetch(`${appConfig.baseUrl}${path}`, { method: "GET", redirect: "follow" })
      .then((r) => r.text())
      .catch((e: unknown) => `ERROR: ${e instanceof Error ? e.message : String(e)}`);
    const file = `bookings${path.replace(/\//g, "-") || "-root"}.html`;
    dump(file, html);
    summarize(path, html);
    console.log(`  saved → debug/${file}`);
  }

  console.log(
    "\nIf any page shows a pending/initiated/processing booking, wait for it to " +
      "clear (decline the UPI collect or let it time out) before booking again.",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n✗ Failed to list bookings: ${message}`);
  process.exit(1);
});
