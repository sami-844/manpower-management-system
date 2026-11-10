import { createHash } from "node:crypto";

/** Sign-in settings (A25, TR-SEC-01, 03, 11). Legal-free values, so they live here, not in rule_versions. */
export interface AuthConfig {
  accessKey: Buffer;
  sealKey: Buffer;
  accessTtlSec: number;
  idleSec: number;
  absoluteSec: number;
  refreshGraceSec: number;
  lockAfterFailures: number;
  lockSec: number;
  ipFailureLimit: number;
  ipWindowSec: number;
  requestsPerMinute: number;
  cookieSecure: boolean;
  issuerLabel: string;
}

export const AUTH_CONFIG = Symbol("AUTH_CONFIG");
export const REFRESH_COOKIE = "mms_refresh";
export const REFRESH_COOKIE_PATH = "/api/auth";

// Development-only keys: derived from public strings, so production refuses them by fingerprint.
const devKey = (label: string) => createHash("sha256").update(`mms-development-only-${label}`).digest();
const DEV_ACCESS_KEY = devKey("access");
const DEV_SEAL_KEY = devKey("seal");

function readKey(env: NodeJS.ProcessEnv, name: string, fallback: Buffer, production: boolean): Buffer {
  const raw = env[name];
  if (!raw) {
    if (production) throw new Error(`${name} must be set in production (base64, at least 32 bytes)`);
    return fallback;
  }
  const key = Buffer.from(raw, "base64");
  if (key.length < 32) throw new Error(`${name} must decode to at least 32 bytes`);
  if (production && key.equals(fallback)) throw new Error(`${name} is the public development key`);
  return key.subarray(0, 32);
}

function flag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be "true" or "false"`);
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const production = env.NODE_ENV === "production";
  const accessKey = readKey(env, "AUTH_ACCESS_KEY", DEV_ACCESS_KEY, production);
  const sealKey = readKey(env, "AUTH_SEAL_KEY", DEV_SEAL_KEY, production);
  if (accessKey.equals(sealKey)) throw new Error("AUTH_ACCESS_KEY and AUTH_SEAL_KEY must differ");

  // Two-factor is each user's choice in Settings (A31); the old AUTH_REQUIRE_TOTP switch is ignored.
  const cookieSecure = flag(env, "AUTH_COOKIE_SECURE", true);
  if (production && !cookieSecure) throw new Error("AUTH_COOKIE_SECURE cannot be false in production");

  return {
    accessKey,
    sealKey,
    accessTtlSec: 15 * 60,
    idleSec: 30 * 60,
    absoluteSec: 12 * 60 * 60,
    refreshGraceSec: 30,
    lockAfterFailures: 5,
    lockSec: 15 * 60,
    ipFailureLimit: 20,
    ipWindowSec: 15 * 60,
    requestsPerMinute: 600,
    cookieSecure,
    issuerLabel: env.AUTH_ISSUER_LABEL ?? "Manpower MMS",
  };
}
