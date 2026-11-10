/**
 * Upload and open a document's scan (PRD 4.19, A27, TR-SEC-12). Used by the master registers (S-45)
 * and the worker file (S-06). The API checks the real type from the bytes, scans for viruses and
 * audits every opening; the checks here only save a pointless upload.
 */
import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { EyeIcon, LoaderCircleIcon, UploadIcon } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";

export const SCAN_ACCEPT = ".pdf,.jpg,.jpeg,.png,.heic";
export const MAX_SCAN_BYTES = 15 * 1024 * 1024;
const TYPES: Record<string, string> = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic" };
const ALLOWED = new Set(Object.values(TYPES));

/** The file's type for `Content-Type`; browsers often report "" for HEIC, so fall back to the extension. */
export function scanType(file: File): string | null {
  if (ALLOWED.has(file.type)) return file.type;
  return TYPES[file.name.split(".").pop()?.toLowerCase() ?? ""] ?? null;
}

/** Why a file can't be sent, in plain words; null when it can. */
export function scanProblem(file: File): string | null {
  if (!scanType(file)) return "Only PDF, JPG, PNG or HEIC scans can be uploaded.";
  if (file.size > MAX_SCAN_BYTES) return `${file.name} is ${(file.size / 1_048_576).toFixed(1)} MB. A scan can be at most 15 MB.`;
  if (file.size === 0) return `${file.name} is empty.`;
  return null;
}

const failed = (what: string) => (e: unknown) =>
  toast.error(what, { description: e instanceof ApiError ? e.message : "The server didn't respond. Check your connection and try again." });

/** "Upload scan": a file picker that sends the file as the raw body to `path`. */
export function UploadScanButton({ path, label, wasVerified = false, onUploaded }: { path: string; label: string; wasVerified?: boolean; onUploaded?: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: (file: File) => api.upload<{ verified: boolean }>(path, { file, name: file.name, type: scanType(file)! }),
    onSuccess: (res) => {
      // A new scan from someone who may not verify un-verifies the document (the API decides).
      toast.success("Scan uploaded", {
        description: wasVerified && !res.verified ? "The document now needs HR to verify it again against the new scan." : "Every opening of it is recorded in the audit trail.",
      });
      onUploaded?.();
    },
    onError: failed("Couldn't upload the scan"),
  });
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={SCAN_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-label={`Choose a scan: ${label}`}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          const problem = scanProblem(file);
          if (problem) toast.error("Couldn't upload the scan", { description: problem });
          else upload.mutate(file);
        }}
      />
      <Button size="xs" variant="outline" aria-label={`Upload scan: ${label}`} disabled={upload.isPending} onClick={() => input.current?.click()}>
        {upload.isPending ? <LoaderCircleIcon aria-hidden className="animate-spin" /> : <UploadIcon aria-hidden />}
        Upload scan
      </Button>
    </>
  );
}

/**
 * Fetch the scan with the bearer token and open it in a new tab. Browsers can't show HEIC, so it is
 * downloaded instead. The object URL is revoked once the new tab has had time to load it.
 */
export async function openScan(path: string, name = "scan"): Promise<void> {
  const blob = await api.blob(path);
  const url = URL.createObjectURL(blob);
  if (blob.type === "image/heic") {
    const a = document.createElement("a");
    a.href = url;
    a.download = name.toLowerCase().endsWith(".heic") ? name : `${name}.heic`;
    a.click();
  } else {
    window.open(url, "_blank", "noopener");
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function ViewScanButton({ path, label, name }: { path: string; label: string; name?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="xs"
      variant="ghost"
      aria-label={`View scan: ${label}`}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        openScan(path, name).catch(failed("Couldn't open the scan")).finally(() => setBusy(false));
      }}
    >
      {busy ? <LoaderCircleIcon aria-hidden className="animate-spin" /> : <EyeIcon aria-hidden />}
      View scan
    </Button>
  );
}
