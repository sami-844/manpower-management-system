// S-46 My account: two-factor sign-in is optional (A31); each person turns it on with an
// authenticator app and off with their password and a fresh code.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { SessionProvider } from "@/lib/session";
import { Account } from "./Account";

type Handler = (body: Record<string, unknown>) => Response;
let routes: Record<string, Handler[]>;
let calls: { path: string; body: Record<string, unknown> }[];
let twoFactor: boolean;

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const user = { id: "u1", username: "hr.officer", displayName: "Test Officer" };

beforeEach(() => {
  calls = [];
  twoFactor = false;
  routes = {
    "/api/auth/refresh": [() => json(200, { accessToken: "t1", expiresIn: 900, user, next: null })],
    "/api/auth/me": [() => json(200, { user, entityId: "e1", entityChoices: [], roles: ["hr_pro"], permissions: [], next: null, twoFactor })],
  };
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

function renderAccount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SessionProvider>
        <MemoryRouter>
          <Account />
        </MemoryRouter>
      </SessionProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const bodies = (path: string) => calls.filter((c) => c.path === path).map((c) => c.body);

describe("My account (S-46)", () => {
  it("shows who is signed in and that two-factor is off, and turns it on with the QR code, a first code and the password", async () => {
    routes["/api/auth/2fa/setup"] = [() => json(200, { secret: "JBSWY3DPEHPK3PXPJBSWY3DP", otpauthUrl: "otpauth://totp/MMS:hr.officer?secret=JBSWY3DPEHPK3PXPJBSWY3DP&issuer=MMS" })];
    routes["/api/auth/2fa/confirm"] = [
      () => json(400, { code: "OTP_INVALID", message: "Wrong." }),
      () => json(400, { code: "CURRENT_PASSWORD_WRONG", message: "Wrong." }),
      () => {
        twoFactor = true;
        return json(200, { next: null });
      },
    ];
    const u = renderAccount();

    expect(await screen.findByText("Off")).toBeInTheDocument();
    expect(await screen.findByText("hr.officer")).toBeInTheDocument();
    expect(screen.getByText("HR / PRO officer")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/auth/2fa/setup")).toBe(false);

    await u.click(screen.getByRole("button", { name: "Turn on two-factor" }));
    expect(await screen.findByRole("img", { name: /QR code/ })).toBeInTheDocument();
    expect(screen.getByText("JBSW Y3DP EHPK 3PXP JBSW Y3DP")).toBeInTheDocument();
    const code = screen.getByLabelText(/Code from the app/);
    expect(code).toHaveAttribute("autocomplete", "one-time-code");

    expect(bodies("/api/auth/2fa/setup")).toHaveLength(1);
    const submit = () => screen.getByRole("button", { name: "Turn on two-factor" });

    await u.type(code, "111111");
    expect(submit()).toBeDisabled(); // the password is needed too
    await u.type(screen.getByLabelText("Password"), "my real password");
    await u.click(submit());
    expect(await screen.findByText(/That code didn't match/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/Code from the app/)).toHaveFocus());

    await u.type(screen.getByLabelText(/Code from the app/), "222222");
    await u.click(submit());
    expect(await screen.findByText("That isn't your current password.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Password")).toHaveFocus());
    expect(screen.getByLabelText("Password")).toHaveValue("");

    await u.type(screen.getByLabelText("Password"), "my real password");
    await u.type(screen.getByLabelText(/Code from the app/), "333333");
    await u.click(submit());

    expect(await screen.findByText("On")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Turn off two-factor" })).toHaveFocus());
    expect(bodies("/api/auth/2fa/confirm")).toEqual([
      { password: "my real password", code: "111111" },
      { password: "my real password", code: "222222" },
      { password: "my real password", code: "333333" },
    ]);
    expect(bodies("/api/auth/2fa/setup")).toHaveLength(1);
  });

  it("lets the user cancel setting it up", async () => {
    routes["/api/auth/2fa/setup"] = [() => json(200, { secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/MMS:hr.officer?secret=JBSWY3DPEHPK3PXP&issuer=MMS" })];
    const u = renderAccount();
    await u.click(await screen.findByRole("button", { name: "Turn on two-factor" }));
    expect(await screen.findByRole("img", { name: /QR code/ })).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("img", { name: /QR code/ })).not.toBeInTheDocument();
    expect(screen.getByText("Off")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Turn on two-factor" })).toHaveFocus());
  });

  it("turns it off only with the password and a fresh code, explaining each refusal", async () => {
    twoFactor = true;
    routes["/api/auth/2fa/disable"] = [
      () => json(400, { code: "CURRENT_PASSWORD_WRONG", message: "Wrong." }),
      () => json(400, { code: "OTP_INVALID", message: "Wrong." }),
      () => {
        twoFactor = false;
        return json(200, { twoFactor: false });
      },
    ];
    const u = renderAccount();

    expect(await screen.findByText("On")).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Turn off two-factor" }));
    const submit = screen.getByRole("button", { name: "Turn off two-factor" });
    expect(submit).toBeDisabled();
    expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "current-password");

    await u.type(screen.getByLabelText("Password"), "not my password");
    await u.type(screen.getByLabelText("Authenticator code"), "123456");
    await u.click(submit);
    expect(await screen.findByText("That isn't your current password.")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(screen.getByLabelText("Password")).toHaveFocus());

    await u.type(screen.getByLabelText("Password"), "my real password");
    await u.type(screen.getByLabelText("Authenticator code"), "000000");
    await u.click(screen.getByRole("button", { name: "Turn off two-factor" }));
    expect(await screen.findByText(/That code didn't work/)).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveValue("my real password");
    await waitFor(() => expect(screen.getByLabelText("Authenticator code")).toHaveFocus());

    await u.type(screen.getByLabelText("Authenticator code"), "654321");
    await u.click(screen.getByRole("button", { name: "Turn off two-factor" }));
    expect(await screen.findByText("Off")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Turn on two-factor" })).toHaveFocus());
    expect(bodies("/api/auth/2fa/disable")).toEqual([
      { password: "not my password", code: "123456" },
      { password: "my real password", code: "000000" },
      { password: "my real password", code: "654321" },
    ]);
  });

  it("says plainly when too many wrong tries have locked the account", async () => {
    twoFactor = true;
    routes["/api/auth/2fa/disable"] = [() => json(423, { code: "ACCOUNT_LOCKED", message: "Locked.", retryAfterSeconds: 900 })];
    const u = renderAccount();
    await u.click(await screen.findByRole("button", { name: "Turn off two-factor" }));
    await u.type(screen.getByLabelText("Password"), "my real password");
    await u.type(screen.getByLabelText("Authenticator code"), "123456");
    await u.click(screen.getByRole("button", { name: "Turn off two-factor" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("locked after too many failed sign-ins. Try again in 15 minutes");
  });
});
