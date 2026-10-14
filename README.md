# Workforce — manpower management system

The system of record for a ~700-worker construction manpower company in Oman: every
worker's papers, every client site, every hour, every payslip. This repository is the
first working slice: worker files, document compliance, renewals, the office web app and
the Windows desktop shell with silent printing.

The full product requirements and technical spec are in the shared doc
"Manpower Management System — PRD & Technical Spec". Rules for AI agents and developers
are in [CLAUDE.md](CLAUDE.md).

## What works today

| Area | What you can do |
| --- | --- |
| Workers | Add workers, search by name or code, filter by paper status |
| Documents | Record passport, visa, labour card, medical and others; HR verifies each one |
| Compliance | Ask "can this worker be deployed at this site on these dates?" and get every reason in plain words |
| Renewals | HR/PRO's morning list: expired and expiring documents, most urgent first (90/60/30/7-day tiers) |
| Overrides | Exceptions need a named approver, a reason and an end date; inactive workers can never be overridden |
| Audit | Every change is recorded with who, when, before and after, in a hash-chained log the database refuses to edit |
| Desktop | Windows app wrapping the same screens; prints batches to a chosen printer with no dialog |

Not built yet (next slices, in PRD order): sign-in with Amazon Cognito, clients and rate
cards, rostering, timesheets, payroll and WPS, billing, ledger, supervisor mobile app.

## Layout

```
packages/core        Domain engines (compliance, renewals, money) — pure TypeScript, no I/O
apps/api             NestJS API on PostgreSQL 16 (Drizzle, numbered SQL migrations)
apps/web             The shared interface: React + Vite, used by web, desktop and mobile
apps/desktop
  print-spooler      Rust library: silent batch printing (Windows spooler / CUPS)
  src-tauri          Tauri 2 desktop shell
```

## Run it locally

Needs Node 22, pnpm 10 and PostgreSQL 16 (or Docker).

```bash
pnpm install
docker compose up -d            # or use a local PostgreSQL with user/password mms
pnpm db:migrate
pnpm db:seed                    # 120 fictional workers and 3 sites
pnpm dev:api                    # http://localhost:3000
pnpm dev:web                    # http://localhost:5173
```

Desktop app (needs Rust; on Windows also the WebView2 runtime, which ships with Windows 10/11):

```bash
pnpm --filter @mms/desktop dev     # opens the desktop window on the dev web app
pnpm --filter @mms/desktop build   # builds the MSI and EXE installers
```

Every push to GitHub also builds the Windows installer in CI (Actions → latest run →
`workforce-windows-installer`).

## Tests

Everything is written test-first (see CLAUDE.md).

```bash
pnpm test                         # core + API (real database) + web components
pnpm test:mutation                # proves the core tests catch broken code (gate: 80%)
pnpm --filter @mms/web test:e2e   # Playwright, desktop and phone sizes, against the running API
pnpm --filter @mms/desktop test:rust
```

| Suite | Tests |
| --- | --- |
| Core engines | 94, including property-based; mutation score 95% |
| API (PostgreSQL) | 29 |
| Web components | 17 |
| End-to-end | 3 journeys × 2 screen sizes |
| Print module (Rust) | 10 |

## Before real data goes in

- Replace the `x-user` header with Amazon Cognito sign-in and role checks.
- Run the Discovery print test on the company's own printers: 700 payslips and 200 ID
  cards with no dialog (Printers screen → Print test page is the first step).
- Buy a Windows code-signing certificate and add Tauri's signed auto-updater.
- Complete the PDPL transfer assessment for the chosen AWS region.
