# PROGRESS

> State of the build. **Read first, update last.** `/remember restore` reads this at the start of every session; `/remember save` updates it at the end. If this file and the code disagree, say so; do not guess.
>
> Never write credentials or real worker, client or staff data here (see `.claude/skills/remember/SKILL.md`).

**Release:** Version 1 — office (HR/PRO, operations, payroll, finance), owner/GM and system admin; go-live Sunday 8 Aug 2027 (G5). Version 2 (supervisor app, client portal, worker app) by 27 Jan 2028 (G7).
**Current phase:** 0 — Discovery, data audit and platform proofs (1 Nov – 10 Dec 2026, ends at G0), overlapping Phase 1 — Foundation from 15 Nov.
**Current sprint:** S1 (Sun 1 – Thu 12 Nov 2026) — Proofs: silent printing on the office printers, Bank Muscat WPS sample file, AWS landing zone.
**Current step:** S1 · platform proofs — **not started in code**; all three depend on inputs from the company (see Blocked).
**Last session:** 2026-11-15 (13) — Cloudflare client demo with its own backend (A32): the README's Deploy to Cloudflare button now sets up the whole system with fictional data — Worker (`apps/cloudflare`) serving the web app, the browser-only demo at `/demo/`, and `/api/*` to one Container running the API image; Postgres pasted at deploy (Neon), scans in R2; container start migrates, seeds once, creates and on every start puts back the six shared demo accounts; migration 0013 lets a non-superuser database owner (Neon, RDS) use the `mms_app` role. Branch `feat/cloudflare-backend`. Before that, 2026-11-12 (12) — Tooling typecheck and the last token-saver steps, no product change: `graphify hook install` (post-commit/checkout/merge/rewrite), cargo and typecheck allow rules, `@types/bun` and `typescript` at the root with a `tsconfig.json` covering `.claude/hooks` and `scripts` (21 strict-mode type errors fixed, no behaviour change), `bun run typecheck` now includes it. Branch `chore/agent-automation`. Before that, (11) the same day — Automatic token savers, no product change: a UserPromptSubmit prompt router (ponytail/caveman workflow by intent, 600-token graph slice for code prompts), graphify hooks in strict mode, ponytail back on in this project, and the setup mirrored into the parent workspace folder (`bun run agent:sync-root`). Branch `chore/agent-automation`, committed in `ab1ae7c`. Before that, (10) the same day — Token savers, no product change: graphify knowledge graph (code + migrations, coarse spec layer; MCP server, advisory hooks, Stop-hook refresh), rtk (already installed globally; works once the editor restarts), caveman (user plugin), Read deny list for generated files. Branch `chore/agent-automation`, committed in `ab1ae7c`. Before that, (9) on 2026-11-11 — Agent tooling, no product change: Bash guard and Stop-hook checks, gates G9/G10, Rust fmt/clippy in CI, three skills, `mutant-hunter`, LSP, path-scoped `CLAUDE.md`. Branch `chore/agent-automation`, committed in `ab1ae7c`. Previous: (8) two-factor optional (A31), branch `feat/optional-2fa`.
**Gates (2026-11-15, `feat/cloudflare-backend`):** core 125 passed · API 152 passed (PostgreSQL 16) · web 102 passed · Worker 7 passed · tooling 76 passed · typecheck clean (core, api, web, cloudflare) · `bun run gates` green · `wrangler deploy --dry-run` builds the image and bindings

## How a step runs

```
/remember restore  →  /architect  →  build (tests first)  →  /review  →  fix criticals  →  /imprint (if UI)  →  /remember save
                                          ↓
                                  /recover (when something breaks)
```

The steps are the sprints in `docs/spec/08-Implementation-Plan.md`. Each step's plan names its TR-IDs (`docs/spec/05-TRD.md`).

## Completed

- [x] Cloudflare client demo with its own backend (A32, widens A20; A10 unchanged): Worker + one Container from `apps/api/Dockerfile`, `/demo/` for the browser-only demo, secrets asked by the button (`.dev.vars.example`, `cloudflare.bindings`), auth keys derived from `APP_SECRET`, start-up `apps/api/src/deploy/client-demo.ts` (migrate, seed once, complete masters, create and put back the six shared accounts), test scanner only on `DEPLOYMENT=cloudflare-demo`, migration 0013 (`mms_app` SET for non-superuser owners), "fictional data" notices, not-set-up and not-started answers named on sign-in. Verified locally: the real image with the Worker's settings against a non-superuser Postgres 16 and an S3 stand-in (sign-in, masters, scan up/down byte-identical, visitor IP, restart, shared-account put-back); Worker routes and notices in a browser; dry-run deploy. Independent review: no critical or high; four medium fixed. A real deploy is X23. 2026-11-15, branch `feat/cloudflare-backend`
- [x] Tooling typecheck (tooling only): root `tsconfig.json` (extends the base, `types: ["bun"]`) covers `.claude/hooks` and `scripts`; `typecheck:tooling` runs inside `bun run typecheck`, so CI and rule 13 cover it, and the Stop hook runs it after hook or script edits. The 21 errors it found were `noUncheckedIndexedAccess` gaps on regex groups and split results, plus a `net.Server.once` call that `@types/node` 26 no longer types; each fixed at the source, tests unchanged and green (76). graphify git hooks installed; allow rules for `cargo fmt/clippy/test/check` and the typechecks. 2026-11-12, branch `chore/agent-automation`
- [x] Automatic token savers (tooling only): `.claude/hooks/prompt-router.ts` runs on every prompt — bug → investigate-first + surgical-patch, refactor → safe-refactor, build → lean-build, verify → verify-and-stop (caveman task skills inlined, no Skill call), review → ponytail-review + caveman-review, audit → ponytail-audit, commit → caveman-commit, plus a precedence line (project rules, TR tests, gates and mutation score beat brevity); code prompts get a `graphify query` slice capped at 600 tokens (1.7 s); slash commands and prose pass untouched. graphify hooks `--strict` (the first raw Read/Grep per session goes to the graph unless a query ran in the last 30 min). ponytail re-enabled here, ralph-loop off. `scripts/sync-root-settings.ts` mirrors hooks, guards, permissions, plugin switches and the graphify server into `Manpower-Management-System/.claude/settings.json` and `.mcp.json` (the editor had been opened there, so none of the project hooks loaded); the Stop hook regenerates it, `agent:doctor` fails on drift. Verified from the parent folder: router, graph nudge and `.env` guard all fire. Tooling tests 76 passed. 2026-11-12, branch `chore/agent-automation`
- [x] Token savers (tooling only): **graphify** 0.9.106 with the SQL and MCP extras — 3,110 nodes / 12,785 edges / 105 named communities from code, the 13 migrations and (coarsely) the docs; project skill, `## graphify` section in `CLAUDE.md`, advisory PreToolUse hooks and a compaction SessionStart hook, `graphify` MCP server (pre-approved), `.graphifyignore`, `graphify-out/` git-ignored; the Stop hook runs `graphify update .` after code edits (tested). Measured: "who calls checkEligibility" costs ~1.6k tokens from the graph versus ~31k reading the files (graphify's own benchmark: 128× against the whole corpus). **rtk** 1.2.0 was installed and globally hooked but off PATH for sessions opened before its install; verified it only auto-allows commands these settings already allow. **caveman** 4.1.0 user plugin (hooks audited: no network, no tool interception; files, commits and docs stay plain prose). Read deny list for `bun.lock`, build output, drizzle snapshots and graphify's JSON/HTML. `agent:doctor` checks graphify, graph freshness, its git hooks and rtk. 2026-11-12, branch `chore/agent-automation`
- [x] Agent automation (tooling only): `bash-guard.ts` blocks working-tree git rewrites while :5173/:3100 listen; `stop-checks.ts` runs the typecheck, hook tests and Rust checks a turn's edits owe (post-edit hook records paths); gates **G9** (print spooler never panics) and **G10** (every `#[tauri::command]` registered and every web `invoke` names one); Rust code rustfmt-formatted (layout only) and clippy-clean, `lint:rust` added and run in CI before the installer build; skills `/new-migration`, `/tr-test`, `/tauri-command`; agent `mutant-hunter` (Stryker JSON report added); `independent-reviewer` covers desktop IPC/CSP/capabilities; `playwright-desktop` MCP (WebView2 over CDP); LSP plugins (TypeScript, rust-analyzer); desktop CSP allows the API on :3100; `CLAUDE.md` 27.3 → 22.1 KB with area maps and setup tables moved to path-scoped `.claude/rules/`; `.claude/settings.local.json` now git-ignored; `agent:doctor` checks rules, LSP, Rust tools and the MSVC linker; `guard.test.ts` fixed for Windows paths. 2026-11-11, branch `chore/agent-automation`
- [x] Two-factor optional (A31, TR-SEC-01 revised): no set-up step at first sign-in, no guard block, `AUTH_REQUIRE_TOTP` removed; S-46 My account turns it on (set-up, then confirm with the first code and the password; other sessions end) and off (`POST /api/auth/2fa/disable`: password and a fresh code, both counted toward the lockout, a code works once); both audited; `/api/auth/me` reports `twoFactor`. Independent review: a session alone could turn two-factor on (fixed: password needed); `@SignedIn` routes no longer hold a request transaction, which could freeze the 10-connection pool under 10 parallel password or two-factor requests (fixed, tested); `/audit/verify` keeps that pattern (X22). 2026-11-11, branch `feat/optional-2fa`
- [x] Document masters (PRD 4.19, A26–A30): the eighteen masters in In House, Purchase and Sales (company papers; direct and indirect employees' passport, Oman ID card, medical insurance, Sohar gate pass; sub-contractor and client CRs); `organisation_documents`, `files` (type from the bytes, 15 MB, EICAR-tested virus check in development, pending in production until X15, immutable, status pending → clean/infected only), the client register started (`C-00001`); permissions `masters.read`, `org_documents.manage`, `company_documents.manage` (HR/PRO only), `clients.read`, `clients.manage`, `pii.view` (worker scans); scans upload only after sign-in, outside the request transaction; every opening audited; Oman ID card and medical insurance join the mandatory documents and a site may require a Sohar gate pass (A28). Screens S-44 and S-45, scans on the worker file and S-08, hosted demo endpoints. Seed: idempotent masters data, and every seeded worker now gets an engagement (fixes fresh seeds after 0008). Independent review: 1 high, 3 medium, 6 low, fixed with tests or deferred (X20, X21). 2026-11-10

- [x] Own authentication (A25, HMS design): Argon2id, mandatory TOTP, 15-minute access tokens in memory, rotating refresh cookie with reuse detection, server idle and absolute limits, reserve-then-verify lockout, per-IP and per-user limits; default-deny permissions on every route (test-checked); requests run as `mms_app` under entity row-level security (audit included, one hash chain, hash v2 covers the entity); admin user endpoints; bootstrap and demo-user scripts; web sign-in, first-sign-in set-up, Admin › Users; sign-out fails closed. Six security reviews' findings fixed with regression tests. 2026-11-09
- [x] Sponsors and outsourced workers API (PRD 4.18, A21–A24): sponsor register with head-counts, dated engagements (own, supplied, transferred, free_visa), authorisations verified by a second person, owner-only override behind `outsourcing.unauthorised`, supply agreements with four eyes and decimal rates; every existing worker backfilled as own. Screens, labour bills and the 730/2024 limits deferred (X11–X13). 2026-11-09
- [x] Hosted client demo: `wrangler.jsonc` + README "Deploy to Cloudflare" button + `bun run deploy`; `--mode demo` build answers the web's 13 API calls in the browser (`apps/web/src/demo/server.ts`, `@mms/core` engines, fictional seed recipe, hash-chained audit), 6 tests; Playwright 6/6 against the hosted build with no API server. Public GitHub repository (DECISIONS A19, A20). 2026-11-09
- [x] Version 1 demo foundation (branch `feat/v1-demo-foundation`): Tailwind v4 + shadcn/ui (Radix, `rtl: true`) with the Design Brief tokens; dashboard-01 shell (role-filtered sidebar, breadcrumb, Ctrl+K S-03, notifications); demo sign-in S-01; every V1 screen S-01…S-41 built. Real API for workers, documents, verification, eligibility, renewals, overrides, leave, sites and audit; typed fictional demo layer (`apps/web/src/demo/`) for clients, operations, time, payroll, billing, ledger, insight and admin, each screen badged "Sample data". Web tests 17 → 39 (demo money/ledger invariants, entry-grid keyboard); e2e signs in first. 2026-11-09

- [x] First working slice — core engines: compliance check (`checkEligibility`), renewal tiers 90/60/30/7, OMR money, dates, summary; 94 tests, mutation score 95 %. 2026-10-14, `722d7f0`
- [x] First working slice — API (NestJS on Bun, PostgreSQL 16): workers, documents and HR verification, compliance check, renewals, overrides with named approver, sites, leave, hash-chained append-only audit; migrations 0000–0002; 29 tests. 2026-10-14, `e193cef`
- [x] First working slice — web app: Today queue, workers list, worker file, renewals, printers; 17 component tests and Playwright journeys. 2026-10-14, `4705fd4`
- [x] First working slice — desktop: Tauri 2 shell, Rust print-spooler for silent batch printing (10 tests), Windows installer built in CI. 2026-10-14, `dc85987`
- [x] Toolchain moved to Bun (package manager, API runtime, test runner for core and API). 2026-10-14, `f8115c6`
- [x] Release scope recorded: Version 1 / Version 2 (CLAUDE.md, README). 2026-11-02 and 2026-11-09, `06fdc98`, `322af93`
- [x] Specification complete in the shared document and mirrored in `docs/spec/`: PRD, Technical Spec, Delivery Phases, TRD, App Flow, Backend Schema, Implementation Plan, Design Brief. 2026-11-09
- [x] Agent setup, part 2: upstream sources in `third_party/` (JSM video skills `fd85d6a`, JSM v2 `43b69e4`, Karpathy guidelines `2c60614`); `/karpathy-guidelines` active; `CLAUDE.md` rewritten as the hub (Karpathy principles, loop, tool-for-job, file map, 13 rules, Never table); `.mcp.json` (7 servers); `.claude/settings.json` (permissions, SessionStart, PreToolUse guard, PostToolUse gates); `.claude/agents/` (spec-scout, independent-reviewer); `bun run agent:doctor`; skills wired to agents and MCP servers. 2026-11-09
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
- G0 — needs **D1–D4** answered by the owner.
- Real sponsor data and labour-bill terms — need **D14** (who sponsors today's workers) and **D16** (supply terms, VAT). **D15** (labour lawyer) decides whether `outsourcing.unauthorised` moves to `block`; its points (1) and (4) may also touch assignments and the cash list for the company's own workers.

## Notes

- 2026-11-09 `apps/web/src/demo/server.ts` mirrors the API endpoints the web calls (validation, masking, audit chain) for the hosted demo. Change it with any such endpoint; `server.test.ts` and the e2e journeys run against it. The normal build drops it (Vite `MODE`).
- 2026-11-09 The root `build` script was removed: unused, and it built the Tauri installer, which fails on machines without Rust (and on Cloudflare). CI builds each package by name.
- 2026-11-09 The demo layer is not the product. Each module's sprint replaces `src/demo/<module>.ts` with real `/api/v1` calls and tests first (rule 1); legal values shown in the demo are marked "demo · unsigned" and must come from signed `rule_versions` (rules 3–4). D8 and D9 still show as pending on screen.
- 2026-11-09 `.claude/hooks/guard.test.ts`: 2 of 14 fail on Windows only (POSIX fixture paths vs `path.join` backslashes); pre-existing, passes on Linux CI. Not changed: hooks are human-owned.
- 2026-11-09 Seed now mixes ~86% deployed / ~8% bench / ~6% on leave (was 60/36/4) so the demo's bench rate is realistic; `SEED_WORKERS=680` for the demo.

- 2026-11-09 The HMS skills (from the JavaScript Mastery JSM Skills loop) were adapted, not copied: phase documents → `docs/spec/`; R-documents and LIFT/ADAPT grades → "reuse what exists in the repo"; clinical safety → pay, legal-document and personal-data safety; Bengali typography → Arabic/right-to-left readiness. The HMS PROGRESS.md format (state header, then dated entries newest first) is kept.
- 2026-11-09 `bun run gates` locks applied migrations by SHA-256 in `apps/api/drizzle/migrations.lock`. A new migration is added to the lock in the same commit (`bun run gates --update-lock`); an edited applied migration fails the gate.
- 2026-11-09 The web slice still uses its own CSS (4 px radius, Atkinson font, 6 hard-coded colours, 10 physical left/right properties). Deliberate until S2; listed in `docs/ui-registry.md` as the S2 fix list.

---

## Session log (newest first)

**2026-11-12 (12) — Tooling typecheck, graphify git hooks, allow rules. Branch `chore/agent-automation`, committed in `bd493d2`.**

- **Asked by Sami:** run `graphify hook install`, add the cargo and typecheck allow rules, add `@types/bun`, without compromise.
- **Done:** all three; `typescript@^5.6.0` added at the root too (same 5.9.3 the workspaces resolve), since the root had no `tsc`. The new typecheck found 21 real gaps in the tooling code; fixed, not suppressed. `.gitattributes` gained graphify's merge-driver line (inert while `graphify-out/` is git-ignored).
- **Checks:** `bun run typecheck` clean (core, api, web, tooling) · tooling tests 76 passed · gates green · `agent:doctor` 0 fail, graphify git hooks PASS.

**2026-11-12 (11) — Token savers run on their own. Branch `chore/agent-automation`, committed in `ab1ae7c`.**

- **Asked by Sami:** graphify and the token savers on every prompt without being asked; ponytail and caveman installed and chosen by request type; anything else that cuts tokens without hurting accuracy; no compromise on code quality.
- **Decided (Sami, all recommended):** plugin trim in this project only; graphify strict mode; caveman standard level (not ultra); mirror the setup into the parent folder.
- **Found:** the editor had been opened on the parent `Manpower-Management-System/` folder, so this project's hooks, guards and plugin switches never loaded (ponytail, superpowers and the explanatory style all started up). The mirror fixes that.
- **Fixed after first live use:** the router read the editor's attached `<browser_instruction>` block as a review request and attached a 1,014-node graph slice to "Proceed". It now routes only the user's own words, seeds the graph query from named symbols, and drops unanchored matches over 200 nodes (tests first; tooling tests 76 passed).
- **Not done:** `caveman-compress` on `CLAUDE.md` (sends the file to a model and rewrites the human-read hub); a lower MCP output cap or thinking budget (both cut accuracy). The claude.ai-connected skill sets (small-business, marketing, finance, apify, astronomer-data) can't be switched off from Claude Code settings.

**2026-11-12 (10) — graphify and token savers. Branch `chore/agent-automation`, committed in `ab1ae7c`.**

- **Asked by Sami:** set up graphify and every token-saving tool, without compromise.
- **Decided (in Claude):** context-mode skipped (its `ctx_execute` would bypass the Bash deny list and bash-guard); caveman on in every session; graphify with code and spec, then — after the spec pass cost ~395k plan tokens (estimate was 100–150k) and came out coarse with 1 doc↔code edge — keep the coarse spec layer and stop (a per-requirement re-run would cost ~1.5–2M and still not link to code; TR-IDs stay with `spec-scout`). Considered and left out: token-savior, code-review-graph, Serena, claude-context, token-optimizer, claude-code-router, claude-mem (reasons in `.claude/rules/agent-setup.md`).
- **Plan tokens spent this session on graphify:** spec pass 339k in / 55k out; TRD granularity test 125k / 41k; community labels 117k / 4k.
- **Left for a human:** auto mode refused installing graphify's git hooks (persistence) — run `graphify hook install` to refresh the graph on commit, checkout and pull; restart the editor so `rtk` is on PATH for the global hook. Still open from (9): the allow rules for cargo and filtered typecheck.

**2026-11-11 (9) — Claude Code automation for the build, Tauri/Rust and token use. Branch `chore/agent-automation`, committed in `ab1ae7c`.**

- **Asked by Sami:** recommend automations, then "more for Tauri and Rust, and for reducing token usage, do not compromise"; then "proceed".
- **Decided (in Claude, recommended options):** CSP gains `localhost:3100` (default port stays 3000); `superpowers` and `ponytail` plugins off for this project (the project loop covers them); the warehouse project's SSH/production allow rules moved out of user settings into that project; Visual Studio 2022 Build Tools installed so Rust links locally.
- **Built:** see Completed. `postgres` MCP approved per person in `settings.local.json`, not in the shared file (CLAUDE.md keeps it an explicit approval). Personal plugin switches (unused, broken or duplicate plugins off) are in the git-ignored `settings.local.json`.
- **Left for a human:** the auto-mode classifier refused Claude adding **allow** rules to `.claude/settings.json` (`cargo fmt/clippy/test/check *`, `bun run --filter * typecheck`); add them by hand if wanted. API tests need `docker compose up -d`. The web tests' 5 s timeouts fail on this PC while CPU is saturated (`memreduct` was the top process).

**2026-11-09 (6) — Authentication and the sponsors backend. Branch `feat/auth-and-sponsors` (worktree `../manpower-system-build`), not pushed.**

- **Asked by Sami:** answer the open questions in Claude with options; then build authentication (backend, schemas, “super fast and really reliable”), the way the company's WMS and HMS do it; allow free-visa workers for now (Sami's and the client's decision).
- **Decided:** A21 (Version 1), A22 (unauthorised engagements allowed with the owner's approval behind one setting), A23 (free-visa payees), A24 (WPS proof required), A25 (own identity service, HMS design, replacing Cognito); D6 stays a deploy setting.
- **Built:** see Completed. Spec and the live document updated to match (PRD 4.18, TRD TR-SEC-01/03/11, TR-ENG-12–14, Backend Schema, Tech Spec, App Flow, Delivery Phases, Implementation Plan, Design Brief). `.gitattributes` pins `*.sql` and the migration lock to LF (Windows checkouts had changed the hashes).
- **Verified:** gates green; typecheck clean; core 107 (mutation 89.8 %, bar 80 %), API 95, web 67; two deliberate faults (no role switch, no permission check) caught by the tests; security-review findings each fixed with a regression test.
- **For Sami:** the free-visa allowance is a company decision against the legal advice in PRD section 6 (A22); D15 with the labour lawyer can switch it to `block` in one setting. The PDF and Word copies in `01-Documents` are behind the Markdown.
- **Next:** merge to `main`, migrate the dev database, create the demo users; then S2 as planned, with the sponsor screens (X13).

**2026-11-09 (5) — Sponsors and outsourced workers, specification only.**

- **Asked by Sami (for the client, after the demo):** track every worker's sponsor, the company included, and the workers taken from other manpower companies or "free visa" workers when the company's own are not enough; research how they are paid; document it in the existing documents' format; plan and report, no code.
- **Researched:** Labour Law 53/2023 articles 29, 87, 143 and 147 and Ministerial Decision 730/2024, read in the text (decree.om, qanoon.om; unofficial Gazette reproductions), plus news and law-firm sources. Using another employer's worker is lawful only with Ministry authorisation (art. 29) or a registered temporary transfer (730/2024: 6 months a year at most, receiver pays through its own WPS). "Free visa" working is an offence: OMR 1,000–2,000 per worker, prison, a 2-year recruitment ban, deportation.
- **Changed:** the live shared document and `docs/spec/` together (and `01-Documents/Markdown` with its `MANIFEST.sha256` lines): PRD 4.18 (new module), working assumptions, a goal, section 6 (three legal rows), a task budget, two risks, two owner decisions; Technical Spec entities, compliance, payroll and billing engines, four-eyes; TRD TR-ENG-12 to 14 and TR-SEC-06; App Flow S-42 Sponsors, S-43 Supply agreements and the "outsourced worker to site" flow; Backend Schema `sponsors`, `worker_sponsorships`, `supply_agreements`, `supply_rate_lines`, `supplier_bill_lines` and `supplier_bills.kind`; Delivery Phases 2, 3 and 7, a risk and sources; Implementation Plan S4, S6, S7, S15 and the migration inventory; Design Brief engagement tag. DECISIONS D13–D16.
- **Not changed:** the PDF and Word copies in `01-Documents` and the diagrams (entity map, navigation map) are now behind the Markdown; the demo has no sponsor screens.
- **For Sami:** take D13 and D14 to the owner and D15 to the labour lawyer; the "free visa" finding needs saying to the owner plainly.
- **Next:** unchanged (S1 proofs, S2); 4.18 is built only after D13–D15 are answered.

**2026-11-09 (4) — GitHub and the hosted demo.**

- **Asked by Sami:** a GitHub repository and a README button that deploys the demo to Cloudflare Workers.
- **Decided with Sami:** public repository (A19; the button needs one; Sami accepted that the spec and history become public); fast-forward `main` to the demo.
- **Built:** browser stand-in for the API in the demo build; `wrangler.jsonc` (static assets), root `build:demo` and `deploy` scripts, `wrangler` 4.158.0 pinned; "Hosted demo" badge in the header; README section; CLAUDE.md file map; GitHub CLI installed.
- **Verified:** gates green; typecheck clean; core 94, API 29, web 45; Playwright 6/6 against the demo build with the API URL pointed at a dead port; all 40 web screens open with no console errors; `wrangler deploy --dry-run` reads 106 assets; the normal build contains none of the stand-in.
- **Pushed:** https://github.com/sami-844/manpower-management-system (public, default `main`). First CI run failed in the Windows desktop job: the runner's CRLF conversion corrupted the ASCII-only `test-page.pdf` (the shipped test page too). Fixed with `.gitattributes` (`*.pdf binary`); CI green on all 4 jobs (tests, e2e, API image, Windows installer).
- **Next:** Sami clicks the README button to deploy the demo on Sami's Cloudflare account; S2 as planned.

**2026-11-09 (3) — Version 1 demo foundation. Branch `feat/v1-demo-foundation`, not pushed (no remote, D10).**

- **Asked by Sami:** a client-demo foundation of Version 1: every page, basic functionality, shadcn dashboard blocks, the best design/dev skills and MCP servers installed; one shot.
- **Decided with Sami:** hybrid data (A17), free Aceternity only (A16, closes D11), name "Manpower Management System", commit on a branch. Claude decided A18 (components in `apps/web`) under delegation.
- **Built:** foundation (tokens, shell, DataTable, StatusBadge, Money, ConfirmDialog, KpiCard, route table) then six parallel agents built the module screens; integration aligned the cross-module story (October payroll released 1 Nov; owner inbox holds a new contract), live notification/approval counts, print rules, in-house theme provider (dropped next-themes), tokenised Aceternity pieces. `gates.ts` paths normalised for Windows.
- **Verified:** `bun run gates` green; typecheck clean (core, api, web); core 94, API 29, web 39 passed; Playwright e2e 6/6 (desktop + phone); `vite build` OK; all 35 routes rendered with no console errors; tooling 12/14 (2 pre-existing Windows-only, see Notes). Rust print-spooler not re-run (untouched).
- **For Sami:** review A18 and the `--highlight` token deviation (ui-registry); D1–D10, D12 still open.
- **Next:** S2 proper: Cognito sign-in replacing the demo sign-in; then each module's sprint swaps its demo file for the API, tests first.


**2026-11-09 (2) — Agent setup completed. On `main`, not pushed (no remote yet).**

- **Asked by Sami:** put the JavaScript Mastery files in the package; one CLAUDE.md that connects every file, its use, best practices and what to avoid; apply the Karpathy skills; use skills and MCP servers to the full.
- **Found:** the video's five skills are in `jsmastery-pro/jsm-agent-skill` (MIT); `JavaScript-Mastery-Pro/skills` is JSM's later v2 workflow. Both vendored with the Karpathy repo; upstream `CLAUDE.md` files renamed so they cannot load.
- **Built:** see Completed. The guard hook blocks edits to applied migrations, the lock, `.env` files and signed golden values (14 tests). The gates run after every agent edit (about 50 ms).
- **Verified:** gates green; tooling tests 14 passed; doctor 0 fail (1 warn: `GITHUB_PAT` unset, expected until D10); core 94, API 29, web 17 passed; typecheck clean.
- **For Sami:** install uv for the postgres, aws-docs and terraform servers; set `GITHUB_PAT` once D10 is done; approve the github and postgres servers on first run (`/mcp`).
- **Next:** unchanged: `/architect` on the S1 daily-sheet entry proof, or chase D6–D8.

**2026-11-09 — Agentic engineering workflow installed. On `main`, not pushed (no remote yet).**

- **Asked by Sami:** use the HMS architect, imprint, remember, recover and review skills and the progress tracker (from the JavaScript Mastery AI engineering video) for the manpower system.
- **Built:** five project skills in `.claude/skills/`, adapted to this stack and domain; the specification mirrored in `docs/spec/` with its diagrams; `docs/PROGRESS.md` (this file), `docs/DECISIONS.md` (12 open, 15 answered), `docs/DEFERRED.md`, `docs/SCHEMA_GOVERNANCE.md`, `docs/ui-registry.md` (Design Brief baseline plus the first `/imprint audit` of the slice); `scripts/gates.ts` with eight repository gates (each proven to catch a planted fault), wired into `package.json` and CI; CLAUDE.md now carries the numbered rules, the Never table and the engineering loop.
- **Verified:** `bun run gates` green; `bun run test` core 94, API 29, web 17 passed; `bun run typecheck` clean.
- **For Sami:** D6, D7, D8 block the rest of S1 and need the company this week; D10 (GitHub repository) blocks CI.
- **Next:** `/architect` on the S1 daily-sheet entry proof (buildable now), or chase D6–D8.
