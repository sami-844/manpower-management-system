import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { addDays, DOCUMENT_TYPES, documentLabel, type DocumentType } from "@mms/core";
import { api, ApiError, type EligibilityResult, type Site, type WorkerDetail } from "../lib/api";
import { describeExpiry, displayDate, humaniseDates, renewalTone, statusLabel, workerTag } from "../lib/format";
import { Tag } from "../components/Tag";
import { FieldErrors } from "../components/FieldErrors";

const todayInOman = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Muscat" }).format(new Date());

export function WorkerFile() {
  const { id = "" } = useParams();
  const worker = useQuery({ queryKey: ["worker", id], queryFn: () => api.get<WorkerDetail>(`/api/workers/${id}`) });

  if (worker.isPending) return <p className="muted">Loading worker…</p>;
  if (worker.isError) {
    const notFound = worker.error instanceof ApiError && worker.error.status === 404;
    return (
      <div className="empty">
        <p>{notFound ? "No worker with this ID." : "Couldn't load this worker. Check the server is running, then reload."}</p>
        <Link to="/workers">Back to workers</Link>
      </div>
    );
  }

  const w = worker.data;
  const tag = workerTag(w.compliance);
  return (
    <article className="page worker-file">
      <nav className="crumbs">
        <Link to="/workers">Workers</Link>
      </nav>
      <header className="file-head">
        <div>
          <h1>{w.fullName}</h1>
          <p className="file-meta">
            <span className="code">{w.code}</span>
            <span>{w.trade}</span>
            <span>{w.nationality}</span>
            <span>{statusLabel(w.status)}</span>
            {w.phone && <span>{w.phone}</span>}
          </p>
        </div>
        <Tag tone={tag.tone}>{tag.label}</Tag>
      </header>

      <div className="file-grid">
        <section aria-labelledby="docs-h">
          <h2 id="docs-h">Documents</h2>
          <DocumentsTable worker={w} />
          <AddDocument workerId={w.id} />
        </section>
        <aside>
          <EligibilityCheck workerId={w.id} />
        </aside>
      </div>
    </article>
  );
}

function DocumentsTable({ worker }: { worker: WorkerDetail }) {
  const qc = useQueryClient();
  const verify = useMutation({
    mutationFn: (docId: string) => api.patch(`/api/documents/${docId}/verify`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["worker", worker.id] }),
  });

  if (worker.documents.length === 0) {
    return <p className="empty">No documents yet. Add the passport, residence visa, labour card and medical below.</p>;
  }
  return (
    <table className="grid" aria-label="Documents">
      <thead>
        <tr>
          <th scope="col">Document</th>
          <th scope="col" className="hide-sm">Number</th>
          <th scope="col">Expiry</th>
          <th scope="col">Status</th>
          <th scope="col">Checked by HR</th>
        </tr>
      </thead>
      <tbody>
        {worker.documents.map((d) => (
          <tr key={d.id}>
            <th scope="row">{documentLabel(d.type)}</th>
            <td className="num hide-sm">{d.number ?? "—"}</td>
            <td className="num">{displayDate(d.expiryDate)}</td>
            <td>
              {d.renewal ? (
                <Tag tone={renewalTone(d.renewal.state, d.renewal.daysLeft)}>
                  {d.renewal.state === "ok" ? "Valid" : describeExpiry(d.renewal.daysLeft)}
                </Tag>
              ) : (
                <Tag tone="none">No expiry date</Tag>
              )}
            </td>
            <td>
              {d.verified ? (
                <span className="muted">Yes</span>
              ) : (
                <button
                  type="button"
                  className="btn btn-small"
                  aria-label={`Verify ${documentLabel(d.type)}`}
                  disabled={verify.isPending}
                  onClick={() => verify.mutate(d.id)}
                >
                  Verify
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AddDocument({ workerId }: { workerId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const add = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post(`/api/workers/${workerId}/documents`, body),
    onSuccess: () => {
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ["worker", workerId] });
      void qc.invalidateQueries({ queryKey: ["workers"] });
    },
  });

  if (!open) {
    return (
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        Add document
      </button>
    );
  }
  return (
    <form
      className="form-row"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        add.mutate({
          type: f.get("type"),
          number: f.get("number") || undefined,
          issueDate: f.get("issueDate") || undefined,
          expiryDate: f.get("expiryDate") || null,
        });
      }}
    >
      <label>
        Type
        <select name="type" required defaultValue="passport">
          {DOCUMENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {documentLabel(t)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Number
        <input name="number" autoComplete="off" />
      </label>
      <label>
        Issued
        <input name="issueDate" type="date" />
      </label>
      <label>
        Expires
        <input name="expiryDate" type="date" />
      </label>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={add.isPending}>
          Save document
        </button>
        <button type="button" className="btn btn-quiet" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <FieldErrors error={add.error} />
    </form>
  );
}

function EligibilityCheck({ workerId }: { workerId: string }) {
  const today = todayInOman();
  const sites = useQuery({ queryKey: ["sites"], queryFn: () => api.get<{ items: Site[] }>("/api/sites") });
  const check = useMutation({
    mutationFn: (body: { workerId: string; siteId?: string; from: string; to: string }) =>
      api.post<EligibilityResult>("/api/compliance/check", body),
  });

  return (
    <section className="panel" aria-labelledby="check-h">
      <h2 id="check-h">Can this worker be deployed?</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const siteId = String(f.get("siteId") ?? "");
          check.mutate({ workerId, ...(siteId ? { siteId } : {}), from: String(f.get("from")), to: String(f.get("to")) });
        }}
      >
        <label>
          Site
          <select name="siteId" defaultValue="">
            <option value="">Any site</option>
            {sites.data?.items.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <div className="pair">
          <label>
            From
            <input name="from" type="date" required defaultValue={today} />
          </label>
          <label>
            To
            <input name="to" type="date" required defaultValue={addDays(today, 30)} />
          </label>
        </div>
        <button type="submit" className="btn btn-primary" disabled={check.isPending}>
          Check eligibility
        </button>
      </form>
      <FieldErrors error={check.error} />
      {check.data && <EligibilityResultView result={check.data} />}
    </section>
  );
}

function EligibilityResultView({ result }: { result: EligibilityResult }) {
  return (
    <div className="result" role="status">
      <Tag tone={result.eligible ? "green" : "red"}>{result.eligible ? "Can be deployed" : "Cannot be deployed"}</Tag>
      {result.blockers.length > 0 && (
        <ul className="issues issues-block">
          {result.blockers.map((b, i) => (
            <li key={`${b.code}-${b.documentType ?? i}`}>{humaniseDates(b.message)}</li>
          ))}
        </ul>
      )}
      {result.warnings.length > 0 && (
        <>
          <h3>Also note</h3>
          <ul className="issues">
            {result.warnings.map((w, i) => (
              <li key={`${w.code}-${w.documentType ?? i}`}>{humaniseDates(w.message)}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export type { DocumentType };
