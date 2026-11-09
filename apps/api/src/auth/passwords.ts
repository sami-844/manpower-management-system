import { randomInt } from "node:crypto";

/**
 * Passwords (A25, TR-SEC-01): Argon2id through Bun's built-in hasher, with the OWASP
 * minimum parameters stated explicitly rather than left to library defaults.
 * Policy follows NIST SP 800-63B: length over composition rules.
 */

const ARGON2 = { algorithm: "argon2id", memoryCost: 19_456, timeCost: 2 } as const;

export const MIN_LENGTH = 12;
export const MAX_LENGTH = 128;
export const HISTORY_DEPTH = 5;

export function checkPasswordPolicy(password: string, username: string): string[] {
  const problems: string[] = [];
  if (password.length < MIN_LENGTH) problems.push(`At least ${MIN_LENGTH} characters`);
  if (password.length > MAX_LENGTH) problems.push(`At most ${MAX_LENGTH} characters`);
  if (username.length >= 3 && password.toLowerCase().includes(username.toLowerCase())) {
    problems.push("Must not contain the username");
  }
  return problems;
}

export const hashPassword = (password: string): Promise<string> => Bun.password.hash(password, ARGON2);

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

// Verified against when the username is unknown, so "no such user" costs the same time as a wrong password.
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword("not-a-real-password-for-timing-only");
  await verifyPassword(password, await dummyHash);
}

// No look-alike characters (0/O, 1/l/I), so a temporary password survives being read out.
const TEMP_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 16 characters, about 92 bits: shown once to the admin, must be changed at first sign-in. */
export function generateTemporaryPassword(): string {
  let out = "";
  for (let i = 0; i < 16; i++) out += TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)];
  return out;
}
