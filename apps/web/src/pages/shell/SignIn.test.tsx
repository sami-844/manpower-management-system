// S-01 sign-in against the API's own authentication (non-demo builds): password, then the
// authenticator code when asked, then the one first-sign-in step (a new password). Two-factor is
// optional and set up in S-46 My account, never during sign-in (A31).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SessionProvider } from "@/lib/session";
import { SignIn } from "./SignIn";

type Handler = (body: Record<string, unknown>) => Response;
let routes: Record<string, Handler[]>;
let calls: { path: string; body: Record<string, unknown> }[];

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const user = { id: "u1", username: "hr.officer", displayName: "Test Officer" };
const grant = (next: string | null = null) => json(200, { accessToken: "t1", expiresIn: 900, user, next });
const me = (next: string | null = null, roles = ["hr_pro"]) => json(200, { user, entityId: "e1", entityChoices: [], roles, permissions: [], next });
const noSession = () => json(401, { code: "SESSION_ENDED", message: "Your session has ended." });
const PASSWORD = "correct horse battery staple";

beforeEach(() => {
  calls = [];
  routes = { "/api/auth/refresh": [noSession] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      calls.push({ path, body });
      const list = routes[path];
      if (!list?.length) throw new Error(`unexpected ${path}`);
      return (list.length > 1 ? list.shift()! : list[0]!)(body);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderSignIn() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SessionProvider>
        <MemoryRouter initialEntries={["/sign-in"]}>
          <Routes>
            <Route path="/sign-in" element={<SignIn />} />
            <Route path="/" element={<h1>Today</h1>} />
            <Route path="/dashboard" element={<h1>Dashboard</h1>} />
          </Routes>
        </MemoryRouter>
      </SessionProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

async function enterPassword(u: ReturnType<typeof userEvent.setup>) {
  await u.type(await screen.findByLabelText("Username"), "hr.officer");
  await u.type(screen.getByLabelText("Password"), PASSWORD);
  await u.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("SignIn (S-01)", () => {
  it("signs in with a password, then the authenticator code, then opens the app", async () => {
    routes["/api/auth/login"] = [() => json(401, { code: "OTP_REQUIRED", message: "Enter the code." }), () => grant()];
    routes["/api/auth/me"] = [() => me()];
    const u = renderSignIn();

    expect(await screen.findByLabelText("Username")).toHaveAttribute("autocomplete", "username");
    expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "current-password");
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    await enterPassword(u);

    const code = await screen.findByLabelText("Authenticator code");
    expect(code).toHaveAttribute("inputmode", "numeric");
    expect(code).toHaveAttribute("autocomplete", "one-time-code");
    expect(code).toHaveFocus();
    expect(screen.queryByText(PASSWORD)).not.toBeInTheDocument();
    await u.type(code, "12a3456");
    await u.click(screen.getByRole("button", { name: "Verify and sign in" }));

    expect(await screen.findByRole("heading", { name: "Today" })).toBeInTheDocument();
    const logins = calls.filter((c) => c.path === "/api/auth/login");
    expect(logins.map((c) => c.body)).toEqual([
      { username: "hr.officer", password: PASSWORD },
      { username: "hr.officer", password: PASSWORD, otp: "123456" },
    ]);
  });

  it("warns on the Cloudflare client demo that the data is fictional (A32), and only there", async () => {
    vi.stubEnv("VITE_CLIENT_DEMO", "true");
    renderSignIn();
    expect(await screen.findByText(/Client demo: every person and figure here is fictional/)).toBeInTheDocument();
    vi.unstubAllEnvs();
  });

  it("on a client demo that is missing its secrets, says which ones instead of blaming the connection", async () => {
    routes["/api/auth/refresh"] = [() => json(503, { code: "NOT_CONFIGURED", message: "The client demo is not set up: DATABASE_URL is not set" })];
    renderSignIn();
    expect(await screen.findByText("The client demo is not set up: DATABASE_URL is not set")).toBeInTheDocument();
    expect(screen.queryByText(/couldn't reach the server/)).not.toBeInTheDocument();
  });

  it("shows no client demo notice on an ordinary build", async () => {
    renderSignIn();
    expect(await screen.findByLabelText("Username")).toBeInTheDocument();
    expect(screen.queryByText(/Client demo/)).not.toBeInTheDocument();
  });

  it("opens the owner's dashboard when the session is restored on start", async () => {
    routes["/api/auth/refresh"] = [() => grant()];
    routes["/api/auth/me"] = [() => me(null, ["owner", "finance"])];
    renderSignIn();
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
  });

  it.each([
    [401, { code: "INVALID_CREDENTIALS", message: "Wrong username or password." }, "That username and password don't match. Check both and try again."],
    [423, { code: "ACCOUNT_LOCKED", message: "Locked.", retryAfterSeconds: 540 }, "This account is locked after too many failed sign-ins. Try again in 9 minutes, or ask the system admin to unlock it."],
    [403, { code: "ACCOUNT_DISABLED", message: "Disabled." }, "This account has been turned off. Ask the system admin if you still need access."],
    [429, { code: "TOO_MANY_ATTEMPTS", message: "Too many." }, "Too many sign-in attempts from this network. Wait a few minutes, then try again."],
    [503, { code: "NOT_CONFIGURED", message: "The client demo is not set up: DATABASE_URL is not set" }, "The client demo is not set up: DATABASE_URL is not set"],
    [503, { code: "API_NOT_STARTED", message: "The client demo's API did not start. Open the logs." }, "The client demo's API did not start. Open the logs."],
  ])("explains a %i %o in plain words", async (status, body, message) => {
    routes["/api/auth/login"] = [() => json(status, body)];
    const u = renderSignIn();
    await enterPassword(u);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(message);
    expect(alert).not.toHaveTextContent(PASSWORD);
    expect(screen.getByLabelText("Username")).toHaveAccessibleDescription(message);
  });

  it("keeps the code step open when the authenticator code is wrong", async () => {
    routes["/api/auth/login"] = [
      () => json(401, { code: "OTP_REQUIRED", message: "Enter the code." }),
      () => json(401, { code: "OTP_INVALID", message: "Wrong code." }),
    ];
    const u = renderSignIn();
    await enterPassword(u);
    await u.type(await screen.findByLabelText("Authenticator code"), "000000");
    await u.click(screen.getByRole("button", { name: "Verify and sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That code didn't work.");
    expect(screen.getByLabelText("Authenticator code")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Authenticator code")).toHaveValue("");
  });

  it("makes a first-time user change the temporary password, then opens the app without asking for two-factor", async () => {
    routes["/api/auth/refresh"] = [() => grant("change_password")];
    routes["/api/auth/me"] = [() => me("change_password")];
    routes["/api/auth/change-password"] = [
      () => json(400, { code: "PASSWORD_POLICY", message: "Choose a different password.", problems: ["Must not contain the username"] }),
      () => json(200, { next: null }),
    ];
    const u = renderSignIn();

    expect(await screen.findByRole("heading", { name: "Choose a new password" })).toBeInTheDocument();
    expect(screen.getByText(/12 to 128 characters/)).toBeInTheDocument();
    expect(screen.getByLabelText("New password")).toHaveAttribute("autocomplete", "new-password");

    await u.type(screen.getByLabelText("Temporary password"), "Temp-Pass-0001");
    await u.type(screen.getByLabelText("New password"), "hr.officer is my name ok");
    await u.type(screen.getByLabelText("Confirm new password"), "something else entirely");
    await u.click(screen.getByRole("button", { name: "Save new password" }));
    expect(await screen.findByText("The two new passwords don't match.")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/auth/change-password")).toBe(false);

    await u.clear(screen.getByLabelText("Confirm new password"));
    await u.type(screen.getByLabelText("Confirm new password"), "hr.officer is my name ok");
    await u.click(screen.getByRole("button", { name: "Save new password" }));
    expect(await screen.findByText("Must not contain the username")).toBeInTheDocument();
    expect(screen.getByLabelText("New password")).toHaveAttribute("aria-invalid", "true");

    await u.clear(screen.getByLabelText("New password"));
    await u.type(screen.getByLabelText("New password"), "four quiet harbour lamps");
    await u.clear(screen.getByLabelText("Confirm new password"));
    await u.type(screen.getByLabelText("Confirm new password"), "four quiet harbour lamps");
    await u.click(screen.getByRole("button", { name: "Save new password" }));
    expect(await screen.findByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/api/auth/change-password")?.body).toEqual({ currentPassword: "Temp-Pass-0001", newPassword: "hr.officer is my name ok" });
    expect(screen.queryByText(/two-factor/i)).not.toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith("/api/auth/2fa"))).toBe(false);
  });
});
