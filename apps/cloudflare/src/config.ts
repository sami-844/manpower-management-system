/**
 * What the Cloudflare client demo Worker (DECISIONS A32) hands the API container, and which requests
 * it routes there. No Cloudflare imports, so `bun test` covers it.
 */

/** The secrets the Deploy to Cloudflare button asks for (`.dev.vars.example`), plus the bucket name var. */
export interface DemoSecrets {
  DATABASE_URL?: string;
  APP_SECRET?: string;
  DEMO_PASSWORD?: string;
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  /** Optional: the S3 address of the bucket when it isn't `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` (an EU-jurisdiction bucket, or a local S3 stand-in for testing). */
  R2_ENDPOINT?: string;
  SCANS_BUCKET_NAME?: string;
}

const REQUIRED = ["DATABASE_URL", "APP_SECRET", "DEMO_PASSWORD", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "SCANS_BUCKET_NAME"] as const;

/**
 * The API's own rule for the shared demo password (apps/api/src/auth/passwords.ts, accounts.ts DEMO_USERS),
 * repeated here so a weak one is named before a container starts and exits. An API test keeps the two equal.
 */
export const DEMO_USERNAMES = ["owner", "ops.manager", "hr.officer", "payroll.officer", "finance.officer", "admin"] as const;
export const DEMO_PASSWORD_LENGTH = { min: 12, max: 128 } as const;

export class MissingSecrets extends Error {
  constructor(readonly problems: string[]) {
    super(`The client demo is not set up: ${problems.join("; ")}`);
  }
}

/**
 * The API needs two different 32-byte keys (token signing and secret sealing, A25). Deriving both
 * from one APP_SECRET with HKDF means the deployer types one random string, not two base64 keys.
 */
export async function deriveAuthKeys(appSecret: string): Promise<{ access: string; seal: string }> {
  const ikm = await crypto.subtle.importKey("raw", new TextEncoder().encode(appSecret), "HKDF", false, ["deriveBits"]);
  const derive = async (info: string) => {
    const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("mms-client-demo"), info: new TextEncoder().encode(info) },
      ikm,
      256,
    );
    return btoa(String.fromCharCode(...new Uint8Array(bits)));
  };
  return { access: await derive("auth-access-key"), seal: await derive("auth-seal-key") };
}

/** The container's environment. Throws MissingSecrets naming every problem at once. */
export async function containerEnv(s: DemoSecrets, origin: string): Promise<Record<string, string>> {
  // An explicit R2_ENDPOINT already says where the bucket is; the account ID only builds the default address.
  const needed = s.R2_ENDPOINT ? REQUIRED.filter((k) => k !== "R2_ACCOUNT_ID") : REQUIRED;
  const problems: string[] = needed.filter((k) => !s[k]).map((k) => `${k} is not set`);
  if (s.R2_ENDPOINT && !/^https?:\/\//.test(s.R2_ENDPOINT)) problems.push("R2_ENDPOINT must be an http:// or https:// address");
  if (s.DATABASE_URL && !/^postgres(ql)?:\/\//.test(s.DATABASE_URL)) problems.push("DATABASE_URL must be a postgres:// or postgresql:// connection string");
  if (s.APP_SECRET && s.APP_SECRET.length < 32) problems.push("APP_SECRET must be at least 32 characters");
  if (s.DEMO_PASSWORD) {
    const { min, max } = DEMO_PASSWORD_LENGTH;
    if (s.DEMO_PASSWORD.length < min || s.DEMO_PASSWORD.length > max) problems.push(`DEMO_PASSWORD must be ${min} to ${max} characters`);
    const named = DEMO_USERNAMES.filter((u) => s.DEMO_PASSWORD!.toLowerCase().includes(u));
    if (named.length) problems.push(`DEMO_PASSWORD must not contain a demo username (${named.join(", ")})`);
  }
  if (s.R2_ACCOUNT_ID && !/^[0-9a-f]{32}$/i.test(s.R2_ACCOUNT_ID)) {
    problems.push("R2_ACCOUNT_ID must be the 32-character account ID shown on the R2 overview page");
  }
  if (problems.length) throw new MissingSecrets(problems);
  const keys = await deriveAuthKeys(s.APP_SECRET!);
  return {
    NODE_ENV: "production",
    PORT: "3000",
    // Must equal CLIENT_DEMO in apps/api/src/files/files.ts: it allows the test scanner and the demo start-up.
    DEPLOYMENT: "cloudflare-demo",
    DATABASE_URL: s.DATABASE_URL!,
    DEMO_PASSWORD: s.DEMO_PASSWORD!,
    AUTH_ACCESS_KEY: keys.access,
    AUTH_SEAL_KEY: keys.seal,
    // The web app and the API share one origin here; CORS only ever matters for this one.
    WEB_ORIGIN: origin,
    // The Worker is the one proxy in front of the API: req.ip is then the visitor (lockout, per-network limit).
    TRUST_PROXY: "1",
    FILE_STORE: "s3",
    FILE_SCANNER: "signature",
    FILE_STORE_BUCKET: s.SCANS_BUCKET_NAME!,
    // Bun's S3 client reads these (R2 speaks the S3 API).
    S3_ENDPOINT: s.R2_ENDPOINT || `https://${s.R2_ACCOUNT_ID!.toLowerCase()}.r2.cloudflarestorage.com`,
    S3_REGION: "auto",
    S3_ACCESS_KEY_ID: s.R2_ACCESS_KEY_ID!,
    S3_SECRET_ACCESS_KEY: s.R2_SECRET_ACCESS_KEY!,
  };
}

export const isApiPath = (pathname: string): boolean => pathname === "/api" || pathname.startsWith("/api/");

/**
 * The request as the API should see it: the visitor's address from Cloudflare (CF-Connecting-IP),
 * never one the visitor wrote into X-Forwarded-For themselves.
 */
export function forApi(request: Request): Request {
  const headers = new Headers(request.headers);
  const visitor = request.headers.get("cf-connecting-ip");
  if (visitor) headers.set("x-forwarded-for", visitor);
  else headers.delete("x-forwarded-for");
  headers.set("x-forwarded-proto", "https");
  return new Request(request, { headers });
}
