import type { WorkerComplianceState } from "@mms/core";

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function displayDate(value: string | null | undefined): string {
  return value ? DATE.format(new Date(`${value}T00:00:00Z`)) : "—";
}

export function describeExpiry(daysLeft: number): string {
  if (daysLeft < -1) return `Expired ${-daysLeft} days ago`;
  if (daysLeft === -1) return "Expired yesterday";
  if (daysLeft === 0) return "Expires today";
  if (daysLeft === 1) return "Expires tomorrow";
  return `Expires in ${daysLeft} days`;
}

export type TagTone = "green" | "yellow" | "red" | "none";

/** Compliance shown like site scaffold tags: green safe, yellow caution, red stop, none untagged. */
export function tagFor(state: WorkerComplianceState): { tone: TagTone; label: string } {
  switch (state) {
    case "ok":
      return { tone: "green", label: "In order" };
    case "due":
      return { tone: "yellow", label: "Renewal due" };
    case "expired":
      return { tone: "red", label: "Expired" };
    case "incomplete":
      return { tone: "none", label: "Papers missing" };
  }
}

/** Worker-level tag, coloured by the same 30-day rule as individual documents. */
export function workerTag(compliance: { state: WorkerComplianceState; nextExpiry: { daysLeft: number } | null }) {
  const tag = tagFor(compliance.state);
  if (compliance.state === "due" && compliance.nextExpiry && compliance.nextExpiry.daysLeft <= 30) {
    return { ...tag, tone: "red" as const };
  }
  return tag;
}

/** Show engine messages with dates the way the rest of the screen writes them. */
export function humaniseDates(message: string): string {
  return message.replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (iso) => displayDate(iso));
}

export function renewalTone(state: "expired" | "due" | "ok", daysLeft: number): TagTone {
  if (state === "expired") return "red";
  if (state === "due") return daysLeft <= 30 ? "red" : "yellow";
  return "green";
}

const STATUS_LABELS: Record<string, string> = {
  in_recruitment: "In recruitment",
  available: "Available",
  deployed: "Deployed",
  on_leave: "On leave",
  absconding_reported: "Absconding reported",
  exited: "Exited",
};

export const statusLabel = (status: string) => STATUS_LABELS[status] ?? status;
