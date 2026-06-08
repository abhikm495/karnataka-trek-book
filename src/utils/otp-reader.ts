import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promptUser } from "./prompt.js";

const execFileAsync = promisify(execFile);

export type OtpMode = "manual" | "adb" | "webhook";

export type OtpReaderConfig = {
  mode: OtpMode;
  webhookPort: number;
  timeoutMs: number;
};

const DEFAULT_OTP_PATTERN = /\b(\d{6})\b/;
const KFDTRK_OTP_PATTERN = /\bis\s+(\d{6})\b/i;
const KFDTRK_SMS_HINT = /KFDTRK|Forest Ecotourism/i;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseOtpMode(value: string | undefined): OtpMode {
  if (!value || value === "manual") return "manual";
  if (value === "adb" || value === "webhook") return value;
  throw new Error(`Invalid OTP_MODE "${value}". Use manual, adb, or webhook.`);
}

export function loadOtpReaderConfig(): OtpReaderConfig {
  const timeoutRaw = process.env.OTP_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : 120_000;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("OTP_TIMEOUT_MS must be a positive number.");
  }

  return {
    mode: parseOtpMode(process.env.OTP_MODE),
    webhookPort: Number(process.env.OTP_WEBHOOK_PORT ?? "3847"),
    timeoutMs,
  };
}

function extractOtpFromText(text: string, kfdtrkOnly = false): string | undefined {
  if (kfdtrkOnly && !KFDTRK_SMS_HINT.test(text)) {
    return undefined;
  }

  const kfdMatch = text.match(KFDTRK_OTP_PATTERN);
  if (kfdMatch?.[1]) return kfdMatch[1];

  const genericMatch = text.match(DEFAULT_OTP_PATTERN);
  return genericMatch?.[1];
}

async function waitForManualOtp(): Promise<string> {
  const otp = await promptUser("Enter OTP: ");
  if (!otp) throw new Error("OTP is required.");
  return otp;
}

async function ensureAdbDevice(): Promise<void> {
  const { stdout } = await execFileAsync("adb", ["devices"]);
  const lines = stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const connected = lines.some((line) => line.endsWith("device"));
  if (!connected) {
    throw new Error(
      "No Android device found via adb. Enable USB debugging and run `adb devices`.",
    );
  }
}

function parseAdbSmsRows(stdout: string): Array<{ body: string; date: number }> {
  const rows: Array<{ body: string; date: number }> = [];

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("Row:")) continue;

    const dateParts = trimmed.split(", date=");
    if (dateParts.length < 2) continue;

    const date = Number(dateParts[dateParts.length - 1].trim());
    if (!Number.isFinite(date)) continue;

    const bodyMatch = dateParts[0].match(/Row:\s*\d+\s+body=(.*)$/);
    if (!bodyMatch?.[1]) continue;

    rows.push({ body: bodyMatch[1], date });
  }

  return rows;
}

async function querySmsInbox(): Promise<string> {
  const { stdout } = await execFileAsync("adb", [
    "shell",
    "content query --uri content://sms/inbox --projection body,date",
  ]);
  return stdout;
}

async function readLatestOtpFromAdb(sinceMs: number): Promise<string | undefined> {
  const stdout = await querySmsInbox();
  const rows = parseAdbSmsRows(stdout);

  if (process.env.DEBUG_OTP === "true") {
    console.log(`[debug] parsed ${rows.length} SMS rows`);
  }

  for (const row of rows) {
    if (row.date < sinceMs) continue;

    const otp = extractOtpFromText(row.body, true);
    if (otp) return otp;
  }

  return undefined;
}

async function waitForAdbOtp(timeoutMs: number): Promise<string> {
  await ensureAdbDevice();
  const sinceMs = Date.now() - 10_000;
  const deadline = Date.now() + timeoutMs;

  console.log("→ Waiting for OTP via adb (KFDTRK SMS on phone)...");

  while (Date.now() < deadline) {
    try {
      const otp = await readLatestOtpFromAdb(sinceMs);
      if (otp) {
        console.log(`✓ OTP received from phone: ${otp}`);
        return otp;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (process.env.DEBUG_OTP === "true") {
        console.log(`[debug] adb read error: ${message}`);
      }
    }

    await sleep(2_000);
  }

  throw new Error(
    "Timed out waiting for KFDTRK OTP SMS via adb. Check USB debugging (Security settings) on Poco.",
  );
}

function parseWebhookBody(
  body: string,
  contentType: string | undefined,
): string | undefined {
  const trimmed = body.trim();
  if (!trimmed) return undefined;

  if (contentType?.includes("application/json")) {
    try {
      const json = JSON.parse(trimmed) as {
        otp?: string;
        message?: string;
        body?: string;
        text?: string;
      };
      const candidate =
        json.otp ?? json.message ?? json.body ?? json.text ?? trimmed;
      return extractOtpFromText(candidate, true) ?? extractOtpFromText(trimmed);
    } catch {
      return extractOtpFromText(trimmed);
    }
  }

  return extractOtpFromText(trimmed, true) ?? extractOtpFromText(trimmed);
}

async function waitForWebhookOtp(port: number, timeoutMs: number): Promise<string> {
  console.log(`→ Waiting for OTP webhook on http://127.0.0.1:${port}/otp`);

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

      if (req.method === "GET" && url.pathname === "/otp") {
        const fromQuery = url.searchParams.get("otp") ?? url.searchParams.get("body");
        const otp = fromQuery ? extractOtpFromText(fromQuery) ?? fromQuery : undefined;

        if (otp && DEFAULT_OTP_PATTERN.test(otp)) {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("ok");
          server.close();
          console.log(`✓ OTP received via webhook: ${otp}`);
          resolve(otp);
          return;
        }
      }

      if (req.method === "POST" && url.pathname === "/otp") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          const otp = parseWebhookBody(body, req.headers["content-type"]);

          if (otp) {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("ok");
            server.close();
            console.log(`✓ OTP received via webhook: ${otp}`);
            resolve(otp);
            return;
          }

          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("no otp found");
        });
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    });

    server.listen(port, "127.0.0.1");

    server.on("error", (error) => {
      server.close();
      reject(error);
    });

    setTimeout(() => {
      server.close();
      reject(
        new Error(
          `Timed out waiting for OTP webhook on port ${port}. Forward SMS to http://127.0.0.1:${port}/otp`,
        ),
      );
    }, timeoutMs);
  });
}

export async function waitForOtp(config: OtpReaderConfig): Promise<string> {
  switch (config.mode) {
    case "adb":
      return waitForAdbOtp(config.timeoutMs);
    case "webhook":
      return waitForWebhookOtp(config.webhookPort, config.timeoutMs);
    case "manual":
      return waitForManualOtp();
  }
}
