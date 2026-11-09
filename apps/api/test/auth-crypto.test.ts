import { describe, expect, test } from "bun:test";
import {
  base32Decode,
  base32Encode,
  newRefreshToken,
  parseRefreshToken,
  seal,
  sha256Hex,
  signAccessToken,
  totpCode,
  unseal,
  verifyAccessToken,
  verifyTotp,
} from "../src/auth/crypto";
import { checkPasswordPolicy, generateTemporaryPassword } from "../src/auth/passwords";

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);

describe("access tokens (HS256)", () => {
  const claims = { sub: "user-1", sid: "session-1", iat: 1_000, exp: 1_900 };

  test("round-trips and checks expiry", () => {
    const token = signAccessToken(claims, KEY);
    expect(verifyAccessToken(token, KEY, 1_500)).toMatchObject({ sub: "user-1", sid: "session-1", typ: "access" });
    expect(verifyAccessToken(token, KEY, 1_900)).toBeNull();
  });

  test("rejects a wrong key, a changed payload and a token issued in the future", () => {
    const token = signAccessToken(claims, KEY);
    expect(verifyAccessToken(token, OTHER_KEY, 1_500)).toBeNull();
    const [h, , s] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims, sub: "admin", typ: "access", iss: "mms" })).toString("base64url");
    expect(verifyAccessToken(`${h}.${forged}.${s}`, KEY, 1_500)).toBeNull();
    expect(verifyAccessToken(token, KEY, 900)).toBeNull();
  });

  test("rejects alg none and malformed tokens", () => {
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ ...claims, typ: "access", iss: "mms" })).toString("base64url")}.`;
    expect(verifyAccessToken(none, KEY, 1_500)).toBeNull();
    for (const bad of ["", "a.b", "a.b.c.d", "not a token"]) expect(verifyAccessToken(bad, KEY, 1_500)).toBeNull();
  });
});

describe("refresh tokens", () => {
  test("carry the session id and a 256-bit secret; only the hash is stored", () => {
    const token = newRefreshToken("0190f0e2-aaaa-7bbb-8ccc-123456789abc");
    expect(parseRefreshToken(token)).toEqual({ sessionId: "0190f0e2-aaaa-7bbb-8ccc-123456789abc" });
    expect(token.split(".")[1]!.length).toBeGreaterThanOrEqual(43);
    expect(sha256Hex(token)).toHaveLength(64);
    expect(newRefreshToken("x")).not.toBe(newRefreshToken("x"));
    for (const bad of ["", "nodot", "not-a-uuid.abc", ".secret"]) expect(parseRefreshToken(bad)).toBeNull();
  });
});

describe("sealed secrets (AES-256-GCM)", () => {
  test("round-trip, and any change or wrong key fails", () => {
    const sealed = seal("JBSWY3DPEHPK3PXP", KEY);
    expect(sealed).not.toContain("JBSWY3DPEHPK3PXP");
    expect(unseal(sealed, KEY)).toBe("JBSWY3DPEHPK3PXP");
    expect(unseal(sealed, OTHER_KEY)).toBeNull();
    const parts = sealed.split(".");
    parts[3] = Buffer.from("tampered!").toString("base64url");
    expect(unseal(parts.join("."), KEY)).toBeNull();
    expect(seal("same", KEY)).not.toBe(seal("same", KEY));
  });
});

describe("TOTP (RFC 6238, SHA-1, 6 digits, 30 s)", () => {
  // RFC 6238 appendix B test vectors (last 6 of the 8 published digits).
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  const vectors: [number, string][] = [
    [59, "287082"],
    [1_111_111_109, "081804"],
    [1_111_111_111, "050471"],
    [1_234_567_890, "005924"],
    [2_000_000_000, "279037"],
  ];

  test("matches the RFC test vectors", () => {
    for (const [t, code] of vectors) expect(totpCode(secret, Math.floor(t / 30))).toBe(code);
  });

  test("base32 round-trips", () => {
    expect(base32Decode(secret).toString()).toBe("12345678901234567890");
    expect(base32Decode("jbsw y3dp")).toEqual(base32Decode("JBSWY3DP"));
  });

  test("accepts one step of drift, rejects older steps and replays", () => {
    const now = 1_111_111_111_000;
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(secret, totpCode(secret, step), now, null)).toBe(step);
    expect(verifyTotp(secret, totpCode(secret, step - 1), now, null)).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, step + 1), now, null)).toBe(step + 1);
    expect(verifyTotp(secret, totpCode(secret, step - 2), now, null)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, step), now, step)).toBeNull();
    expect(verifyTotp(secret, "12345", now, null)).toBeNull();
    expect(verifyTotp(secret, "abcdef", now, null)).toBeNull();
  });
});

describe("password policy", () => {
  test("needs 12 to 128 characters and must not contain the username", () => {
    expect(checkPasswordPolicy("short", "fatima")).toContain("At least 12 characters");
    expect(checkPasswordPolicy("x".repeat(129), "fatima")).toContain("At most 128 characters");
    expect(checkPasswordPolicy("my-Fatima-password", "fatima")).toContain("Must not contain the username");
    expect(checkPasswordPolicy("correct horse battery", "fatima")).toEqual([]);
  });

  test("temporary passwords pass the policy and differ each time", () => {
    const a = generateTemporaryPassword();
    expect(checkPasswordPolicy(a, "anyone")).toEqual([]);
    expect(a).not.toBe(generateTemporaryPassword());
  });
});
