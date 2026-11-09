# DECISIONS

> Every question the build depends on, and who answers it. **A step that depends on an UNANSWERED decision is BLOCKED** (see `/architect` Step 2). Nobody, human or AI, picks a default for an UNANSWERED decision.
>
> When an answer arrives: move the entry to ANSWERED with the date, the answer and who decided, then unblock the step in `docs/PROGRESS.md`. Never delete an entry.

## UNANSWERED

### D1 — Approve the five non-negotiables as the acceptance bar
- **Question:** Does the owner accept the five non-negotiables in PRD §1 (zero lapsed documents; pay right and on time; every billable hour billed; workers kept informed; owner sees the business in one screen) as the bar for acceptance?
- **Ask:** Owner. **Blocks:** G0. **Raised:** 2026-10-13 (PRD).

### D2 — Name a business owner and deputy per module
- **Question:** Who signs requirements, golden cases and acceptance for HR/PRO, operations, payroll and finance, and who deputises with authority to sign?
- **Ask:** Owner. **Blocks:** G0; golden-case sign-off from S10. **Raised:** 2026-10-13.

### D3 — Approve the phased release plan and the parallel-payroll period
- **Question:** Approve the 14 phases, 8 gates and two months of parallel payroll (June and July 2027) before go-live?
- **Ask:** Owner. **Blocks:** G0. **Raised:** 2026-10-13.

### D4 — Confirm the kickoff date
- **Question:** Is Sunday 1 Nov 2026 the kickoff? Every date in the plan moves with it.
- **Ask:** Owner. **Blocks:** nothing technical; all dates. **Raised:** 2026-10-20.

### D5 — Client contacts in Version 2
- **Question:** Version 1 is office, owner and admin. The client portal (client contacts) was placed in Version 2, with clients signing emailed timesheet packs in Version 1. Confirm.
- **Ask:** Sami / owner. **Blocks:** S11 (client approval path). **Raised:** 2026-11-02. *Assumed in the specification; not yet confirmed.*

### D6 — AWS region
- **Question:** Which AWS Middle East region (UAE `me-central-1` or Bahrain `me-south-1`) does the PDPL cross-border transfer assessment approve?
- **Ask:** Owner with the data protection officer. **Blocks:** S1 landing zone, everything deployed. **Raised:** 2026-10-20.

### D7 — Office printers for the silent-print proof
- **Question:** Which printer models and drivers are in the office (payslips, ID cards), and when can the team test on them?
- **Ask:** Company IT contact. **Blocks:** S1 print proof. **Raised:** 2026-11-02.

### D8 — Bank Muscat WPS specification and test channel
- **Question:** The current WPS salary-file (SIF) specification and a test channel from Bank Muscat.
- **Ask:** Finance lead with Bank Muscat. **Blocks:** S1 WPS sample, S14 WPS file. **Raised:** 2026-10-20.

### D9 — Expatriate savings-system start date
- **Question:** The Social Protection Fund's start date for the 9 % savings system (latest 19 Jul 2027) and its contribution file format.
- **Ask:** Payroll officer / labour lawyer, watching official notices. **Blocks:** S12 rule version (built configurable; the date is the input). **Raised:** 2026-10-16.

### D10 — GitHub repository
- **Question:** Create an empty private repository so the code can be pushed and CI can run.
- **Ask:** Sami. **Blocks:** CI, branch protection, Windows installer builds. **Raised:** 2026-10-14.

### D11 — Aceternity UI licence
- **Question:** Confirm the licence terms for each free Aceternity component on the approved list, and whether any Pro component is wanted (paid).
- **Ask:** Sami. **Blocks:** any Aceternity component (first: owner dashboard number ticker, S16). **Raised:** 2026-11-02.

### D12 — Version 2 versus the extension modules
- **Question:** Version 2 took the slot of recruitment, camps and transport, welfare and biometrics (now Phase 12, from Feb 2028). Should any of them swap with the client portal or worker app?
- **Ask:** Owner. **Blocks:** Phase 11 planning only. **Raised:** 2026-11-02.

## ANSWERED

| # | Decision | Answer | Decided by | Date |
|---|---|---|---|---|
| A1 | Sector | Construction first | Owner | 2026-10-13 |
| A2 | Countries | Oman only today; data model multi-entity | Owner | 2026-10-13 |
| A3 | Accounting | Excel today, so the system has its own ledger | Owner | 2026-10-13 |
| A4 | WPS bank | Bank Muscat | Owner | 2026-10-13 |
| A5 | Camps and buses | Company runs its own; in scope (now Phase 12) | Owner | 2026-10-13 |
| A6 | Approach | Fully custom build, owned by the company | Owner | 2026-10-13 |
| A7 | Budget | OMR 40k+ for the launch scope | Owner | 2026-10-13 |
| A8 | Go-live | No fixed date; quality gates decide | Owner | 2026-10-13 |
| A9 | Language | English first; Arabic and workers' languages later | Owner | 2026-10-13 |
| A10 | Hosting | AWS | Client | 2026-10-13 |
| A11 | Platform | One React interface: Tauri desktop, web, Capacitor mobile (Option 3) | Sami | 2026-10-13 |
| A12 | Toolchain | Bun for package manager, API runtime and tests | Sami | 2026-10-14 |
| A13 | Interface library | shadcn/ui with Radix primitives; Aceternity only from the approved list | Sami | 2026-11-02 |
| A14 | Release scope | V1 office, owner, admin; V2 supervisor app, client portal, worker app | Sami | 2026-11-02 |
| A15 | V1 attendance | Printed daily sheets entered and checked in the office; supervisor app in V2 | Sami (via A14) | 2026-11-02 |
