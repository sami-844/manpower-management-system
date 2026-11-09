// S-36 against the real admin endpoints (non-demo builds): creating a user shows the temporary
// password once, with a copy button, and it is gone when the dialog closes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SessionProvider } from "@/lib/session";
import { Users } from "./Users";

const admin = { id: "u-admin", username: "sys.admin", displayName: "Test Admin" };
const existing = {
  id: "u-1",
  username: "pay.clerk",
  displayName: "Pay Clerk",
  email: null,
  status: "active",
  isPasswordChangeRequired: false,
  hasTotp: true,
  lockedUntil: null,
  isLocked: false,
  lastSignInAt: null,
  roles: [{ role: "payroll", entityId: "e1" }],
};
const TEMP = "Kq7m-Pz2W-v9xL-r4tN";
let calls: { method: string; path: string; body: unknown }[];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  calls = [];
  // Radix Checkbox measures itself; jsdom has no ResizeObserver.
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const method = init?.method ?? "GET";
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path === "/api/auth/refresh") return json(200, { accessToken: "t1", expiresIn: 900, user: admin, next: null });
      if (path === "/api/auth/me") return json(200, { user: admin, entityId: "e1", entityChoices: [], roles: ["admin"], permissions: ["users.manage"], next: null });
      if (path === "/api/admin/users" && method === "GET") return json(200, { items: [existing] });
      if (path === "/api/admin/users" && method === "POST")
        return json(201, { user: { ...existing, id: "u-2", username: "new.clerk", displayName: "New Clerk", roles: [{ role: "hr_pro", entityId: "e1" }] }, temporaryPassword: TEMP });
      throw new Error(`unexpected ${method} ${path}`);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderUsers() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SessionProvider>
        <TooltipProvider>
          <MemoryRouter>
            <Users />
          </MemoryRouter>
        </TooltipProvider>
      </SessionProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

describe("Users (S-36, live)", () => {
  it("lists users from the API", async () => {
    renderUsers();
    const table = await screen.findByRole("table", { name: "Users" });
    expect(await within(table).findByText("Pay Clerk")).toBeInTheDocument();
    expect(within(table).getByText("Payroll officer")).toBeInTheDocument();
  });

  it("creates a user and shows the temporary password once, with a copy button", async () => {
    const u = renderUsers();
    await u.click(await screen.findByRole("button", { name: "Add user" }));
    const form = await screen.findByRole("dialog", { name: "Add a user" });
    await u.type(within(form).getByLabelText("Username"), "New.Clerk");
    await u.type(within(form).getByLabelText("Full name"), "New Clerk");
    await u.click(within(form).getByRole("checkbox", { name: /HR \/ PRO officer/ }));
    await u.click(within(form).getByRole("button", { name: "Create user" }));

    const shown = await screen.findByRole("dialog", { name: "Temporary password for New Clerk" });
    expect(within(shown).getByText(TEMP)).toBeInTheDocument();
    expect(within(shown).getByText(/only time this password is shown/)).toBeInTheDocument();
    await u.click(within(shown).getByRole("button", { name: "Copy password" }));
    expect(await navigator.clipboard.readText()).toBe(TEMP);

    expect(calls.find((c) => c.method === "POST" && c.path === "/api/admin/users")?.body).toEqual({ username: "new.clerk", displayName: "New Clerk", roles: ["hr_pro"] });

    await u.click(within(shown).getByRole("button", { name: "Done" }));
    await vi.waitFor(() => expect(screen.queryByText(TEMP)).not.toBeInTheDocument());
  });
});
