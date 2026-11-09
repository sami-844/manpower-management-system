import { createHmac } from "node:crypto";
import { expect, type Page, type TestInfo } from "@playwright/test";

/**
 * Sign in through the real screen (S-01): username, password, then a live authenticator code.
 * Accounts come from `bun run --filter @mms/api e2e:accounts` (one per Playwright project).
 * Each code works once, so a second sign-in in the same 30 s waits for the next code.
 */
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-only-password-not-a-secret";
const SECRET = process.env.E2E_TOTP_SECRET ?? "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

function base32(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.replace(/=+$/, "")) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totp(step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", base32(SECRET)).update(counter).digest();
  const o = h[h.length - 1]! & 0x0f;
  return ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

const lastStep = new Map<string, number>();

export async function signIn(page: Page, testInfo: TestInfo): Promise<void> {
  const username = `e2e.hr.${testInfo.project.name}`;
  await page.goto("/#/sign-in");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByLabel("Authenticator code")).toBeVisible();

  // The code is taken at the moment it is typed; a step this account already used is skipped.
  let step = Math.floor(Date.now() / 30_000);
  while ((lastStep.get(username) ?? -1) >= step) {
    await page.waitForTimeout(1_000);
    step = Math.floor(Date.now() / 30_000);
  }
  lastStep.set(username, step);
  await page.getByLabel("Authenticator code").fill(totp(step));
  await page.getByRole("button", { name: "Verify and sign in" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /^Today/ })).toBeVisible();
}
