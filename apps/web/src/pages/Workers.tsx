import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { documentLabel } from "@mms/core";
import { api, type WorkerListItem } from "../lib/api";
import { describeExpiry, statusLabel, workerTag } from "../lib/format";
import { Tag } from "../components/Tag";
import { FieldErrors } from "../components/FieldErrors";

const FILTERS = [
  { value: "", label: "All" },
  { value: "expired", label: "Expired" },
  { value: "incomplete", label: "Papers missing" },
  { value: "due", label: "Renewal due" },
  { value: "ok", label: "In order" },
];

export function Workers() {
  const [params, setParams] = useSearchParams();
  const search = params.get("search") ?? "";
  const compliance = params.get("compliance") ?? "";
  const [adding, setAdding] = useState(false);

  const q = useQuery({
    queryKey: ["workers", search, compliance],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (search) qs.set("search", search);
      if (compliance) qs.set("compliance", compliance);
      return api.get<{ total: number; items: WorkerListItem[] }>(`/api/workers?${qs}`);
    },
    placeholderData: keepPreviousData,
  });

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <div className="page">
      <header className="page-head page-head-row">
        <h1>Workers</h1>
        <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
          Add worker
        </button>
      </header>
      {adding && <NewWorker onClose={() => setAdding(false)} />}

      <div className="toolbar">
        <label className="search">
          <span className="visually-hidden">Search workers</span>
          <input
            type="search"
            placeholder="Search by name or code"
            defaultValue={search}
            onChange={(e) => update("search", e.target.value.trim())}
          />
        </label>
        <div className="filters" role="group" aria-label="Filter by paper status">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className="chip"
              aria-pressed={compliance === f.value}
              onClick={() => update("compliance", f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {q.isError && <p className="form-errors">Couldn't load workers. Check the server is running, then reload.</p>}
      {q.data && (
        <>
          <p className="muted count">{q.data.total === 1 ? "1 worker" : `${q.data.total} workers`}</p>
          {q.data.items.length === 0 ? (
            <p className="empty">No workers match. Clear the search or choose another filter.</p>
          ) : (
            <table className="grid" aria-label="Workers" aria-busy={q.isPlaceholderData} data-loading={q.isPlaceholderData || undefined}>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col" className="hide-sm">Trade</th>
                  <th scope="col" className="hide-sm">Status</th>
                  <th scope="col">Papers</th>
                  <th scope="col" className="hide-sm">Next expiry</th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((w) => {
                  const tag = workerTag(w.compliance);
                  const next = w.compliance.nextExpiry;
                  const nextText =
                    w.compliance.missing.length > 0
                      ? `Missing ${w.compliance.missing.map(documentLabel).join(", ").toLowerCase()}`
                      : next
                        ? `${documentLabel(next.type)}: ${describeExpiry(next.daysLeft).toLowerCase()}`
                        : "—";
                  return (
                    <tr key={w.id}>
                      <th scope="row">
                        <Link to={`/workers/${w.id}`}>{w.fullName}</Link>
                        <span className="code">{w.code}</span>
                        <span className="code show-sm">{nextText}</span>
                      </th>
                      <td className="hide-sm">{w.trade}</td>
                      <td className="hide-sm">{statusLabel(w.status)}</td>
                      <td>
                        <Tag tone={tag.tone}>{tag.label}</Tag>
                      </td>
                      <td className="hide-sm">{nextText}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

function NewWorker({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<{ id: string }>("/api/workers", body),
    onSuccess: (w) => {
      void qc.invalidateQueries({ queryKey: ["workers"] });
      void qc.invalidateQueries({ queryKey: ["summary"] });
      navigate(`/workers/${w.id}`);
    },
  });
  return (
    <form
      className="panel form-row"
      aria-label="New worker"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        create.mutate({
          fullName: f.get("fullName"),
          nationality: f.get("nationality"),
          trade: f.get("trade"),
          phone: f.get("phone") || undefined,
        });
      }}
    >
      <label>
        Full name
        <input name="fullName" required autoFocus autoComplete="off" />
      </label>
      <label>
        Nationality
        <input name="nationality" required list="nationalities" />
        <datalist id="nationalities">
          <option>Bangladesh</option>
          <option>India</option>
          <option>Nepal</option>
          <option>Pakistan</option>
        </datalist>
      </label>
      <label>
        Trade
        <input name="trade" required />
      </label>
      <label>
        Phone
        <input name="phone" type="tel" />
      </label>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={create.isPending}>
          Create worker
        </button>
        <button type="button" className="btn btn-quiet" onClick={onClose}>
          Cancel
        </button>
      </div>
      <FieldErrors error={create.error} />
    </form>
  );
}
