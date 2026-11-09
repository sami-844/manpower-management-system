# PROGRESS

> State of the build. **Read first, update last.** `/remember restore` reads this at the start of every session; `/remember save` updates it at the end. If this file and the code disagree, say so; do not guess.
>
> Never write credentials or real worker, client or staff data here (see `.claude/skills/remember/SKILL.md`).

**Release:** Version 1 — office (HR/PRO, operations, payroll, finance), owner/GM and system admin; go-live Sunday 8 Aug 2027 (G5). Version 2 (supervisor app, client portal, worker app) by 27 Jan 2028 (G7).
**Current phase:** 0 — Discovery, data audit and platform proofs (1 Nov – 10 Dec 2026, ends at G0), overlapping Phase 1 — Foundation from 15 Nov.
**Current sprint:** S1 (Sun 1 – Thu 12 Nov 2026) — Proofs: silent printing on the office printers, Bank Muscat WPS sample file, AWS landing zone.
**Current step:** S1 · platform proofs — **not started in code**; all three depend on inputs from the company (see Blocked).
**Last session:** 2026-11-09 — agentic engineering workflow installed (skills, state files, gates). No product code changed.
**Gates on `main` (2026-11-09):** core 94 passed · API 29 passed (PostgreSQL 16) · web 17 passed · typecheck clean · Rust print-spooler 10 passed · `bun run gates` green.

## How a step runs

```
/remember restore  →  /architect  →  build (tests first)  →  /review  →  fix criticals  →  /imprint (if UI)  →  /remember save
                                          ↓
                                  /recover (when something breaks)
```

The steps are the sprints in `docs/spec/08-Implementation-Plan.md`. Each step's plan names its TR-IDs (`docs/spec/05-TRD.md`).

## Completed

- [x] First working slice — core engines: compliance check (`checkEligibility`), renewal tiers 90/60/30/7, OMR money, dates, summary; 94 tests, mutation score 95 %. 2026-10-14, `722d7f0`
- [x] First working slice — API (NestJS on Bun, PostgreSQL 16): workers, documents and HR verification, compliance check, renewals, overrides with named approver, sites, leave, hash-chained append-only audit; migrations 0000–0002; 29 tests. 2026-10-14, `e193cef`
- [x] First working slice — web app: Today queue, workers list, worker file, renewals, printers; 17 component tests and Playwright journeys. 2026-10-14, `4705fd4`
- [x] First working slice — desktop: Tauri 2 shell, Rust print-spooler for silent batch printing (10 tests), Windows installer built in CI. 2026-10-14, `dc85987`
- [x] Toolchain moved to Bun (package manager, API runtime, test runner for core and API). 2026-10-14, `f8115c6`
- [x] Release scope recorded: Version 1 / Version 2 (CLAUDE.md, README). 2026-11-02 and 2026-11-09, `06fdc98`, `322af93`
- [x] Specification complete in the shared document and mirrored in `docs/spec/`: PRD, Technical Spec, Delivery Phases, TRD, App Flow, Backend Schema, Implementation Plan, Design Brief. 2026-11-09
- [x] Agentic engineering workflow: `.claude/skills/` (architect, review, recover, remember, imprint), `docs/PROGRESS.md`, `docs/DECISIONS.md`, `docs/DEFERRED.md`, `docs/SCHEMA_GOVERNANCE.md`, `docs/ui-registry.md`, `scripts/gates.ts` (`bun run gates`, in CI). 2026-11-09

## In progress

- [ ] S1 · Proofs (1–12 Nov 2026)
  - [ ] Silent print of 700 payslips and 200 ID cards on the office's own printers; record printer models and driver versions — needs D7
  - [ ] WPS salary file (SIF) generated from fictional data and validated by Bank Muscat — needs D8
  - [ ] Terraform the AWS accounts (prod, staging, dev, audit), SSO and guardrails in the approved region — needs D6
  - [ ] Daily-sheet entry proof: a printed 30-person sheet entered in the prototype grid in under 2 minutes, photo filed by QR — buildable now (TR-CLI-12 to 14)
  - [ ] Three written proof reports (exit criterion)

## Next

- S2 (15–26 Nov): `packages/ui` with shadcn (Tailwind v4, Radix, `rtl: true`) and the Design Brief tokens; app shell; migrate the first slice screen by screen (keep every `data-testid`); Cognito sign-in with MFA for office roles. Run `/imprint audit` first — the baseline and the fix list are in `docs/ui-registry.md`.
- S3 (29 Nov – 10 Dec): roles and permissions, RLS with per-request session variables, rule versions, audit on every write; G0 sign-off.

## Blocked

- S1 · AWS landing zone — blocked on **D6** (region after the PDPL transfer assessment). Ask: owner with the DPO, 2026-11-09.
- S1 · Silent-print proof — blocked on **D7** (office printer models and access to them). Ask: company IT contact, 2026-11-09.
- S1 · WPS sample file — blocked on **D8** (Bank Muscat WPS specification and test channel). Ask: finance lead with Bank Muscat, 2026-11-09.
- Pushing to GitHub and running CI — blocked on **D10** (empty private repository). Ask: Sami, 2026-11-09.
- G0 — needs **D1–D4** answered by the owner.

## Notes

- 2026-11-09 The HMS skills (from the JavaScript Mastery JSM Skills loop) were adapted, not copied: phase documents → `docs/spec/`; R-documents and LIFT/ADAPT grades → "reuse what exists in the repo"; clinical safety → pay, legal-document and personal-data safety; Bengali typography → Arabic/right-to-left readiness. The HMS PROGRESS.md format (state header, then dated entries newest first) is kept.
- 2026-11-09 `bun run gates` locks applied migrations by SHA-256 in `apps/api/drizzle/migrations.lock`. A new migration is added to the lock in the same commit (`bun run gates --update-lock`); an edited applied migration fails the gate.
- 2026-11-09 The web slice still uses its own CSS (4 px radius, Atkinson font, 6 hard-coded colours, 10 physical left/right properties). Deliberate until S2; listed in `docs/ui-registry.md` as the S2 fix list.

---

## Session log (newest first)

**2026-11-09 — Agentic engineering workflow installed. On `main`, not pushed (no remote yet).**

- **Asked by Sami:** use the HMS architect, imprint, remember, recover and review skills and the progress tracker (from the JavaScript Mastery AI engineering video) for the manpower system.
- **Built:** five project skills in `.claude/skills/`, adapted to this stack and domain; the specification mirrored in `docs/spec/` with its diagrams; `docs/PROGRESS.md` (this file), `docs/DECISIONS.md` (12 open, 15 answered), `docs/DEFERRED.md`, `docs/SCHEMA_GOVERNANCE.md`, `docs/ui-registry.md` (Design Brief baseline plus the first `/imprint audit` of the slice); `scripts/gates.ts` with eight repository gates (each proven to catch a planted fault), wired into `package.json` and CI; CLAUDE.md now carries the numbered rules, the Never table and the engineering loop.
- **Verified:** `bun run gates` green; `bun run test` core 94, API 29, web 17 passed; `bun run typecheck` clean.
- **For Sami:** D6, D7, D8 block the rest of S1 and need the company this week; D10 (GitHub repository) blocks CI.
- **Next:** `/architect` on the S1 daily-sheet entry proof (buildable now), or chase D6–D8.
