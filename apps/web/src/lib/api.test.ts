// Session client (non-demo builds): in-memory access token, one renew-and-retry on 401,
// single-flight renewals serialised across tabs, and only a 401 from the renewal ends the session.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Api = typeof import("./api");
let mod: Api;
let fetchMock: ReturnType<typeof vi.fn>;

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const grant = (token: string) => ({ accessToken: token, expiresIn: 900, user: { id: "u1", username: "hr.officer", displayName: "Test Officer" }, next: null });
const headersOf = (call: unknown[]) => new Headers((call[1] as RequestInit | undefined)?.headers);
const callsTo = (path: string) => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith(path));

/** Route fetch by path; each route returns the next response in its list (the last one repeats). */
function route(routes: Record<string, (() => Response | Promise<Response>)[]>) {
  const seen: Record<string, number> = {};
  fetchMock.mockImplementation(async (url: string) => {
    const path = Object.keys(routes).find((p) => url.endsWith(p));
    if (!path) throw new Error(`unexpected fetch ${url}`);
    const list = routes[path]!;
    const i = Math.min(seen[path] ?? 0, list.length - 1);
    seen[path] = (seen[path] ?? 0) + 1;
    return list[i]!();
  });
}

beforeEach(async () => {
  vi.resetModules();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  localStorage.clear();
  sessionStorage.clear();
  mod = await import("./api");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "locks");
});

describe("session client", () => {
  it("keeps the access token in memory only and sends it as a bearer token", async () => {
    route({ "/api/auth/login": [() => json(200, grant("t1"))], "/api/workers": [() => json(200, { items: [] })] });
    await mod.login({ username: "hr.officer", password: "correct horse battery" });
    await mod.api.get("/api/workers");

    expect((callsTo("/api/auth/login")[0]![1] as RequestInit).credentials).toBe("include");
    const h = headersOf(callsTo("/api/workers")[0]!);
    expect(h.get("authorization")).toBe("Bearer t1");
    expect(h.get("x-user")).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("renews once and retries once when a call gets a 401", async () => {
    route({
      "/api/auth/login": [() => json(200, grant("t1"))],
      "/api/auth/refresh": [() => json(200, grant("t2"))],
      "/api/workers": [() => json(401, { code: "TOKEN_INVALID", message: "Sign in again." }), () => json(200, { ok: true })],
    });
    await mod.login({ username: "hr.officer", password: "x" });
    await expect(mod.api.get("/api/workers")).resolves.toEqual({ ok: true });

    expect(callsTo("/api/auth/refresh")).toHaveLength(1);
    expect((callsTo("/api/auth/refresh")[0]![1] as RequestInit).credentials).toBe("include");
    const [first, retry] = callsTo("/api/workers");
    expect(headersOf(first!).get("authorization")).toBe("Bearer t1");
    expect(headersOf(retry!).get("authorization")).toBe("Bearer t2");
  });

  it("does not loop: a second 401 after renewing is reported", async () => {
    route({
      "/api/auth/login": [() => json(200, grant("t1"))],
      "/api/auth/refresh": [() => json(200, grant("t2"))],
      "/api/workers": [() => json(401, { code: "TOKEN_INVALID", message: "Sign in again." })],
    });
    await mod.login({ username: "hr.officer", password: "x" });
    await expect(mod.api.get("/api/workers")).rejects.toMatchObject({ status: 401, code: "TOKEN_INVALID" });
    expect(callsTo("/api/auth/refresh")).toHaveLength(1);
    expect(callsTo("/api/workers")).toHaveLength(2);
  });

  it("shares one renewal between calls that get a 401 at the same time", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    route({
      "/api/auth/login": [() => json(200, grant("t1"))],
      "/api/auth/refresh": [async () => (await held, json(200, grant("t2")))],
      "/api/a": [() => json(401, { code: "TOKEN_INVALID" }), () => json(200, "a")],
      "/api/b": [() => json(401, { code: "TOKEN_INVALID" }), () => json(200, "b")],
      "/api/c": [() => json(401, { code: "TOKEN_INVALID" }), () => json(200, "c")],
    });
    await mod.login({ username: "hr.officer", password: "x" });
    const all = Promise.all([mod.api.get("/api/a"), mod.api.get("/api/b"), mod.api.get("/api/c")]);
    await vi.waitFor(() => expect(callsTo("/api/auth/refresh")).toHaveLength(1));
    release();
    await expect(all).resolves.toEqual(["a", "b", "c"]);
    expect(callsTo("/api/auth/refresh")).toHaveLength(1);
  });

  it("serialises renewals across tabs with the Web Locks API", async () => {
    const request = vi.fn((_name: string, cb: () => Promise<unknown>) => cb());
    Object.defineProperty(navigator, "locks", { value: { request }, configurable: true });
    route({ "/api/auth/refresh": [() => json(200, grant("t2"))] });
    await mod.refreshSession();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toBe("mms-auth-refresh");
  });

  it("ends the session when the renewal itself gets a 401", async () => {
    const seen = vi.fn();
    mod.onSessionChange(seen);
    route({
      "/api/auth/login": [() => json(200, grant("t1"))],
      "/api/auth/refresh": [() => json(401, { code: "SESSION_ENDED", message: "Your session has ended." })],
      "/api/workers": [() => json(401, { code: "TOKEN_INVALID" })],
    });
    await mod.login({ username: "hr.officer", password: "x" });
    await expect(mod.api.get("/api/workers")).rejects.toMatchObject({ status: 401 });
    expect(seen).toHaveBeenLastCalledWith(null);
    // The token is gone: the next call goes out without one.
    await mod.api.get("/api/workers").catch(() => {});
    expect(headersOf(callsTo("/api/workers").at(-1)!).get("authorization")).toBeNull();
  });

  it("keeps the session when the renewal fails for a network error or a server fault", async () => {
    const seen = vi.fn();
    mod.onSessionChange(seen);
    route({
      "/api/auth/login": [() => json(200, grant("t1"))],
      "/api/auth/refresh": [() => json(503, { message: "Service unavailable" }), () => Promise.reject(new TypeError("Failed to fetch"))],
      "/api/workers": [() => json(401, { code: "TOKEN_INVALID" })],
    });
    await mod.login({ username: "hr.officer", password: "x" });
    await expect(mod.api.get("/api/workers")).rejects.toMatchObject({ status: 503 });
    await expect(mod.api.get("/api/workers")).rejects.toThrow("Failed to fetch");
    expect(seen).not.toHaveBeenCalledWith(null);
    expect(headersOf(callsTo("/api/workers").at(-1)!).get("authorization")).toBe("Bearer t1");
  });

  it("renews shortly before the access token runs out", async () => {
    vi.useFakeTimers();
    route({ "/api/auth/login": [() => json(200, grant("t1"))], "/api/auth/refresh": [() => json(200, grant("t2"))] });
    await mod.login({ username: "hr.officer", password: "x" });
    await vi.advanceTimersByTimeAsync(800_000);
    expect(callsTo("/api/auth/refresh")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(callsTo("/api/auth/refresh")).toHaveLength(1);
  });

  it("signs out: tells the server with the bearer token, then forgets it", async () => {
    const seen = vi.fn();
    mod.onSessionChange(seen);
    route({ "/api/auth/login": [() => json(200, grant("t1"))], "/api/auth/logout": [() => new Response(null, { status: 204 })] });
    await mod.login({ username: "hr.officer", password: "x" });
    await mod.logout();
    const [call] = callsTo("/api/auth/logout");
    expect(headersOf(call!).get("authorization")).toBe("Bearer t1");
    expect((call![1] as RequestInit).credentials).toBe("include");
    expect(seen).toHaveBeenLastCalledWith(null);
  });

  it("does not restore a session whose sign-out the server never confirmed, and finishes the sign-out", async () => {
    route({
      "/api/auth/login": [() => json(200, grant("t1"))],
      "/api/auth/logout": [() => Promise.reject(new TypeError("offline")), () => new Response(null, { status: 204 })],
      "/api/auth/refresh": [() => json(200, grant("t2"))],
    });
    await mod.login({ username: "hr.officer", password: "x" });
    expect(await mod.logout()).toBe(false);

    // Next start (same browser): no restore from the cookie; the sign-out is retried instead.
    expect(await mod.restoreSession()).toBeNull();
    expect(callsTo("/api/auth/refresh")).toHaveLength(0);
    expect(callsTo("/api/auth/logout")).toHaveLength(2);

    // Confirmed now: the start after that restores normally again.
    expect(await mod.restoreSession()).toMatchObject({ accessToken: "t2" });
  });

  it("puts the server's error code and extra fields on ApiError", async () => {
    route({ "/api/auth/login": [() => json(423, { code: "ACCOUNT_LOCKED", message: "Locked.", retryAfterSeconds: 540 })] });
    const err = await mod.login({ username: "hr.officer", password: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(mod.ApiError);
    expect(err).toMatchObject({ status: 423, code: "ACCOUNT_LOCKED", message: "Locked.", details: { retryAfterSeconds: 540 } });
    expect(callsTo("/api/auth/refresh")).toHaveLength(0);
  });
});
