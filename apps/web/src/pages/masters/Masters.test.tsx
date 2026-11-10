// S-44 and S-45 against the real masters endpoints (non-demo builds): the overview's groups and
// counts, a register's rows and states, actions shown only to accounts with the permission, and
// recording, uploading and adding through the right endpoints.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SessionProvider } from "@/lib/session";
import { Masters } from "./Masters";
import { MasterRegister } from "./MasterRegister";

const summary = (s: Partial<Record<string, number>>) => ({ total: 0, valid: 0, due: 0, expired: 0, noExpiry: 0, missing: 0, unverified: 0, ...s });
const info = (no: number, key: string, group: string, label: string, subject: string, documentType: string, documentLabel: string, requiredOfAll = true) => ({
  no, key, group, label, subject, documentType, documentLabel, requiredOfAll,
});
const PASSPORT = info(9, "direct_passport", "in_house", "Direct employee passport", "direct_employee", "passport", "Passport");
const TAX = info(3, "tax_card", "in_house", "Tax card", "company", "tax_card", "Tax card");
const SUBS = info(13, "subcontractor_registration", "purchase", "Sub-contractor company registration certificate", "subcontractor", "commercial_registration", "Company registration certificate");
const CLIENTS = info(18, "client_registration", "sales", "Client company registration certificate", "client", "commercial_registration", "Company registration certificate");

const overview = {
  today: "2026-11-10",
  groups: [
    { group: "in_house", label: "In House", masters: [{ ...TAX, summary: summary({ total: 1, valid: 1 }) }, { ...PASSPORT, summary: summary({ total: 640, valid: 600, due: 30, expired: 4, missing: 6, unverified: 3 }) }] },
    { group: "purchase", label: "Purchase", masters: [{ ...SUBS, summary: summary({ total: 2, valid: 1, due: 1 }) }] },
    { group: "sales", label: "Sales", masters: [{ ...CLIENTS, summary: summary({ total: 3, valid: 1, due: 1, missing: 1 }) }] },
  ],
};

const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
const W3 = "33333333-3333-4333-8333-333333333333";
const doc = (id: string, d: Partial<Record<string, unknown>> = {}) => ({
  id, subjectId: "x", type: "passport", number: "••••4567", issueDate: "2021-01-10", expiryDate: "2026-10-01",
  verified: false, verifiedBy: null, verifiedAt: null, hasScan: false, scanStatus: null, ...d,
});
const worker = (id: string, name: string, code: string, engagement = "own", sponsorName: string | null = "Demo Manpower Services LLC") => ({
  id, kind: engagement === "own" ? "direct_employee" : "indirect_employee", name, code, status: "deployed", engagement, sponsorName,
});
const registers: Record<string, unknown> = {
  direct_passport: {
    today: "2026-11-10",
    master: PASSPORT,
    summary: summary({ total: 3, expired: 1, missing: 1, valid: 1, unverified: 1 }),
    rows: [
      { subject: worker(W1, "Rahim Uddin", "W-000001"), document: doc("d1"), state: "expired", daysLeft: -40 },
      { subject: worker(W2, "Suresh Kumar", "W-000002"), document: null, state: "missing", daysLeft: null },
      { subject: worker(W3, "Anil Thapa", "W-000003"), document: doc("d3", { expiryDate: "2030-01-01", verified: true, verifiedBy: "hr.officer", hasScan: true, scanStatus: "clean" }), state: "valid", daysLeft: 1148 },
    ],
  },
  tax_card: {
    today: "2026-11-10",
    master: TAX,
    summary: summary({ total: 1, valid: 1 }),
    rows: [{ subject: { id: "s-own", kind: "company", name: "Demo Manpower Services LLC", code: "1000001", status: "active", engagement: null, sponsorName: null }, document: doc("o1", { type: "tax_card", number: "TAX-100200", expiryDate: "2027-09-06", verified: true, verifiedBy: "hr.officer" }), state: "valid", daysLeft: 300 }],
  },
  subcontractor_registration: { today: "2026-11-10", master: SUBS, summary: summary({}), rows: [] },
  client_registration: {
    today: "2026-11-10",
    master: CLIENTS,
    summary: summary({ total: 1, missing: 1 }),
    rows: [{ subject: { id: "c-1", kind: "client", name: "Batinah Steel", code: "C-00003", status: "active", engagement: null, sponsorName: null }, document: null, state: "missing", daysLeft: null }],
  },
};

let calls: { method: string; path: string; init: RequestInit }[];
let me: { roles: string[]; permissions: string[] };
const user = { id: "u1", username: "test.user", displayName: "Test User" };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const HR = { roles: ["hr_pro"], permissions: ["masters.read", "clients.read", "org_documents.manage", "company_documents.manage", "documents.create", "documents.verify", "sponsors.manage", "pii.view"] };
const OPS = { roles: ["ops_manager"], permissions: ["masters.read", "clients.read", "clients.manage", "org_documents.manage", "sponsors.manage"] };
const FINANCE = { roles: ["finance"], permissions: ["masters.read", "clients.read", "clients.manage"] };

beforeEach(() => {
  calls = [];
  me = HR;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname;
      const method = init.method ?? "GET";
      calls.push({ method, path, init });
      if (path === "/api/auth/refresh") return json(200, { accessToken: "t1", expiresIn: 900, user, next: null });
      if (path === "/api/auth/me") return json(200, { user, entityId: "e1", entityChoices: [], ...me, next: null });
      if (path === "/api/masters") return json(200, overview);
      const key = path.match(/^\/api\/masters\/(.+)$/)?.[1];
      if (key) return registers[key] ? json(200, registers[key]) : json(404, { code: "UNKNOWN_MASTER", message: "No such master." });
      if (method === "POST" && path.endsWith("/scan")) return json(201, { fileId: "f1", verified: false });
      if (method === "POST") return json(201, { id: "new" });
      if (method === "PATCH") return json(200, { id: "x", verified: true });
      throw new Error(`unexpected ${method} ${path}`);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SessionProvider>
        <TooltipProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/masters" element={<Masters />} />
              <Route path="/masters/:key" element={<MasterRegister />} />
            </Routes>
          </MemoryRouter>
          <Toaster />
        </TooltipProvider>
      </SessionProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}
const table = () => screen.findByRole("table", { name: "Register" });
const sent = (method: string, path: string) => calls.find((c) => c.method === method && c.path === path);

describe("Document masters (S-44)", () => {
  it("shows the three groups and each master's counts, opening its register", async () => {
    renderAt("/masters");
    expect(await screen.findByRole("heading", { name: "In House" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Purchase" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sales" })).toBeInTheDocument();

    const passport = screen.getByRole("link", { name: /Direct employee passport/ });
    expect(passport).toHaveAttribute("href", "/masters/direct_passport");
    for (const word of ["4 expired", "6 missing", "30 due", "600 valid", "3 not verified"]) expect(within(passport).getByText(word)).toBeInTheDocument();
    expect(within(screen.getByRole("link", { name: /Client company registration/ })).getByText("1 missing")).toBeInTheDocument();
    expect(screen.getByLabelText("Summary")).toHaveTextContent("646 records across 4 masters: 4 expired, 7 missing, 32 due for renewal and 3 not yet verified.");
  });
});

describe("Master register (S-45)", () => {
  it("lists every subject with its document, state in words and scan, most urgent first", async () => {
    renderAt("/masters/direct_passport");
    expect(await screen.findByRole("heading", { name: "Direct employee passport" })).toBeInTheDocument();
    const rows = within(await table()).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[0]!.textContent)).toEqual([
      "Rahim UddinW-000001 · Own employee",
      "Suresh KumarW-000002 · Own employee",
      "Anil ThapaW-000003 · Own employee",
    ]);
    expect(within(rows[0]!).getByText("Expired 40 days ago")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Expired")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("••••4567")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Not recorded")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Missing")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Scan on file")).toBeInTheDocument();
    expect(within(rows[2]!).getByRole("link", { name: "Anil Thapa" })).toHaveAttribute("href", `/workers/${W3}`);
  });

  it("filters by state", async () => {
    const u = renderAt("/masters/direct_passport");
    await table();
    await u.click(screen.getByRole("button", { name: /^Missing/ }));
    const rows = within(await table()).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByText("Suresh Kumar")).toBeInTheDocument();
  });

  it("shows no actions to an account that may only read", async () => {
    me = FINANCE;
    renderAt("/masters/direct_passport");
    const t = await table();
    await within(t).findByText("Rahim Uddin");
    for (const name of [/^Record/, /^Renew/, /^Verify/, /^Upload scan/, /^View scan/]) expect(within(t).queryByRole("button", { name })).not.toBeInTheDocument();
    expect(within(t).getByText("Not verified")).toBeInTheDocument();
  });

  it("records a worker's document through the worker endpoint", async () => {
    const u = renderAt("/masters/direct_passport");
    await u.click(await within(await table()).findByRole("button", { name: "Record: Suresh Kumar" }));
    const form = await screen.findByRole("dialog", { name: "Record passport for Suresh Kumar" });
    await u.type(within(form).getByLabelText("Number"), "P7654321");
    await u.type(within(form).getByLabelText("Issued"), "2026-01-05");
    await u.type(within(form).getByLabelText("Expires"), "2036-01-04");
    await u.click(within(form).getByRole("button", { name: "Save document" }));
    await vi.waitFor(() => expect(sent("POST", `/api/workers/${W2}/documents`)).toBeDefined());
    expect(JSON.parse(String(sent("POST", `/api/workers/${W2}/documents`)!.init.body))).toEqual({ type: "passport", number: "P7654321", issueDate: "2026-01-05", expiryDate: "2036-01-04" });
  });

  it("records a client's CR through the organisation endpoint with the client as subject", async () => {
    me = OPS;
    const u = renderAt("/masters/client_registration");
    await u.click(await within(await table()).findByRole("button", { name: "Record: Batinah Steel" }));
    const form = await screen.findByRole("dialog");
    await u.type(within(form).getByLabelText("Expires"), "2027-12-31");
    await u.click(within(form).getByRole("button", { name: "Save document" }));
    await vi.waitFor(() => expect(sent("POST", "/api/organisation-documents")).toBeDefined());
    expect(JSON.parse(String(sent("POST", "/api/organisation-documents")!.init.body))).toEqual({
      subject: { kind: "client", clientId: "c-1" },
      type: "commercial_registration",
      expiryDate: "2027-12-31",
    });
  });

  it("keeps the company's own papers to HR: operations see no Record, Renew or Upload there", async () => {
    me = OPS;
    renderAt("/masters/tax_card");
    const t = await table();
    await within(t).findByText("Demo Manpower Services LLC");
    expect(within(t).queryByRole("button", { name: /^Renew/ })).not.toBeInTheDocument();
    expect(within(t).queryByRole("button", { name: /^Upload scan/ })).not.toBeInTheDocument();
  });

  it("verifies through the right endpoint", async () => {
    const u = renderAt("/masters/direct_passport");
    await u.click(await within(await table()).findByRole("button", { name: "Verify: Rahim Uddin" }));
    await vi.waitFor(() => expect(sent("PATCH", "/api/documents/d1/verify")).toBeDefined());
  });

  it("uploads a scan as the raw body with the file's type and its name encoded", async () => {
    const u = renderAt("/masters/direct_passport");
    await within(await table()).findByText("Rahim Uddin");
    const file = new File(["%PDF-1.4"], "passport scan.pdf", { type: "application/pdf" });
    await u.upload(screen.getByLabelText("Choose a scan: Rahim Uddin"), file);
    await vi.waitFor(() => expect(sent("POST", "/api/documents/d1/scan")).toBeDefined());
    const { init } = sent("POST", "/api/documents/d1/scan")!;
    expect(init.body).toBe(file);
    const h = new Headers(init.headers);
    expect(h.get("content-type")).toBe("application/pdf");
    expect(h.get("x-file-name")).toBe("passport%20scan.pdf");
    expect(h.get("authorization")).toBe("Bearer t1");
    expect(await screen.findByText("Scan uploaded")).toBeInTheDocument();
  });

  it("says a verified document needs HR again when the upload un-verified it", async () => {
    const u = renderAt("/masters/direct_passport");
    await within(await table()).findByText("Anil Thapa");
    await u.upload(screen.getByLabelText("Choose a scan: Anil Thapa"), new File(["%PDF-1.4"], "new.pdf", { type: "application/pdf" }));
    expect(await screen.findByText("The document now needs HR to verify it again against the new scan.")).toBeInTheDocument();
  });

  it("refuses a file over 15 MB before sending it", async () => {
    const u = renderAt("/masters/direct_passport");
    await within(await table()).findByText("Rahim Uddin");
    const big = new File(["%PDF-1.4"], "huge.pdf", { type: "application/pdf" });
    Object.defineProperty(big, "size", { value: 15 * 1024 * 1024 + 1 });
    await u.upload(screen.getByLabelText("Choose a scan: Rahim Uddin"), big);
    expect(await screen.findByText(/A scan can be at most 15 MB/)).toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith("/scan"))).toBe(false);
  });

  it("offers Add client only on master 18, to an account that may manage clients", async () => {
    me = FINANCE;
    const u = renderAt("/masters/client_registration");
    await u.click(await screen.findByRole("button", { name: "Add client" }));
    const form = await screen.findByRole("dialog", { name: "Add a client" });
    await u.type(within(form).getByLabelText("Legal name"), "Coastal Works LLC");
    await u.type(within(form).getByLabelText("CR number"), "3999001");
    await u.click(within(form).getByRole("button", { name: "Add client" }));
    await vi.waitFor(() => expect(sent("POST", "/api/clients")).toBeDefined());
    expect(JSON.parse(String(sent("POST", "/api/clients")!.init.body))).toEqual({ legalName: "Coastal Works LLC", crNumber: "3999001" });
  });

  it("does not offer Add client elsewhere, nor to an account that may not manage clients", async () => {
    me = FINANCE;
    renderAt("/masters/subcontractor_registration");
    expect(await screen.findByText("No sub-contractors yet. Operations or HR add them.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add client" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add sub-contractor" })).not.toBeInTheDocument();
  });

  it("hides Add client from HR, who may not manage clients", async () => {
    me = HR;
    renderAt("/masters/client_registration");
    await within(await table()).findByText("Batinah Steel");
    expect(screen.queryByRole("button", { name: "Add client" })).not.toBeInTheDocument();
  });

  it("explains an unknown master", async () => {
    renderAt("/masters/nothing");
    expect(await screen.findByText("There's no such master.")).toBeInTheDocument();
  });
});
