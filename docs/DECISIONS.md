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

### D12 — Version 2 versus the extension modules
- **Question:** Version 2 took the slot of recruitment, camps and transport, welfare and biometrics (now Phase 12, from Feb 2028). Should any of them swap with the client portal or worker app?
- **Ask:** Owner. **Blocks:** Phase 11 planning only. **Raised:** 2026-11-02.

### D14 — Who sponsors the workers deployed today
- **Question:** List every establishment that sponsors a worker the company deploys today, related or sister companies included, with how many workers each holds and the basis each is used on now (Ministry authorisation, 730/2024 transfer, or neither). A worker under a sister company's CR is, in law, another employer's worker. Is any worker used today on a "free visa"?
- **Ask:** Owner with the HR/PRO lead. **Blocks:** the real sponsor register data at migration (S1–S3 inventory), not the build. **Raised:** 2026-11-09.

### D15 — Lawful routes for outsourced workers
- **Question:** (1) Does deploying the company's own workers to client sites need article 29 authorisation (per client, site or worker), or does the company's licence or CR activity cover it? If it does, every assignment needs the authorisation reference: this touches the core business, not only outsourcing. (2) Is supply between two manpower companies lawful under an article 29 authorisation alone, without a 730/2024 transfer, and what does the Ministry record? (3) Who registers a 730/2024 transfer, who holds the work permit during it, and how do gratuity, the 9 % savings system, SPF contributions and Omanisation counting apply to a transferred worker? (4) Article 87 discharges a wage only by transfer to the worker's bank account, and article 147 fines OMR 500–1,000 per worker; PRD 4.7 includes cash payment for unbanked workers. Is cash ever lawful now? (5) Which violations can be settled, and for how much?
- **Ask:** Labour lawyer. **Blocks:** TR-ENG-12 rule version and golden cases (S7); assignments (S8–S9) if (1) is yes; the cash list (S13–S14) if (4) is no. **Raised:** 2026-11-09. *Not blocking since A22: the build allows unauthorised engagements with owner approval behind one setting; this answer decides whether that setting moves to `block`.* *Researched 2026-11-09 from Labour Law 53/2023 (decree.om) and Ministerial Decision 730/2024 (qanoon.om); unofficial reproductions of the Official Gazette, to be confirmed.*

### D16 — Supply terms and VAT on labour bills
- **Question:** The terms agreed with outside sponsors today: rate per hour, day or month; who pays overtime; who provides accommodation, transport, food and PPE; minimum days; payment terms. VAT on labour bills: the standard 5 % is assumed (a `vat_code` per line, so a ruling changes data, not code), but no Tax Authority ruling on manpower supply was found. (The WPS-proof part is answered: A24.)
- **Ask:** Owner and finance lead; tax adviser for VAT. **Blocks:** the real agreement data and golden billing cases (S15), not the build. **Raised:** 2026-11-09.

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
| A16 | D11 Aceternity UI licence | Free components only, from the Design Brief's approved list (background beams, timeline, multi-step loader, animated tooltip; the number ticker is a small in-house `motion` counter). No Pro components | Sami | 2026-11-09 |
| A17 | Version 1 client demo | Build every V1 screen now as a demo foundation. Modules with an API (workers, documents, compliance, renewals, sites, audit) use it; the rest read a fictional, typed demo layer (`apps/web/src/demo/`) shaped like the Backend Schema and marked "Sample data" on screen, replaced module by module in each module's sprint | Sami | 2026-11-09 |
| A18 | Where shadcn components live | `apps/web/src/components/ui` (TR-CLI-02) rather than `packages/ui` (Design Brief, CLAUDE.md file map): only one app consumes them in V1. Move to `packages/ui` when `apps/mobile` starts (V2). Tokens are in `apps/web/src/styles.css` | Claude, delegated by Sami; to confirm at the next review | 2026-11-09 |
| A19 | D10 GitHub repository | **Public** repository on GitHub (raised as private). Public because Cloudflare's deploy button only works on public repositories; Sami chose it knowing the whole history, including `docs/spec/` (budget, plan, open decisions), becomes public. Still no real personal data in the repository (rule 10) | Sami | 2026-11-09 |
| A20 | Hosted client demo | Cloudflare Workers, static assets only (`wrangler.jsonc`, README button, `bun run deploy`). The `--mode demo` build answers the web's API calls in the browser (`apps/web/src/demo/server.ts`, same `@mms/core` engines, fictional data, per-visitor, resets on reload). Demo hosting only: production stays on AWS (A10). **Widened by A32 (2026-11-15):** the README button now deploys the full client demo with its own backend; this browser-only demo is served at its `/demo/` and is still deployable alone with `bun run deploy:demo` (`wrangler.demo.jsonc`) | Sami | 2026-11-09 |
| A21 | D13 Sponsors and outsourced workers | **Version 1**, folded into S4, S6, S7 and S15 (PRD 4.18) | Sami for the owner | 2026-11-09 |
| A22 | Workers without a Ministry authorisation (including "free visa") | **Allowed, with a warning and the owner's approval.** A fourth engagement, `free_visa`, joins own, supplied and transferred. A supplied or transferred worker with no authorisation for a date, and every free-visa worker, carries an "Unauthorised" badge; `checkEligibility` blocks them until the owner approves an override with a reason and an end date, and everything is audited. One setting (`outsourcing.unauthorised`: `allow_with_owner_approval` or `block`) moves to the law-following mode with no code change. Chosen by Sami and the client after the legal risk was explained (PRD section 6, D15) | Sami and the client | 2026-11-09 |
| A23 | How free-visa workers are paid | **Per worker:** the worker directly, from a cash pay list with a signed receipt, or a middleman or sponsor who invoices the company; both from the same locked hours times the agreed rate. Never through the company's WPS (it does not employ them) | Sami | 2026-11-09 |
| A24 | Proof that a supplying company paid its workers | **Required:** a labour bill from a sponsor company cannot be approved until its WPS proof for those workers for the previous month is attached | Sami | 2026-11-09 |
| A25 | Authentication | **The API's own identity service, the design of the company's hospital system (HMS), which its warehouse system (WMS) shares in simpler form**, replacing Amazon Cognito: Argon2id passwords; mandatory authenticator-app TOTP for office users (secrets sealed with AES-256-GCM under their own key, each code used once); 15-minute HS256 access tokens held in memory, signed with a separate key; opaque refresh tokens stored as SHA-256 in `user_sessions`, sent only in an httpOnly, Secure, SameSite=Strict cookie on `/api/auth`, rotated on every use with reuse detection; server-enforced 30-minute idle and 12-hour limits; 5 failures lock an account for 15 minutes, 20 per IP in 15 minutes return 429; every route declares a permission or is explicitly public (default deny); PostgreSQL row-level security by entity through `SET LOCAL ROLE mms_app`. Improves on both: no tokens in browser storage (WMS), separate signing and sealing keys and server-side idle timeout (HMS). The AWS region (D6) stays a deploy setting | Sami | 2026-11-09 |
| A26 | Document masters (PRD 4.19) | **Version 1, built now**: the eighteen masters in three groups (In House, Purchase, Sales), backend and screens (S-44, S-45), with the start of the real client register (code, legal name, CR number, VAT number, payment terms, status) so the client CR master holds real clients; the client screens S-12/S-13 move onto it in S6 | Sami | 2026-11-10 |
| A27 | Scans in the masters | **Stored now** for every master: uploaded through the API (PDF, JPG, PNG or HEIC up to 15 MB, the type checked from the file's bytes, TR-SEC-12) to local disk in development and S3 in production behind one interface; a file opens only once scanned clean, and every opening is audited. Uploading through the API replaces "S3 presigned URLs" in the S4 plan so the content is checked before it is stored | Sami (storage design: Claude, to confirm at the next review) | 2026-11-10 |
| A28 | Documents that block rostering | **Today's set plus Oman ID card and medical insurance**, for every worker, own or outsourced: passport, residence visa, labour card, medical fitness, Oman ID card, medical insurance. A Sohar gate pass blocks only on sites that require it | Sami | 2026-11-10 |
| A29 | Sub-contractors in the Purchase masters | **The outside sponsors** of PRD 4.18: one register, one record per company; the workers they sponsor are the indirect employees | Sami | 2026-11-10 |
| A30 | Who maintains the masters | HR/PRO record, renew and verify every master (`org_documents.manage`, `documents.verify`); operations also record client and sub-contractor papers (`org_documents.manage`), add clients (`clients.manage`, with finance) and sub-contractors (`sponsors.manage`); owner, operations, HR/PRO and finance see every master (`masters.read`, `clients.read`); opening a worker's passport, ID or other scan needs `pii.view` (TR-SEC-07), held by HR/PRO and the owner | Claude, delegated by Sami; to confirm at the next review | 2026-11-10 |
| A31 | Two-factor sign-in | **Optional for every account, admins included**, replacing "mandatory authenticator-app TOTP for office users" in A25 (TR-SEC-01): sign-in never asks anyone to set it up; each person turns it on in S-46 My account with an authenticator app (QR code or key, then a first code and their password, which counts toward the lockout like a sign-in; their other sessions end) and can turn it off there with their password and a fresh code (each wrong one counts toward the 5-failure lockout). Both are audited (`auth.two_factor_on`, `auth.two_factor_off`); a session alone can do neither. Whoever has it on is asked for a code at every sign-in; the admin's reset for a lost phone stays. `AUTH_REQUIRE_TOTP` is gone. Chosen knowing that an account without two-factor, an admin's included, is then protected by its password alone | Sami | 2026-11-11 |
| A32 | Cloudflare client demo with its own backend | The README's Deploy to Cloudflare button now sets up the **whole system** for client demos, **fictional data only** (A10 unchanged: production stays on AWS; widens A20). One Worker (`apps/cloudflare`, `wrangler.jsonc`) serves the web app at `/`, the browser-only demo of A20 at `/demo/`, and sends `/api/*` to one Cloudflare Container running `apps/api/Dockerfile` (Workers Paid plan). Database: an outside Postgres the deployer pastes (a free Neon project), since Cloudflare has none and a container's disk is wiped when it sleeps. Scans: an R2 bucket the button creates, reached through R2's S3 API with keys the deployer pastes; the test-signature scanner is allowed only when `DEPLOYMENT=cloudflare-demo`. The container's start migrates, seeds fictional data once and creates the six role accounts with the deployer's `DEMO_PASSWORD` (no forced change). Both auth keys are derived from one `APP_SECRET` (HKDF). The sign-in screen, and the header on wider screens, say the data is fictional. Cloudflare can't put two different buttons on one repo like this one, hence one deployment with `/demo/`; the browser-only demo alone stays deployable with `bun run deploy:demo` | Sami (purpose, database, scans, demo at /demo/); Claude (key derivation, shared demo password, start-up design) | 2026-11-15 |
