import type { DocumentType, EligibilityResult, RenewalStatus, WorkerComplianceSummary } from "@mms/core";
import { currentUser } from "./user";

export const API_URL: string = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

const DEMO = import.meta.env.MODE === "demo";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues: { path: string; message: string }[] = [],
    /** The server's reason, e.g. `OTP_REQUIRED` (every error body carries `{ code, message }`). */
    readonly code: string | null = null,
    /** Any other fields of the error body, e.g. `retryAfterSeconds` or `problems`. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function toResult<T>(res: Response): Promise<T> {
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) {
    const issues = data?.issues ?? data?.message?.issues ?? [];
    const message = typeof data?.message === "string" ? data.message : (data?.message?.message ?? res.statusText);
    const { code, message: _message, issues: _issues, ...details } = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    throw new ApiError(res.status, message, issues, typeof code === "string" ? code : null, details);
  }
  return data as T;
}

// ── Session client (every build except the hosted demo) ─────────────────────────────────────────
// The access token lives in this module's memory only, never in localStorage or sessionStorage, so
// it dies with the tab and an injected script can't lift it from storage. The refresh token is an
// httpOnly cookie on /api/auth that JavaScript never sees.

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
}
/** A first-sign-in step the user still owes before the app opens. */
export type NextStep = "change_password" | "setup_2fa" | null;
export interface AuthGrant {
  accessToken: string;
  expiresIn: number;
  user: AuthUser;
  next: NextStep;
}

let accessToken: string | null = null;
let renewTimer: ReturnType<typeof setTimeout> | undefined;
let renewing: Promise<AuthGrant | null> | null = null;
const listeners = new Set<(grant: AuthGrant | null) => void>();
const RENEW_EARLY_SECONDS = 60;
/** Auth calls whose 401 means "wrong credentials" or "no session", not "token expired". */
const NO_RETRY = new Set(["/api/auth/login", "/api/auth/refresh", "/api/auth/logout"]);

/** Called with every new grant, and with null when the session ends. Returns an unsubscribe. */
export function onSessionChange(fn: (grant: AuthGrant | null) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function adopt(grant: AuthGrant | null): void {
  accessToken = grant?.accessToken ?? null;
  clearTimeout(renewTimer);
  // Renew a minute before the token runs out, so a busy screen rarely meets a 401.
  if (grant) renewTimer = setTimeout(() => void refreshSession().catch(() => {}), Math.max(grant.expiresIn - RENEW_EARLY_SECONDS, 10) * 1000);
  for (const fn of listeners) fn(grant);
}

function send(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    // The refresh cookie lives on /api/auth; the API is on another origin in development.
    credentials: path.startsWith("/api/auth/") ? "include" : "same-origin",
  });
}

/**
 * Swap the refresh cookie for a new access token. Single-flight within the tab and serialised
 * across tabs with the Web Locks API where the browser has it: the cookie rotates on every use, so
 * two tabs presenting the same old cookie would look like a replay and end the session.
 * Resolves null only when the server answers 401 (the session has ended); network errors and
 * server faults reject and leave the session as it is.
 */
export function refreshSession(): Promise<AuthGrant | null> {
  renewing ??= (async () => {
    try {
      const run = async () => {
        const res = await send("POST", "/api/auth/refresh");
        return res.status === 401 ? null : toResult<AuthGrant>(res);
      };
      const grant = typeof navigator !== "undefined" && navigator.locks ? await navigator.locks.request("mms-auth-refresh", run) : await run();
      adopt(grant);
      return grant;
    } finally {
      renewing = null;
    }
  })();
  return renewing;
}

/**
 * Set when a sign-out could not be confirmed by the server (offline, server fault). While set, the
 * app does not restore the session from the refresh cookie on start: it retries the sign-out
 * instead, so on a shared office PC the next person never finds the last one still signed in.
 * Not a secret: it only says "someone signed out here".
 */
const PENDING_SIGN_OUT = "mms.pendingSignOut";

function pendingSignOut(value?: boolean): boolean {
  try {
    if (value === true) localStorage.setItem(PENDING_SIGN_OUT, "1");
    if (value === false) localStorage.removeItem(PENDING_SIGN_OUT);
    return localStorage.getItem(PENDING_SIGN_OUT) === "1";
  } catch {
    return false;
  }
}

/** POST /api/auth/login. A right password with two-factor on answers 401 `OTP_REQUIRED`: re-send with `otp`. */
export async function login(input: { username: string; password: string; otp?: string }): Promise<AuthGrant> {
  const grant = await toResult<AuthGrant>(await send("POST", "/api/auth/login", input));
  pendingSignOut(false);
  adopt(grant);
  return grant;
}

/**
 * Ends the session on the server (bearer and cookie) and forgets the token. Returns whether the
 * server confirmed it; if not, the sign-out stays pending (see PENDING_SIGN_OUT) until it does.
 */
export async function logout(): Promise<boolean> {
  let confirmed = false;
  try {
    confirmed = (await send("POST", "/api/auth/logout")).ok;
  } catch {
    confirmed = false;
  }
  pendingSignOut(!confirmed);
  adopt(null);
  return confirmed;
}

/**
 * On app start: restore the session from the refresh cookie, unless a sign-out is still pending,
 * in which case finish the sign-out first and stay signed out.
 */
export async function restoreSession(): Promise<AuthGrant | null> {
  if (pendingSignOut()) {
    await logout();
    return null;
  }
  return refreshSession();
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  // The hosted demo (Cloudflare, `vite build --mode demo`) has no API server: answer in the browser.
  // Vite replaces MODE at build time, so other builds drop this branch and the stand-in entirely.
  if (DEMO) {
    const { demoServer } = await import("@/demo/server");
    return demoServer().handle<T>(method, path, body, currentUser());
  }
  const sentWith = accessToken;
  let res = await send(method, path, body);
  // 401: the token expired or was revoked. Renew once (unless another call already did) and retry once.
  if (res.status === 401 && !NO_RETRY.has(path)) {
    if (accessToken !== sentWith || (await refreshSession())) res = await send(method, path, body);
  }
  return toResult<T>(res);
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
};

export interface WorkerListItem {
  id: string;
  code: string;
  fullName: string;
  nationality: string;
  trade: string;
  status: string;
  compliance: WorkerComplianceSummary;
}

export interface WorkerDocumentView {
  id: string;
  type: DocumentType;
  number: string | null;
  issueDate?: string | null;
  expiryDate: string | null;
  verified: boolean;
  verifiedBy?: string | null;
  renewal: RenewalStatus | null;
}

export interface WorkerDetail extends WorkerListItem {
  phone: string | null;
  joinedOn?: string | null;
  documents: WorkerDocumentView[];
  leave: { id: string; fromDate: string; toDate: string }[];
}

export interface Site {
  id: string;
  code: string;
  name: string;
  clientName: string;
  requiredDocuments?: DocumentType[];
}

export interface RenewalItem extends RenewalStatus {
  id: string;
  workerId: string;
  workerName: string;
  workerCode: string;
  type: DocumentType;
  expiryDate: string;
}

export interface DashboardSummary {
  today: string;
  headcount: number;
  byStatus: Record<string, number>;
  byCompliance: Record<"ok" | "due" | "incomplete" | "expired", number>;
  expiringIn30Days: number;
}

export type { EligibilityResult };
