import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { desktop, JOB_TYPES, saveProfile, savedProfiles, type JobType, type PrinterProfile, type RenderMode } from "../lib/desktop";

/** Desktop only: which printer each kind of job goes to on this PC, printed with no dialogs. */
export function Printers() {
  const printers = useQuery({ queryKey: ["printers"], queryFn: desktop.listPrinters });
  const [profiles, setProfiles] = useState(savedProfiles());
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const fallback = printers.data?.find((p) => p.is_default)?.name ?? printers.data?.[0]?.name ?? "";
  const profileFor = (job: JobType): PrinterProfile => profiles[job] ?? { printer: fallback, mode: "direct" };

  const update = (job: JobType, change: Partial<PrinterProfile>) => {
    const next = { ...profileFor(job), ...change };
    saveProfile(job, next);
    setProfiles((p) => ({ ...p, [job]: next }));
  };

  const testPrint = async (profile: PrinterProfile) => {
    setBusy(true);
    setMessage(null);
    try {
      const report = await desktop.printTestPage(profile);
      setMessage(
        report.failed.length
          ? { ok: false, text: `The printer refused the test page: ${report.failed[0]![1]}` }
          : { ok: true, text: `Test page sent to ${profile.printer}.` },
      );
    } catch (err) {
      setMessage({ ok: false, text: String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1>Printers</h1>
        <p className="lede">
          Choose where each kind of document prints on this PC. Batches print straight to the printer with no dialog.
        </p>
      </header>

      {printers.isPending && <p className="muted">Looking for printers…</p>}
      {printers.isError && <p className="form-errors">Couldn't read this PC's printers: {String(printers.error)}</p>}
      {printers.data?.length === 0 && (
        <p className="empty">No printers are installed on this PC. Add one in Windows Settings, then reopen this page.</p>
      )}

      {printers.data && printers.data.length > 0 && (
        <table className="grid" aria-label="Printer for each job">
          <thead>
            <tr>
              <th scope="col">Job</th>
              <th scope="col">Printer</th>
              <th scope="col">Send as</th>
              <th scope="col">
                <span className="visually-hidden">Test</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {JOB_TYPES.map((job) => {
              const profile = profileFor(job.key);
              return (
                <tr key={job.key}>
                  <th scope="row">{job.label}</th>
                  <td>
                    <select
                      aria-label={`${job.label} printer`}
                      value={profile.printer}
                      onChange={(e) => update(job.key, { printer: e.target.value })}
                    >
                      {printers.data.map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.name}
                          {p.is_default ? " (Windows default)" : ""}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      aria-label={`${job.label} format`}
                      value={profile.mode}
                      onChange={(e) => update(job.key, { mode: e.target.value as RenderMode })}
                    >
                      <option value="direct">PDF (most printers)</option>
                      <option value="post_script">PostScript (older printers)</option>
                    </select>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={busy || !profile.printer}
                      aria-label={`Print test page on ${job.label} printer`}
                      onClick={() => testPrint(profile)}
                    >
                      Print test page
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {message &&
        (message.ok ? (
          <p role="status" className="notice">
            {message.text}
          </p>
        ) : (
          <p role="alert" className="form-errors">
            {message.text}
          </p>
        ))}
    </div>
  );
}
