import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The small, dependency-free crypto the identity service needs (A25): HS256 access tokens,
 * opaque refresh tokens, AES-256-GCM sealing for TOTP secrets, and RFC 6238 TOTP.
 * Everything here is pure: keys and time are passed in.
 */

export const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Constant-time comparison of two strings of possibly different length. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------------------------------------------------------------------------------------------
// Access tokens: compact JWS, HS256 only. The header is fixed, so "alg: none" or RS/HS confusion
// cannot be smuggled in: anything but our exact header is rejected before the signature check.
// ---------------------------------------------------------------------------------------------

const ISSUER = "mms";
const HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");

export interface AccessClaims {
  sub: string; // user id
  sid: string; // session id (user_sessions.id)
  iat: number; // seconds
  exp: number; // seconds
  typ: "access";
  iss: typeof ISSUER;
}

export function signAccessToken(claims: Pick<AccessClaims, "sub" | "sid" | "iat" | "exp">, key: Buffer): string {
  const payload = Buffer.from(JSON.stringify({ ...claims, typ: "access", iss: ISSUER })).toString("base64url");
  const signature = createHmac("sha256", key).update(`${HEADER}.${payload}`).digest("base64url");
  return `${HEADER}.${payload}.${signature}`;
}

/** The claims if the token is ours, unexpired and not issued in the future (60 s skew); otherwise null. */
export function verifyAccessToken(token: string, key: Buffer, nowSec: number): AccessClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  if (header !== HEADER) return null;
  const expected = createHmac("sha256", key).update(`${header}.${payload}`).digest("base64url");
  if (!safeEqual(signature, expected)) return null;
  let claims: Partial<AccessClaims>;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (claims.typ !== "access" || claims.iss !== ISSUER) return null;
  if (typeof claims.sub !== "string" || typeof claims.sid !== "string") return null;
  if (typeof claims.exp !== "number" || typeof claims.iat !== "number") return null;
  if (nowSec >= claims.exp || claims.iat > nowSec + 60) return null;
  return claims as AccessClaims;
}

// ---------------------------------------------------------------------------------------------
// Refresh tokens: "<session id>.<256 random bits>". Only sha256Hex(token) is stored.
// ---------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const newRefreshToken = (sessionId: string): string => `${sessionId}.${randomBytes(32).toString("base64url")}`;

export function parseRefreshToken(token: string): { sessionId: string } | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const sessionId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!UUID.test(sessionId) || secret.length < 43) return null;
  return { sessionId };
}

// ---------------------------------------------------------------------------------------------
// Sealing: AES-256-GCM, "v1.<iv>.<tag>.<ciphertext>" in base64url. A changed byte fails to open.
// ---------------------------------------------------------------------------------------------

export function seal(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function unseal(sealed: string, key: Buffer): string | null {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || !body) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// TOTP (RFC 6238 / RFC 4226): HMAC-SHA1, 6 digits, 30-second steps, ±1 step of drift.
// SHA-1 and 6 digits because every authenticator app supports exactly that.
// ---------------------------------------------------------------------------------------------

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_MS = 30_000;

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const index = ALPHABET.indexOf(ch);
    if (index < 0) throw new Error("Invalid base32 character");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32-encoded, as authenticator apps expect. */
export const newTotpSecret = (): string => base32Encode(randomBytes(20));

export function totpCode(secretBase32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", base32Decode(secretBase32)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return binary.toString().padStart(6, "0");
}

/**
 * The step the code belongs to, or null. A step at or before `lastUsedStep` is refused,
 * so each code works once (the caller stores the returned step).
 */
export function verifyTotp(secretBase32: string, code: string, nowMs: number, lastUsedStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(nowMs / STEP_MS);
  for (const step of [current - 1, current, current + 1]) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    if (safeEqual(totpCode(secretBase32, step), code)) return step;
  }
  return null;
}

export function otpauthUrl(issuer: string, account: string, secretBase32: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${params.toString()}`;
}
