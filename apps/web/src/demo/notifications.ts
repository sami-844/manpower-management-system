/**
 * DEMO DATA — in-app notifications (Backend Schema `notifications`) and the approvals count
 * shown in the sidebar. Fictional; the Notifications and Approvals screens own the full lists.
 */
export type NotificationKind = "renewal" | "approval" | "timesheet" | "payroll" | "billing" | "system";

export interface DemoNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  /** Route that opens the subject. */
  to: string;
  at: string; // ISO timestamp
  read: boolean;
}

export const NOTIFICATIONS: DemoNotification[] = [
  { id: "n1", kind: "approval", title: "Payroll for October 2026 awaits your approval", body: "684 payslips · approved by finance at 10:42.", to: "/approvals", at: "2026-11-09T07:12:00Z", read: false },
  { id: "n2", kind: "renewal", title: "6 residence visas expire within 7 days", body: "Two workers are deployed at Sohar Port Phase 3.", to: "/renewals", at: "2026-11-09T05:30:00Z", read: false },
  { id: "n3", kind: "timesheet", title: "Daily sheet missing for Duqm Breakwater", body: "No photo filed for 8 Nov. The supervisor has been sent a reminder.", to: "/attendance", at: "2026-11-09T04:00:00Z", read: false },
  { id: "n4", kind: "billing", title: "Wadi Infrastructure Co. is over its credit limit", body: "OMR 27,410.250 outstanding against a 25,000.000 limit.", to: "/receivables", at: "2026-11-08T13:20:00Z", read: false },
  { id: "n5", kind: "approval", title: "Rate card v2 for Coastal Marine Works needs a second approver", body: "Requested by finance.lead.", to: "/approvals", at: "2026-11-08T10:05:00Z", read: true },
  { id: "n6", kind: "payroll", title: "WPS file accepted by Bank Muscat", body: "September 2026 run · 671 accepted, 0 rejected.", to: "/wps", at: "2026-10-04T09:15:00Z", read: true },
  { id: "n7", kind: "system", title: "Audit chain verified", body: "Nightly check passed for every event.", to: "/admin/audit", at: "2026-11-09T01:00:00Z", read: true },
];

export const unreadCount = NOTIFICATIONS.filter((n) => !n.read).length;

/** Items waiting in the Approvals inbox (S-33). Kept in step with the Approvals demo list. */
export const pendingApprovalsCount = 5;
