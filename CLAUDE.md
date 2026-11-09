# Manpower Management System — rules for AI agents and humans

This file is read by every AI coding session (Claude Code) and every new developer.
The product requirements and technical spec live in the shared "Manpower Management
System — PRD & Technical Spec" doc, mirrored in `docs/spec/` (01-PRD … 09-Design-Brief).
When this file and the spec disagree, the spec wins and this file gets fixed.

## Start here, every session

1. **Read `docs/PROGRESS.md` first** — current phase, sprint, step, what is blocked.
   (`/remember restore` does this and confirms before any building.)
2. Read `docs/DECISIONS.md` — a step that depends on an UNANSWERED decision is blocked.
   Never pick a default for one.
3. **Update `docs/PROGRESS.md` last** (`/remember save`). Never write credentials or real
   worker, client or staff data into any file.

## The engineering loop (project skills in `.claude/skills/`)

```
/remember restore → /architect → build (tests first) → /review → fix criticals
      → /imprint (after any UI) → /remember save              /recover when it breaks
```

| Skill | When | What it does |
| --- | --- | --- |
| `/architect` | Before any code for a step | Reads PROGRESS, the sprint, the spec (TR-IDs, screen IDs, tables), existing code and DECISIONS; writes a plan; **waits for confirmation** |
| `/review` | After building, before commit | `bun run gates`, typecheck, tests, mutation; four layers incl. pay, legal and personal-data safety; reports, does not fix |
| `/imprint` | After every screen or component | Records how the screen applies the Design Brief in `docs/ui-registry.md`; `audit` mode finds drift |
| `/recover` | When something breaks or the agent loops | Stops, diagnoses against the known failures of this stack, resets with a note in PROGRESS |
| `/remember` | Session start (`restore`) and end (`save`) | Keeps PROGRESS, DECISIONS, DEFERRED current; shows the diff first |

State files: `docs/PROGRESS.md`, `docs/DECISIONS.md`, `docs/DEFERRED.md`,
`docs/ui-registry.md`. Database rulebook: `docs/SCHEMA_GOVERNANCE.md`.

## The rules (numbered so reviews can cite them)

1. Tests first. A requirement becomes a failing test before it becomes code.
2. Money is OMR `NUMERIC(14,3)` and `decimal.js`; never a JavaScript `number`.
3. Legal values live only in dated `rule_versions`; never a literal in code or SQL.
4. Golden expected values are set by named people; AI adds cases with `"expected": null`.
5. `checkEligibility()` is the only compliance answer; never re-implemented.
6. Four eyes: bank details, wage changes, payroll release, rate cards, write-offs and
   overrides need a second person (maker ≠ checker, enforced in the API).
7. Locked, released, issued and closed records are never overwritten; corrections are
   new records.
8. Every write is audited in the hash-chained, append-only `audit_events`.
9. Applied migrations are never edited (`apps/api/drizzle/migrations.lock`).
10. Codes come from sequences (`worker_code_seq`), never `MAX()+1`.
11. No real personal data anywhere in the repository; PDPL applies.
12. Version 2 scope (supervisor app, client portal, worker app) is not built before its
    sprints; Version 2 must not need changes to Version 1 tables or endpoints.
13. `bun run gates`, `bun run typecheck` and `bun run test` pass before every commit.

## Never

| Never | Instead | Checked by |
| --- | --- | --- |
| Edit an applied migration | New numbered migration | `gates` G1 |
| `real` / `double precision` / `float` for money | `NUMERIC(14,3)` | `gates` G2 |
| `timestamp` without time zone | `timestamptz`, or `DATE` for calendar dates | `gates` G3 |
| `MAX()+1` for a code | Sequence or locked counter | `gates` G4 |
| npm, pnpm, yarn or their lockfiles | `bun`, `bun.lock` | `gates` G5 |
| Set or change a golden expected value | `"expected": null`, flag for sign-off | `gates` G6, `/review` |
| Real IBANs, IDs, names, phones, salaries | Seed generator | `gates` G7, `/review` |
| Hard-coded colours in UI code | Design Brief tokens | `gates` G8, `/imprint` |
| Re-implement eligibility | Call `checkEligibility()` | `/review` |
| Let one person make and approve a four-eyes change | Separate checker | `/review`, API tests |
| Delete or weaken a test to go green | Fix the code, or explain in the PR why the test is wrong | `/review` |
| Build on an UNANSWERED decision | Mark the step blocked in PROGRESS | `/architect` |

## What this is

One system of record for a ~700-worker construction manpower supply company in Oman:
workers, documents and compliance, clients and rate cards, rosters, timesheets,
payroll (WPS via Bank Muscat), billing and a finance ledger.

## Repository layout

| Path | What | Stack |
| --- | --- | --- |
| `packages/core` | Pure domain engines (compliance, money, later payroll and billing). No I/O, no framework. | TypeScript, bun test, Stryker |
| `apps/api` | Central server: REST API, database, jobs. All business rules run here. | Bun, NestJS, Drizzle, PostgreSQL 16 |
| `apps/web` | The shared interface. Shipped as the website, inside the desktop app, and inside the mobile app. | React, Vite, TanStack Query |
| `apps/desktop` | Tauri 2 shell around `apps/web` for office PCs. Adds silent printing and devices only. | Rust, Tauri 2 |
| `apps/mobile` (Version 2) | Capacitor shell around `apps/web` for supervisors, workers and the owner. | Capacitor |

Rule: shells (desktop, mobile) never hold business rules.

## Release scope

- **Version 1 (go-live 8 Aug 2027):** office roles (HR/PRO, operations, payroll,
  finance), the owner/GM and the system admin, on the desktop app and the web app
  (phone-ready for the owner). Attendance comes from printed daily sheets entered in
  the office (`attendance_events.source = 'office_entry'`), and clients sign emailed
  timesheet packs.
- **Version 2 (by 27 Jan 2028):** supervisor app, client portal and worker app.
- Build the API, data model and permissions for all nine roles now, but do not issue
  supervisor, client or worker accounts and do not start `apps/mobile` before Version 2
  work begins. Version 2 adds front doors; it must not need changes to Version 1 tables
  or endpoints.
- If logic is needed in two places, it goes in `packages/core` and the server is the
  source of truth.

## How we work: tests first, always

1. Start from a requirement in the PRD. Write the failing test that states it.
2. Write the least code that makes it pass.
3. Refactor with the tests green.
4. Run `bun run gates`, `bun run test` and `bun run typecheck` before every commit. CI
   runs all three plus mutation testing on `packages/core`.

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

## Bun (runtime, package manager, test runner)

- Use `bun install`, `bun run <script>`, `bunx`. Never npm, pnpm or yarn; never commit
  another lockfile. `bun.lock` is the only lockfile.
- The API runs on Bun in development, tests and production (`bun src/main.ts`,
  `bun test`, `bun build --target=bun`).
- postgres.js queries are lazy. In `bun:test`, never pass a query straight to
  `expect(...).rejects`; wrap it: ``expect((async () => sql`...`)()).rejects``.
  Passed directly, the test hangs forever and Bun's test timeout does not stop it.
- `apps/api/tsconfig.json` must stay self-contained (no `extends`): Bun ignores
  `experimentalDecorators` in an extended tsconfig, and NestJS then fails at startup.
- Pin exact versions for anything tied to a downloaded binary (e.g. `@playwright/test`).
- Web component tests and mutation testing use Vitest on purpose: jsdom component tests
  and Stryker's proven runner. Don't move them to `bun test` without proving both work.

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
