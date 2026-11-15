import { describe, expect, it } from "bun:test";
import { containerEnv, deriveAuthKeys, forApi, isApiPath, MissingSecrets, type DemoSecrets } from "./config";

// The Cloudflare client demo Worker (DECISIONS A32): what it hands the API container, and what it routes there.

const secrets = {
  DATABASE_URL: "postgres://demo:pw@ep-example.eu-central-1.aws.neon.tech/neondb?sslmode=require",
  APP_SECRET: "a-long-random-string-of-at-least-32-chars",
  DEMO_PASSWORD: "four quiet harbour lamps",
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ACCESS_KEY_ID: "r2-access-key-id",
  R2_SECRET_ACCESS_KEY: "r2-secret-access-key",
  SCANS_BUCKET_NAME: "mms-demo-scans",
} satisfies DemoSecrets;
const ORIGIN = "https://manpower-management-system.example.workers.dev";

describe("deriveAuthKeys", () => {
  it("derives two different 32-byte keys from APP_SECRET, the same ones on every start", async () => {
    const a = await deriveAuthKeys(secrets.APP_SECRET);
    const b = await deriveAuthKeys(secrets.APP_SECRET);
    expect(a).toEqual(b);
    expect(a.access).not.toBe(a.seal);
    expect(Buffer.from(a.access, "base64")).toHaveLength(32);
    expect(Buffer.from(a.seal, "base64")).toHaveLength(32);
    expect((await deriveAuthKeys(`${secrets.APP_SECRET}!`)).access).not.toBe(a.access);
  });
});

describe("containerEnv", () => {
  it("runs the API as production, marked as the client demo, with S3 on R2 and same-origin cookies", async () => {
    const env = await containerEnv(secrets, ORIGIN);
    const keys = await deriveAuthKeys(secrets.APP_SECRET);
    expect(env).toEqual({
      NODE_ENV: "production",
      PORT: "3000",
      DEPLOYMENT: "cloudflare-demo",
      DATABASE_URL: secrets.DATABASE_URL,
      DEMO_PASSWORD: secrets.DEMO_PASSWORD,
      AUTH_ACCESS_KEY: keys.access,
      AUTH_SEAL_KEY: keys.seal,
      WEB_ORIGIN: ORIGIN,
      TRUST_PROXY: "1",
      FILE_STORE: "s3",
      FILE_SCANNER: "signature",
      FILE_STORE_BUCKET: "mms-demo-scans",
      S3_ENDPOINT: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
      S3_REGION: "auto",
      S3_ACCESS_KEY_ID: "r2-access-key-id",
      S3_SECRET_ACCESS_KEY: "r2-secret-access-key",
    });
  });

  it("uses R2_ENDPOINT when given (an EU-jurisdiction bucket, or a local S3 stand-in), and then needs no account ID", async () => {
    const eu = await containerEnv({ ...secrets, R2_ENDPOINT: "https://0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com" }, ORIGIN);
    expect(eu.S3_ENDPOINT).toBe("https://0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com");
    const local = await containerEnv({ ...secrets, R2_ACCOUNT_ID: undefined, R2_ENDPOINT: "http://host.docker.internal:9000" }, ORIGIN);
    expect(local.S3_ENDPOINT).toBe("http://host.docker.internal:9000");
    const bad = (await containerEnv({ ...secrets, R2_ENDPOINT: "ftp://x" }, ORIGIN).catch((e: unknown) => e)) as MissingSecrets;
    expect(bad.problems).toEqual(["R2_ENDPOINT must be an http:// or https:// address"]);
  });

  it("names every missing or unusable secret, so the deployer knows what to set", async () => {
    const err = await containerEnv({ ...secrets, DATABASE_URL: "", R2_ACCESS_KEY_ID: undefined }, ORIGIN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissingSecrets);
    expect((err as MissingSecrets).problems).toEqual(["DATABASE_URL is not set", "R2_ACCESS_KEY_ID is not set"]);
    const weak = (await containerEnv({ ...secrets, APP_SECRET: "too-short", R2_ACCOUNT_ID: "my-account" }, ORIGIN).catch((e: unknown) => e)) as MissingSecrets;
    expect(weak.problems).toEqual([
      "APP_SECRET must be at least 32 characters",
      "R2_ACCOUNT_ID must be the 32-character account ID shown on the R2 overview page",
    ]);
    // The API's password policy, checked here too, so a weak DEMO_PASSWORD is named before the container starts.
    const short = (await containerEnv({ ...secrets, DEMO_PASSWORD: "too short" }, ORIGIN).catch((e: unknown) => e)) as MissingSecrets;
    expect(short.problems).toEqual(["DEMO_PASSWORD must be 12 to 128 characters"]);
    const named = (await containerEnv({ ...secrets, DEMO_PASSWORD: "ask the HR.Officer first" }, ORIGIN).catch((e: unknown) => e)) as MissingSecrets;
    expect(named.problems).toEqual(["DEMO_PASSWORD must not contain a demo username (hr.officer)"]);
    const notPostgres =(await containerEnv({ ...secrets, DATABASE_URL: "mysql://x" }, ORIGIN).catch((e: unknown) => e)) as MissingSecrets;
    expect(notPostgres.problems).toEqual(["DATABASE_URL must be a postgres:// or postgresql:// connection string"]);
  });
});

describe("routing", () => {
  it("sends only /api and /api/... to the container", () => {
    expect(isApiPath("/api")).toBe(true);
    expect(isApiPath("/api/auth/login")).toBe(true);
    expect(isApiPath("/apis")).toBe(false);
    expect(isApiPath("/demo/api/x")).toBe(false);
    expect(isApiPath("/")).toBe(false);
  });

  it("tells the API the visitor's real address, replacing any address the visitor claimed", () => {
    const visitor = new Request(`${ORIGIN}/api/auth/login`, {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "10.0.0.1, 198.51.100.9", "content-type": "application/json" },
      body: "{}",
    });
    const forwarded = forApi(visitor);
    expect(forwarded.headers.get("x-forwarded-for")).toBe("203.0.113.7");
    expect(forwarded.headers.get("x-forwarded-proto")).toBe("https");
    expect(forwarded.headers.get("content-type")).toBe("application/json");
    expect(forwarded.method).toBe("POST");
    expect(forwarded.url).toBe(visitor.url);
  });

  it("drops a claimed address when Cloudflare gives none", () => {
    const forwarded = forApi(new Request(`${ORIGIN}/api/health`, { headers: { "x-forwarded-for": "10.0.0.1" } }));
    expect(forwarded.headers.has("x-forwarded-for")).toBe(false);
  });
});
