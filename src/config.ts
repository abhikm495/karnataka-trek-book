import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import type { AppConfig, BookingConfig, Member, TestMode } from "./types.js";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function parseTestMode(value: string | undefined): TestMode {
  if (!value || value === "dry-run") return "dry-run";
  if (value === "fail-pay" || value === "live") return value;
  throw new Error(`Invalid TEST_MODE "${value}". Use dry-run, fail-pay, or live.`);
}

function parseMembers(raw: string): Member[] {
  let members: Member[];
  try {
    members = JSON.parse(raw) as Member[];
  } catch {
    throw new Error(
      'Invalid MEMBERS in .env — must be a JSON array. Example: [{"name":"...","age":23,"gender":"Male","idType":"Pancard","idNumber":"...","mobile":"..."}]',
    );
  }

  if (!Array.isArray(members) || members.length === 0) {
    throw new Error("MEMBERS must include at least one visitor.");
  }

  if (members.length > 3) {
    throw new Error("Aranya Vihaara allows up to 3 members per booking.");
  }

  return members;
}

export function loadBookingConfig(): BookingConfig {
  return {
    district: optionalEnv("DISTRICT"),
    districtId: optionalEnv("DISTRICT_ID"),
    trek: optionalEnv("TREK"),
    trekId: requireEnv("TREK_ID"),
    date: requireEnv("DATE"),
    timeSlot: optionalEnv("TIME_SLOT"),
    timeSlotId: requireEnv("TIME_SLOT_ID"),
    timeSlotMappingId: requireEnv("TIME_SLOT_MAPPING_ID"),
    upiVpa: requireEnv("UPI_VPA"),
    members: parseMembers(requireEnv("MEMBERS")),
  };
}

export function loadAppConfig(): AppConfig {
  return {
    email: requireEnv("EMAIL"),
    password: requireEnv("PASSWORD"),
    testMode: parseTestMode(process.env.TEST_MODE),
    baseUrl: process.env.BASE_URL ?? "https://aranyavihaara.karnataka.gov.in",
    authPath: join(rootDir, "auth", "auth.json"),
  };
}
