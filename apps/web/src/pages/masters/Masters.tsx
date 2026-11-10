/**
 * S-44 Document masters (PRD 4.19, A26): the eighteen registers in three groups (In House, Purchase,
 * Sales), each with its valid, due, expired and missing counts. `GET /api/masters` (masters.read).
 * Each master opens its register (S-45). Works at phone width for the owner.
 */
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { MasterGroup, MasterState, MasterSubject, MasterSummary } from "@mms/core";
import { ChevronRightIcon } from "lucide-react";
import { api } from "@/lib/api";
import { Page, PageHeader } from "@/components/page-header";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";

export interface MasterInfo {
  no: number;
  key: string;
  group: MasterGroup;
  label: string;
  subject: MasterSubject;
  documentType: string;
  documentLabel: string;
  requiredOfAll: boolean;
}
export interface MastersOverview {
  today: string;
  groups: { group: MasterGroup; label: string; masters: (MasterInfo & { summary: MasterSummary })[] }[];
}

/** One word and tone per state, the same on S-44 and S-45. */
export const STATE_BADGE: Record<MasterState, { tone: StatusTone; label: string }> = {
  expired: { tone: "expired", label: "Expired" },
  missing: { tone: "incomplete", label: "Missing" },
  no_expiry: { tone: "info", label: "No expiry date" },
  due: { tone: "due", label: "Due" },
  valid: { tone: "ok", label: "Valid" },
};

/** The counts worth a badge, most urgent first; zeros are left out. */
export function SummaryBadges({ summary }: { summary: MasterSummary }) {
  const parts: [number, StatusTone, string][] = [
    [summary.expired, "expired", "expired"],
    [summary.missing, "incomplete", "missing"],
    [summary.due, "due", "due"],
    [summary.valid, "ok", "valid"],
    [summary.noExpiry, "info", "no expiry date"],
    [summary.unverified, "draft", "not verified"],
  ];
  const shown = parts.filter(([n]) => n > 0);
  if (shown.length === 0) return <span className="text-sm text-muted-foreground">Nothing recorded yet</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {shown.map(([n, tone, word]) => (
        <StatusBadge key={word} tone={tone} className="tabular-nums">
          {n} {word}
        </StatusBadge>
      ))}
    </div>
  );
}

export function Masters() {
  const q = useQuery({ queryKey: ["masters"], queryFn: () => api.get<MastersOverview>("/api/masters") });
  const all = q.data?.groups.flatMap((g) => g.masters) ?? [];
  const total = (k: keyof MasterSummary) => all.reduce((n, m) => n + m.summary[k], 0);

  return (
    <Page>
      <PageHeader
        screen="S-44"
        title="Document masters"
        description="The company's own papers, its employees', its sub-contractors' and its clients', each in one register. Open a master to record, renew, verify or attach the scan."
      />

      {q.isError ? (
        <Alert variant="destructive">
          <AlertDescription>Couldn't load the masters. Check your connection, then reload.</AlertDescription>
        </Alert>
      ) : q.isPending ? (
        <Skeleton className="h-5 w-full max-w-xl" />
      ) : (
        <p className="text-sm text-pretty" aria-label="Summary">
          <span className="tabular-nums">{total("total")}</span> records across {all.length} masters:{" "}
          <span className="font-medium text-destructive tabular-nums">{total("expired")} expired</span>,{" "}
          <span className="font-medium tabular-nums">{total("missing")} missing</span>,{" "}
          <span className="tabular-nums">{total("due")} due for renewal</span> and{" "}
          <span className="tabular-nums">{total("unverified")} not yet verified</span>.
        </p>
      )}

      {q.isPending
        ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-40 w-full rounded-xl" />)
        : q.data?.groups.map((g) => (
            <section key={g.group} aria-labelledby={`group-${g.group}`} className="space-y-3">
              <h2 id={`group-${g.group}`} className="text-base font-semibold">
                {g.label}
              </h2>
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {g.masters.map((m) => (
                  <li key={m.key}>
                    <Link
                      to={`/masters/${m.key}`}
                      className="group flex h-full flex-col gap-2 rounded-xl border bg-card p-3 shadow-xs transition-colors outline-none hover:border-primary/40 focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <div className="flex items-start gap-2">
                        <span className="mt-0.5 inline-flex h-5 min-w-6 shrink-0 items-center justify-center rounded-md border bg-muted px-1 font-mono text-xs tabular-nums">{m.no}</span>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-balance">{m.label}</div>
                          <div className="text-xs text-muted-foreground tabular-nums">
                            {m.summary.total} {m.summary.total === 1 ? "record" : "records"}
                            {!m.requiredOfAll && " · holders only"}
                          </div>
                        </div>
                        <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 rtl:-scale-x-100" />
                      </div>
                      <SummaryBadges summary={m.summary} />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
    </Page>
  );
}
