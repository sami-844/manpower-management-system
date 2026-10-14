# Manpower Management System — rules for AI agents and humans

This file is read by every AI coding session (Claude Code) and every new developer.
The product requirements and technical spec live in the shared "Manpower Management
System — PRD & Technical Spec" doc. When this file and the doc disagree, the doc wins
and this file gets fixed.

## What this is

One system of record for a ~700-worker construction manpower supply company in Oman:
workers, documents and compliance, clients and rate cards, rosters, timesheets,
payroll (WPS via Bank Muscat), billing and a finance ledger.

## Repository layout

| Path | What | Stack |
| --- | --- | --- |
| `packages/core` | Pure domain engines (compliance, money, later payroll and billing). No I/O, no framework. | TypeScript, vitest, Stryker |
| `apps/api` | Central server: REST API, database, jobs. All business rules run here. | NestJS, Drizzle, PostgreSQL 16 |
| `apps/web` | The shared interface. Shipped as the website, inside the desktop app, and inside the mobile app. | React, Vite, TanStack Query |
| `apps/desktop` | Tauri 2 shell around `apps/web` for office PCs. Adds silent printing and devices only. | Rust, Tauri 2 |
| `apps/mobile` (later) | Capacitor shell around `apps/web` for supervisors. | Capacitor |

Rule: shells (desktop, mobile) never hold business rules. If logic is needed in two
places, it goes in `packages/core` and the server is the source of truth.

## How we work: tests first, always

1. Start from a requirement in the PRD. Write the failing test that states it.
2. Write the least code that makes it pass.
3. Refactor with the tests green.
4. Run `pnpm test` and `pnpm typecheck` before every commit. CI runs both plus mutation
   testing on `packages/core`.

Never mark work done with failing or skipped tests. Never delete or weaken a test to
make it pass; if a test is wrong, say why in the pull request.

## Money and legal rules (non-negotiable)

- Money is OMR with 3 decimals (baisa). Store as `NUMERIC(14,3)`; compute with
  `decimal.js` via `packages/core/src/money.ts`. Never use JavaScript `number` for money.
- Every legal rule (hours, overtime, leave, end of service, deductions caps) lives in a
  dated rule table with `validFrom` / `validTo`. Never hard-code a legal value in logic.
- **Golden cases:** expected values in `**/golden/*.json` are signed off by the payroll
  officer, accountant or labour lawyer. AI agents must never create or change an
  expected value in a golden file. Add the case with `"expected": null` and flag it for
  sign-off instead.

## Compliance rules

- `checkEligibility()` in `packages/core` is the single answer to "may this worker work
  here on these dates?". Roster, clock-in, payroll and matching all call it. Do not
  re-implement any part of it elsewhere.
- Overrides are records (who, why, until when), never silent bypasses.

## Data and privacy

- No real personal data in code, tests, fixtures, prompts or screenshots. Use the seed
  generator (`apps/api/src/db/seed.ts`), which produces fictional workers.
- Passport, civil ID and bank numbers are masked in the UI except for roles that need
  them.

## Code conventions

- TypeScript strict mode. No `any` without a comment explaining why.
- Dates for documents and rosters are calendar dates (`YYYY-MM-DD` strings, Oman time),
  not timestamps.
- Database changes are new numbered SQL files in `apps/api/drizzle/`. Never edit an
  applied migration.
- Keep modules aligned with PRD modules (workers, compliance, clients, roster,
  timesheets, payroll, billing, ledger).

## Review

Every change goes through a pull request with green CI and a human reviewer. Payroll,
compliance, security and migration changes need a senior reviewer.
