/**
 * Stand-in for sign-in until Amazon Cognito is wired up (Spec §2).
 * Every change the API records is attributed to this name.
 */
const KEY = "mms.user";

export const DEMO_USERS = ["hr.officer", "pro.officer", "ops.manager", "payroll.officer"] as const;

export function currentUser(): string {
  try {
    return localStorage.getItem(KEY) ?? DEMO_USERS[0];
  } catch {
    return DEMO_USERS[0];
  }
}

export function setCurrentUser(user: string): void {
  try {
    localStorage.setItem(KEY, user);
  } catch {
    /* storage unavailable: keep the default */
  }
}
