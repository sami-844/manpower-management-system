import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SessionProvider } from "@/lib/session";
import { WorkerFile } from "./WorkerFile";

const worker = {
  id: "11111111-1111-4111-8111-111111111111",
  code: "W-000091",
  fullName: "Hasan Uddin",
  nationality: "Bangladesh",
  trade: "Steel fixer",
  status: "deployed",
  phone: "+968 91234567",
  compliance: { state: "expired", missing: [], nextExpiry: { type: "residence_visa", expiryDate: "2026-09-04", daysLeft: -40 } },
  documents: [
    { id: "d1", type: "residence_visa", number: "••••1234", expiryDate: "2026-09-04", verified: true, fileId: "f1", renewal: { state: "expired", daysLeft: -40, tier: 0 } },
    { id: "d2", type: "medical", number: null, expiryDate: "2027-05-01", verified: false, renewal: { state: "ok", daysLeft: 199, tier: null } },
  ],
  leave: [],
};

const sites = { items: [{ id: "22222222-2222-4222-8222-222222222222", code: "SOH-PORT", name: "Sohar Port Phase 3", clientName: "Gulf Build LLC" }] };

let calls: { url: string; init?: RequestInit }[];
let permissions: string[];
const hrOfficer = { id: "u1", username: "hr.officer", displayName: "Test Officer" };

beforeEach(() => {
  calls = [];
  permissions = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      // Signed in as the HR officer (session restored from the refresh cookie): verifying documents is an HR action.
      const body = url.endsWith("/api/auth/refresh")
        ? { accessToken: "t1", expiresIn: 900, user: hrOfficer, next: null }
        : url.endsWith("/api/auth/me")
          ? { user: hrOfficer, entityId: "e1", entityChoices: [], roles: ["hr_pro"], permissions, next: null }
          : url.endsWith("/api/sites")
            ? sites
            : url.endsWith("/compliance/check")
              ? {
                  eligible: false,
                  blockers: [{ code: "DOCUMENT_EXPIRED", documentType: "residence_visa", message: "Residence visa expired on 2026-09-04" }],
                  warnings: [{ code: "DOCUMENT_UNVERIFIED", documentType: "medical", message: "Medical fitness not yet verified by HR" }],
                }
              : url.endsWith("/api/documents/d1/scan")
                ? null
                : url.includes("/verify")
                ? { ...worker.documents[1], verified: true }
                : worker;
      if (body === null) return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200, headers: { "content-type": "application/pdf" } });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SessionProvider>
        <TooltipProvider>
          <MemoryRouter initialEntries={[`/workers/${worker.id}`]}>
            <Routes>
              <Route path="/workers/:id" element={<WorkerFile />} />
            </Routes>
          </MemoryRouter>
        </TooltipProvider>
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe("WorkerFile", () => {
  it("shows the worker and each document with its expiry in plain words", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "Hasan Uddin" })).toBeInTheDocument();
    const docs = screen.getByRole("table", { name: "Documents" });
    expect(within(docs).getByText("Residence visa")).toBeInTheDocument();
    expect(within(docs).getByText("Expired 40 days ago")).toBeInTheDocument();
    expect(within(docs).getByText("••••1234")).toBeInTheDocument();
  });

  it("checks whether the worker can be deployed and lists every reason", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "Hasan Uddin" });
    const user = userEvent.setup();
    await screen.findByRole("option", { name: "Sohar Port Phase 3" });
    await user.selectOptions(screen.getByLabelText("Site"), "Sohar Port Phase 3");
    await user.clear(screen.getByLabelText("From"));
    await user.type(screen.getByLabelText("From"), "2026-11-01");
    await user.clear(screen.getByLabelText("To"));
    await user.type(screen.getByLabelText("To"), "2026-11-30");
    await user.click(screen.getByRole("button", { name: "Check eligibility" }));

    expect(await screen.findByText("Cannot be deployed")).toBeInTheDocument();
    expect(screen.getByText("Residence visa expired on 4 Sept 2026")).toBeInTheDocument();
    expect(screen.getByText("Medical fitness not yet verified by HR")).toBeInTheDocument();
    const check = calls.find((c) => c.url.endsWith("/compliance/check"));
    expect(JSON.parse(String(check?.init?.body))).toEqual({
      workerId: worker.id,
      siteId: sites.items[0]!.id,
      from: "2026-11-01",
      to: "2026-11-30",
    });
  });

  it("lets HR verify an unverified document", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "Hasan Uddin" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Verify Medical fitness" }));
    const verify = calls.find((c) => c.url.endsWith("/api/documents/d2/verify"));
    expect(verify?.init?.method).toBe("PATCH");
  });

  it("hides the scan actions from an account without pii.view or documents.create", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "Hasan Uddin" });
    expect(screen.queryByRole("button", { name: /View scan/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Upload scan/ })).not.toBeInTheDocument();
  });

  it("shows View scan where a scan exists and Upload scan on every document for HR", async () => {
    permissions = ["documents.create", "documents.verify", "pii.view"];
    const open = vi.fn();
    vi.stubGlobal("open", open);
    URL.createObjectURL = vi.fn(() => "blob:scan");
    URL.revokeObjectURL = vi.fn();
    renderPage();
    await screen.findByRole("heading", { name: "Hasan Uddin" });
    const docs = screen.getByRole("table", { name: "Documents" });
    expect(within(docs).getAllByRole("button", { name: /Upload scan/ })).toHaveLength(2);
    expect(within(docs).queryByRole("button", { name: "View scan: Medical fitness" })).not.toBeInTheDocument();
    await userEvent.setup().click(within(docs).getByRole("button", { name: "View scan: Residence visa" }));
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith("blob:scan", "_blank", "noopener"));
    const scan = calls.find((c) => c.url.endsWith("/api/documents/d1/scan"));
    expect(new Headers(scan?.init?.headers).get("authorization")).toBe("Bearer t1");
  });
});
