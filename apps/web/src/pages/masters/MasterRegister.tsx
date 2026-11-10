/**
 * S-45 Master register (PRD 4.19, A26-A30): one master, every company or worker it covers, the
 * document with the latest expiry and its state, most urgent first (`GET /api/masters/:key`).
 * Actions follow the account's permissions: record or renew, verify, upload and open the scan, and
 * add a sub-contractor (master 13) or a client (master 18). Worker numbers arrive masked.
 */
import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MasterState, MasterSummary } from "@mms/core";
import { ArrowLeftIcon, BadgeCheckIcon, Building2Icon, FilePlusIcon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { describeExpiry, displayDate, userLabel } from "@/lib/format";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { FieldErrors } from "@/components/FieldErrors";
import { Page, PageHeader } from "@/components/page-header";
import { createColumns, DataTable } from "@/components/data-table";
import { StatusBadge } from "@/components/status-badge";
import { UploadScanButton, ViewScanButton } from "@/components/scan-actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { STATE_BADGE, type MasterInfo } from "./Masters";

interface RegisterRow {
  subject: { id: string; kind: string; name: string; code: string | null; status: string | null; engagement: string | null; sponsorName: string | null };
  document: {
    id: string;
    number: string | null;
    issueDate: string | null;
    expiryDate: string | null;
    verified: boolean;
    verifiedBy: string | null;
    verifiedAt: string | null;
    hasScan: boolean;
    scanStatus: string | null;
  } | null;
  state: MasterState;
  daysLeft: number | null;
}
interface Register {
  today: string;
  master: MasterInfo;
  summary: MasterSummary;
  rows: RegisterRow[];
}

const ENGAGEMENT: Record<string, string> = { own: "Own employee", supplied: "Supplied", transferred: "Transferred", free_visa: "Free visa" };

const FILTERS: { key: string; label: string; count: (s: MasterSummary) => number; test: (r: RegisterRow) => boolean }[] = [
  { key: "expired", label: "Expired", count: (s) => s.expired, test: (r) => r.state === "expired" },
  { key: "missing", label: "Missing", count: (s) => s.missing, test: (r) => r.state === "missing" },
  { key: "due", label: "Due", count: (s) => s.due, test: (r) => r.state === "due" },
  { key: "valid", label: "Valid", count: (s) => s.valid, test: (r) => r.state === "valid" },
  { key: "no_expiry", label: "No expiry date", count: (s) => s.noExpiry, test: (r) => r.state === "no_expiry" },
  { key: "unverified", label: "Not verified", count: (s) => s.unverified, test: (r) => !!r.document && !r.document.verified },
];

function daysInWords(r: RegisterRow): string {
  if (r.state === "missing") return "Not recorded";
  if (r.daysLeft === null) return "Does not expire";
  return describeExpiry(r.daysLeft);
}

const SCAN_WORDS: Record<string, { tone: "ok" | "info" | "blocked"; label: string }> = {
  clean: { tone: "ok", label: "Scan on file" },
  pending: { tone: "info", label: "Being virus-checked" },
  infected: { tone: "blocked", label: "Rejected by virus check" },
};

const isWorker = (m: MasterInfo) => m.subject === "direct_employee" || m.subject === "indirect_employee";

/** Who a recorded document belongs to, and where it is sent. */
interface Target {
  name: string;
  workerId?: string;
  renewing: boolean;
}

function orgSubject(master: MasterInfo, subjectId?: string) {
  if (master.subject === "subcontractor") return { kind: "subcontractor", sponsorId: subjectId };
  if (master.subject === "client") return { kind: "client", clientId: subjectId };
  return { kind: "company" };
}

export function MasterRegister() {
  const { key = "" } = useParams();
  const qc = useQueryClient();
  const { allows } = useSession();
  const [params, setParams] = useSearchParams();
  const filter = params.get("state") ?? "";
  const [recording, setRecording] = useState<(Target & { subjectId?: string }) | null>(null);
  const [adding, setAdding] = useState(false);

  const q = useQuery({ queryKey: ["masters", key], queryFn: () => api.get<Register>(`/api/masters/${encodeURIComponent(key)}`) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["masters"] });

  const verify = useMutation({
    mutationFn: (docId: string) => api.patch(isWorker(q.data!.master) ? `/api/documents/${docId}/verify` : `/api/organisation-documents/${docId}/verify`),
    onSuccess: () => {
      toast.success("Verified", { description: "Recorded in the audit trail with your name." });
      refresh();
    },
    onError: (e) => toast.error("Couldn't verify", { description: e instanceof ApiError ? e.message : "The server didn't respond. Try again." }),
  });

  const rows = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter);
    return (q.data?.rows ?? []).filter((r) => !f || f.test(r));
  }, [q.data, filter]);

  if (q.isError) {
    const unknown = q.error instanceof ApiError && q.error.code === "UNKNOWN_MASTER";
    return (
      <Page>
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>{unknown ? "There's no such master." : "Couldn't load this master."}</EmptyTitle>
            <EmptyDescription>{unknown ? "The link may be out of date. Pick one of the eighteen masters." : "Check your connection, then reload."}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" size="sm" asChild>
              <Link to="/masters">
                <ArrowLeftIcon aria-hidden className="rtl:-scale-x-100" />
                All masters
              </Link>
            </Button>
          </EmptyContent>
        </Empty>
      </Page>
    );
  }

  const master = q.data?.master;
  const worker = master ? isWorker(master) : false;
  // The company's own papers are HR's alone (A30): operations record clients' and sub-contractors' only.
  const canRecord = allows(worker ? "documents.create" : master?.subject === "company" ? "company_documents.manage" : "org_documents.manage");
  const canVerify = allows("documents.verify");
  const canView = allows(worker ? "pii.view" : "masters.read");
  const scanBase = worker ? "/api/documents" : "/api/organisation-documents";
  const addKind = master?.key === "subcontractor_registration" && allows("sponsors.manage") ? "subcontractor" : master?.key === "client_registration" && allows("clients.manage") ? "client" : null;

  const col = createColumns<RegisterRow>();
  const columns = col.columns([
    col.accessor((r) => r.subject.name, {
      id: "subject",
      header: worker ? "Employee" : master?.subject === "company" ? "Company" : master?.subject === "client" ? "Client" : "Sub-contractor",
      cell: ({ row }) => {
        const s = row.original.subject;
        return (
          <div className="leading-tight">
            {worker ? (
              <Link to={`/workers/${s.id}`} className="font-medium hover:underline">
                {s.name}
              </Link>
            ) : (
              <span className="font-medium">{s.name}</span>
            )}
            <div className="text-xs text-muted-foreground">
              {s.code && <span className="font-mono">{s.code}</span>}
              {worker && s.engagement && ` · ${ENGAGEMENT[s.engagement] ?? s.engagement}${s.engagement !== "own" && s.sponsorName ? `: ${s.sponsorName}` : ""}`}
            </div>
          </div>
        );
      },
    }),
    col.accessor((r) => r.document?.number ?? "", { id: "number", header: "Number", cell: (c) => <span className="font-mono text-xs tabular-nums">{c.getValue() || "—"}</span> }),
    col.accessor((r) => r.document?.issueDate ?? "", { id: "issued", header: "Issued", cell: (c) => <span className="tabular-nums">{displayDate(c.getValue() || null)}</span> }),
    col.accessor((r) => r.document?.expiryDate ?? "", { id: "expires", header: "Expires", cell: (c) => <span className="tabular-nums">{displayDate(c.getValue() || null)}</span> }),
    col.accessor((r) => r.daysLeft ?? Number.MAX_SAFE_INTEGER, { id: "days", header: "Days left", cell: ({ row }) => <span className="text-sm tabular-nums">{daysInWords(row.original)}</span> }),
    col.accessor("state", { header: "Status", cell: (c) => <StatusBadge tone={STATE_BADGE[c.getValue()].tone}>{STATE_BADGE[c.getValue()].label}</StatusBadge> }),
    col.display({
      id: "verified",
      header: "Verified",
      cell: ({ row }) => {
        const d = row.original.document;
        if (!d) return <span className="text-muted-foreground">—</span>;
        if (d.verified)
          return (
            <span className="inline-flex items-center gap-1.5 text-sm">
              <BadgeCheckIcon aria-hidden className="size-4 text-success" />
              {d.verifiedBy ? userLabel(d.verifiedBy) : "Verified"}
            </span>
          );
        return canVerify ? (
          <Button size="xs" variant="outline" aria-label={`Verify: ${row.original.subject.name}`} disabled={verify.isPending} onClick={() => verify.mutate(d.id)}>
            Verify
          </Button>
        ) : (
          <StatusBadge tone="draft">Not verified</StatusBadge>
        );
      },
    }),
    col.display({
      id: "scan",
      header: "Scan",
      cell: ({ row }) => {
        const d = row.original.document;
        const s = d?.hasScan ? SCAN_WORDS[d.scanStatus ?? "pending"] : null;
        return s ? <StatusBadge tone={s.tone}>{s.label}</StatusBadge> : <span className="text-sm text-muted-foreground">{d ? "No scan" : "—"}</span>;
      },
    }),
    col.display({
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => {
        const r = row.original;
        const d = r.document;
        const name = r.subject.name;
        return (
          <div className="flex flex-wrap items-center justify-end gap-1">
            {canRecord && (
              <Button
                size="xs"
                variant="outline"
                aria-label={`${d ? "Renew" : "Record"}: ${name}`}
                onClick={() => setRecording({ name, workerId: worker ? r.subject.id : undefined, subjectId: r.subject.id, renewing: !!d })}
              >
                {d ? <RefreshCwIcon aria-hidden /> : <FilePlusIcon aria-hidden />}
                {d ? "Renew" : "Record"}
              </Button>
            )}
            {d && canRecord && <UploadScanButton path={`${scanBase}/${d.id}/scan`} label={name} wasVerified={d.verified} onUploaded={refresh} />}
            {d?.hasScan && d.scanStatus === "clean" && canView && <ViewScanButton path={`${scanBase}/${d.id}/scan`} label={name} name={`${master?.documentLabel ?? "scan"} - ${name}`} />}
          </div>
        );
      },
    }),
  ]);

  const emptyText = (() => {
    if (filter) return "Nothing in this state. Clear the filter to see every record.";
    if (!master) return "";
    if (master.subject === "company") return "The company's papers aren't recorded yet. Use “Record document” to add the first.";
    if (master.subject === "subcontractor") return addKind ? "No sub-contractors yet. Add one to start this register." : "No sub-contractors yet. Operations or HR add them.";
    if (master.subject === "client") return addKind ? "No clients yet. Add a client to start this register." : "No clients yet. Operations or finance add them.";
    if (!master.requiredOfAll) return "No one holds this document yet. Record it from the worker's file when one is issued.";
    return master.subject === "direct_employee" ? "No direct employees are active today." : "No indirect employees today. They appear once a sub-contractor supplies a worker.";
  })();

  return (
    <Page>
      <PageHeader
        screen="S-45"
        title={master ? master.label : "Master"}
        description={master ? `Every ${worker ? "employee" : master.subject === "company" ? "paper of the company" : master.subject === "client" ? "client" : "sub-contractor"} this master covers, with the latest ${master.documentLabel.toLowerCase()} and its state, most urgent first.` : undefined}
        meta={
          master && (
            <>
              <span className="rounded-md border bg-muted px-1.5 py-0.5 font-mono text-xs tabular-nums">Master {master.no}</span>
              {!master.requiredOfAll && <span className="text-sm text-muted-foreground">Holders only: no one counts as missing</span>}
            </>
          )
        }
        actions={
          master && (
            <>
              {addKind && (
                <Button onClick={() => setAdding(true)}>
                  <Building2Icon aria-hidden />
                  {addKind === "client" ? "Add client" : "Add sub-contractor"}
                </Button>
              )}
              {master.subject === "company" && canRecord && (q.data?.rows.length ?? 0) === 0 && (
                <Button onClick={() => setRecording({ name: "the company", renewing: false })}>
                  <FilePlusIcon aria-hidden />
                  Record document
                </Button>
              )}
            </>
          )
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" role="group" aria-label="Filter by state">
        {FILTERS.map((f) => {
          const pressed = filter === f.key;
          const n = q.data ? f.count(q.data.summary) : null;
          return (
            <button
              key={f.key}
              type="button"
              aria-pressed={pressed}
              onClick={() => setParams(pressed ? {} : { state: f.key }, { replace: true })}
              className={cn(
                "flex flex-col items-start gap-1 rounded-xl border bg-card p-3 text-start shadow-xs transition-colors outline-none hover:border-primary/40 focus-visible:ring-3 focus-visible:ring-ring/50",
                pressed && "border-primary ring-1 ring-primary",
              )}
            >
              <span className="text-xs font-medium text-muted-foreground">{f.label}</span>
              <span className={cn("text-2xl font-semibold tabular-nums", (f.key === "expired" || f.key === "missing") && !!n && "text-destructive")}>{n ?? "…"}</span>
            </button>
          );
        })}
      </div>

      <DataTable
        label="Register"
        columns={columns}
        data={rows}
        loading={q.isPending}
        getRowId={(r) => r.subject.id}
        search={(r, s) => r.subject.name.toLowerCase().includes(s) || (r.subject.code ?? "").toLowerCase().includes(s)}
        searchPlaceholder="Search name or code"
        toolbar={
          <div className="flex items-center gap-2">
            {filter && (
              <Button variant="ghost" size="sm" onClick={() => setParams({}, { replace: true })}>
                Clear filter
              </Button>
            )}
            <span className="text-sm text-muted-foreground tabular-nums">{q.data ? `${rows.length} of ${q.data.rows.length}` : ""}</span>
          </div>
        }
        empty={emptyText}
        pageSize={50}
      />

      {master && recording && <RecordDialog master={master} target={recording} onClose={() => setRecording(null)} />}
      {addKind && <AddOrganisationDialog kind={addKind} open={adding} onOpenChange={setAdding} />}
    </Page>
  );
}

function RecordDialog({ master, target, onClose }: { master: MasterInfo; target: Target & { subjectId?: string }; onClose: () => void }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (f: { number?: string; issueDate?: string; expiryDate: string | null }) =>
      target.workerId
        ? api.post(`/api/workers/${target.workerId}/documents`, { type: master.documentType, ...f })
        : api.post("/api/organisation-documents", { subject: orgSubject(master, target.subjectId), type: master.documentType, ...f }),
    onSuccess: () => {
      toast.success(`${master.documentLabel} ${target.renewing ? "renewed" : "recorded"}`, { description: "It shows as not verified until HR checks it against the original." });
      void qc.invalidateQueries({ queryKey: ["masters"] });
      if (target.workerId) {
        void qc.invalidateQueries({ queryKey: ["worker", target.workerId] });
        void qc.invalidateQueries({ queryKey: ["workers"] });
        void qc.invalidateQueries({ queryKey: ["renewals"] });
      }
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {target.renewing ? "Renew" : "Record"} {master.documentLabel.toLowerCase()} for {target.name}
          </DialogTitle>
          <DialogDescription>
            Enter the details exactly as printed. {target.renewing ? "The new document replaces the old one in this register; the old one stays on record." : ""}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const text = (k: string) => String(f.get(k) ?? "").trim() || undefined;
            save.mutate({ number: text("number"), issueDate: text("issueDate"), expiryDate: text("expiryDate") ?? null });
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="master-number">Number</Label>
            <Input id="master-number" name="number" autoComplete="off" className="font-mono" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="master-issued">Issued</Label>
              <Input id="master-issued" name="issueDate" type="date" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="master-expires">Expires</Label>
              <Input id="master-expires" name="expiryDate" type="date" />
            </div>
          </div>
          <FieldErrors error={save.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              Save document
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AddOrganisationDialog({ kind, open, onOpenChange }: { kind: "client" | "subcontractor"; open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const client = kind === "client";
  const add = useMutation({
    mutationFn: (body: Record<string, string | undefined>) => api.post(client ? "/api/clients" : "/api/sponsors", body),
    onSuccess: (_, body) => {
      toast.success(`${body.legalName} added`, { description: "Now record its company registration certificate." });
      void qc.invalidateQueries({ queryKey: ["masters"] });
      onOpenChange(false);
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) add.reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{client ? "Add a client" : "Add a sub-contractor"}</DialogTitle>
          <DialogDescription>{client ? "The client joins the register (S-12) with a C- code." : "The sub-contractor is recorded as an outside sponsor, whose workers are indirect employees."}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const text = (k: string) => String(f.get(k) ?? "").trim() || undefined;
            add.mutate(
              client
                ? { legalName: text("legalName"), crNumber: text("crNumber"), vatNumber: text("vatNumber") }
                : { legalName: text("legalName"), crNumber: text("crNumber"), molEstablishmentNo: text("molEstablishmentNo") },
            );
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="org-name">Legal name</Label>
            <Input id="org-name" name="legalName" required minLength={2} autoComplete="off" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="org-cr">CR number</Label>
            <Input id="org-cr" name="crNumber" autoComplete="off" className="font-mono" />
          </div>
          {client ? (
            <div className="grid gap-1.5">
              <Label htmlFor="org-vat">VAT number</Label>
              <Input id="org-vat" name="vatNumber" autoComplete="off" className="font-mono" />
            </div>
          ) : (
            <div className="grid gap-1.5">
              <Label htmlFor="org-mol">Ministry of Labour establishment number</Label>
              <Input id="org-mol" name="molEstablishmentNo" autoComplete="off" className="font-mono" />
            </div>
          )}
          <FieldErrors error={add.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={add.isPending}>
              {client ? "Add client" : "Add sub-contractor"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
