import { useQuery } from "@tanstack/react-query";
import { api, type RenewalItem } from "../lib/api";
import { RenewalTable } from "./Today";

export function Renewals() {
  const q = useQuery({ queryKey: ["renewals"], queryFn: () => api.get<{ items: RenewalItem[] }>("/api/compliance/renewals") });
  return (
    <div className="page">
      <header className="page-head">
        <h1>Renewals</h1>
        <p className="lede">Expired documents and everything expiring in the next 90 days, most urgent first.</p>
      </header>
      {q.isPending && <p className="muted">Loading…</p>}
      {q.isError && <p className="form-errors">Couldn't load renewals. Check the server is running.</p>}
      {q.data && q.data.items.length === 0 && <p className="empty">No renewals due in the next 90 days.</p>}
      {q.data && q.data.items.length > 0 && <RenewalTable items={q.data.items} label="All renewals" />}
    </div>
  );
}
