import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { documentLabel } from "@mms/core";
import { api, type DashboardSummary, type RenewalItem } from "../lib/api";
import { describeExpiry, displayDate, renewalTone } from "../lib/format";
import { Tag } from "../components/Tag";

/** HR/PRO's morning: what needs doing today, not a wall of charts (PRD §3). */
export function Today() {
  const summary = useQuery({ queryKey: ["summary"], queryFn: () => api.get<DashboardSummary>("/api/dashboard/summary") });
  const renewals = useQuery({ queryKey: ["renewals"], queryFn: () => api.get<{ items: RenewalItem[] }>("/api/compliance/renewals") });

  const urgent = renewals.data?.items.filter((r) => r.daysLeft <= 30) ?? [];
  const s = summary.data;

  return (
    <div className="page">
      <header className="page-head">
        <h1>Today{s ? `, ${displayDate(s.today)}` : ""}</h1>
        {s && (
          <p className="lede">
            {urgent.length === 0
              ? "No documents need action in the next 30 days."
              : `${urgent.length} documents need action in the next 30 days.`}
          </p>
        )}
      </header>

      {s && (
        <section className="tag-board" aria-label="Workers by paper status">
          <Link to="/workers?compliance=expired" className="board-item">
            <Tag tone="red">Expired</Tag>
            <strong>{s.byCompliance.expired}</strong>
            <span>workers can't be deployed</span>
          </Link>
          <Link to="/workers?compliance=incomplete" className="board-item">
            <Tag tone="none">Papers missing</Tag>
            <strong>{s.byCompliance.incomplete}</strong>
            <span>files to complete</span>
          </Link>
          <Link to="/workers?compliance=due" className="board-item">
            <Tag tone="yellow">Renewal due</Tag>
            <strong>{s.byCompliance.due}</strong>
            <span>expiring within 90 days</span>
          </Link>
          <Link to="/workers?compliance=ok" className="board-item">
            <Tag tone="green">In order</Tag>
            <strong>{s.byCompliance.ok}</strong>
            <span>of {s.headcount} workers</span>
          </Link>
        </section>
      )}

      <section aria-labelledby="urgent-h">
        <h2 id="urgent-h">Act on these first</h2>
        {renewals.isPending && <p className="muted">Loading…</p>}
        {renewals.isError && <p className="form-errors">Couldn't load renewals. Check the server is running.</p>}
        {renewals.data && urgent.length === 0 && <p className="empty">Nothing expires in the next 30 days.</p>}
        {urgent.length > 0 && <RenewalTable items={urgent} label="Urgent renewals" />}
        {renewals.data && renewals.data.items.length > urgent.length && (
          <p>
            <Link to="/renewals">See all {renewals.data.items.length} renewals due in 90 days</Link>
          </p>
        )}
      </section>
    </div>
  );
}

export function RenewalTable({ items, label }: { items: RenewalItem[]; label: string }) {
  return (
    <table className="grid" aria-label={label}>
      <thead>
        <tr>
          <th scope="col">Worker</th>
          <th scope="col" className="hide-sm">Document</th>
          <th scope="col">Expiry</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {items.map((r) => (
          <tr key={r.id}>
            <th scope="row">
              <Link to={`/workers/${r.workerId}`}>{r.workerName}</Link>
              <span className="code">{r.workerCode}</span>
              <span className="code show-sm">{documentLabel(r.type)}</span>
            </th>
            <td className="hide-sm">{documentLabel(r.type)}</td>
            <td className="num">{displayDate(r.expiryDate)}</td>
            <td>
              <Tag tone={renewalTone(r.state, r.daysLeft)}>{describeExpiry(r.daysLeft)}</Tag>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
