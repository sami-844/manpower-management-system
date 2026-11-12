# CLAUDE.md — Manpower Management System

The hub for every AI session (Claude Code) and every developer. It says how to work, which tool to use for which job, what every file is for, and what never to do. The product spec lives in the shared "Manpower Management System — PRD & Technical Spec" document, mirrored in `docs/spec/`. **When this file and the spec disagree, the spec wins and this file gets fixed.**

**The system:** one system of record for a construction manpower supply company in Oman with about 700 workers. It covers workers, documents and compliance, clients and rate cards, rosters, timesheets, payroll (WPS through Bank Muscat), billing and a finance ledger.

**Release scope:**
- **Version 1** (go-live 8 Aug 2027): office roles (HR/PRO, operations, payroll, finance), the owner/GM and the system admin, on the desktop and web apps.
  - Attendance comes from printed daily sheets entered in the office (`attendance_events.source = 'office_entry'`).
  - Clients sign emailed timesheet packs.
- **Version 2** (by 27 Jan 2028): supervisor app, client portal, worker app.
  - Build the API, data model and permissions for all nine roles now.
  - Don't issue supervisor, client or worker accounts, and don't start `apps/mobile`, until Version 2 work begins.
  - Version 2 must not need changes to Version 1 tables or endpoints.

---

## 0. Start every session the same way

1. A **SessionStart hook** (`.claude/hooks/session-start.ts`) prints the build state:
   - phase, sprint, step and last session
   - what is blocked
   - the open decisions
2. Run **`/remember restore`**. It reads `docs/PROGRESS.md`, `DECISIONS.md` and `DEFERRED.md`, states where the build is, and **waits for confirmation**.
3. If the step depends on an **UNANSWERED** decision in `docs/DECISIONS.md`, it is blocked. Say so; never pick a default.
4. End with **`/remember save`**, so `docs/PROGRESS.md` is updated last, every session.
5. One step per session. Run `/clear` between steps, so the next step starts from the files and not from leftover conversation.

---

## 1. How to work: the Karpathy guidelines, applied here

These come from [forrestchang/andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills), which is based on [Andrej Karpathy's notes on LLM coding pitfalls](https://x.com/karpathy/status/2015883857489522876). The verbatim skill is active as `/karpathy-guidelines` and loads automatically when writing, reviewing or refactoring code. The originals and `EXAMPLES.md` are in `third_party/andrej-karpathy-skills/`. They lean towards caution over speed; for a trivial change, use judgement.

| Principle | What it means in this repository |
|---|---|
| **1. Think before coding.** Don't assume, don't hide confusion, surface tradeoffs. | `/architect` before any code. Cite the TR-ID, screen or table, or say "not specified"; never fill a spec gap from general knowledge. If two readings exist (a legal rule, a pay rule, a status transition), present both and ask. An open question goes in `docs/DECISIONS.md`, not into a silent default. Push back when the spec would break PDPL, WPS or labour law (`/recover` mode 4). |
| **2. Simplicity first.** Minimum code that solves the problem; nothing speculative. | Build the sprint step and nothing else. Version 2 features and Phase 12 modules are out until their sprint. Reuse `packages/core` (`checkEligibility`, money, dates), the audit module and shadcn components before writing new ones. No configurability nobody asked for, **except** legal values, which are always configurable through dated `rule_versions` (rule 3). That is a requirement, not speculation. |
| **3. Surgical changes.** Touch only what you must; clean up only your own mess. | Every changed line traces to the step's plan. Don't reformat, rename or "improve" nearby code. Leave the pre-shadcn CSS in `apps/web/src/styles.css` alone until S2 replaces it. Mention unrelated dead code; don't delete it. Never edit an applied migration, a signed golden value or anything in `third_party/` (hooks block the first two). |
| **4. Goal-driven execution.** Define success criteria; loop until verified. | Tests first: each TR-ID becomes a failing test, then code, then green. A bug becomes a reproducing test, then a fix. A refactor needs the same tests green before and after. The plan states `step → verify: check` for each step. "Done" means `bun run gates`, `bun run typecheck` and `bun run test` pass, plus `/review`. |

Two more ideas from Karpathy's "Software 3.0" talk shape how much freedom the agent gets:
- **Keep the AI on a tight leash, with a fast generation-and-verification loop.** Small steps, checked immediately. That is why gates run after every edit and why each sprint step is small.
- **Partial autonomy, with the human approving.** The agent proposes; a person approves plans, golden values, four-eyes changes and merges.

---

## 2. The engineering loop: JavaScript Mastery skills, adapted

```
/remember restore → /architect → build (tests first) → /review → fix criticals → /imprint (after UI) → /remember save
                                        └──────────── /recover when something breaks ────────────┘
```

These are the five skills from the JavaScript Mastery AI engineering video ([jsmastery-pro/jsm-agent-skill](https://github.com/jsmastery-pro/jsm-agent-skill), MIT). They are adapted to this system in `.claude/skills/`, and the untouched originals are in `third_party/jsm-agent-skill/`. To run one, type its name at the start of a message (`/architect S4 · worker bank accounts`); Claude also loads a skill on its own when the task matches its description.

| Skill | Use it | Reads | Writes | Tools it uses |
|---|---|---|---|---|
| `/remember restore` · `save` | At the start and end of every session | `docs/PROGRESS.md`, `DECISIONS.md`, `DEFERRED.md`, `ui-registry.md` | The same files. It shows the diff first and never writes secrets or real personal data. | — |
| `/architect` | Before any code for a step | PROGRESS, the sprint in `docs/spec/08`, TR-IDs in `05`, screens in `06`, tables in `07`, existing code, DECISIONS, this file | A plan in the conversation; **waits for a yes** | `spec-scout` agent, context7, shadcn, aws-docs, postgres (read-only) |
| `/review` | After building, before committing | The plan, the diff, the spec, this file, `SCHEMA_GOVERNANCE.md` | A report by severity; **never fixes anything** | `bun run gates`/typecheck/test/mutation, `independent-reviewer` agent, playwright |
| `/imprint` · `/imprint audit` | After every screen or component | The changed UI, `docs/spec/09-Design-Brief.md` | `docs/ui-registry.md` | playwright (looks at the screen), shadcn |
| `/recover` | When something breaks, loops or drifts | The error, the relevant code, the known failures of this stack | A fix with a reproducing test, or a reset note in PROGRESS | postgres (read-only), playwright, context7, github |
| `/karpathy-guidelines` | Automatically, while writing, reviewing or refactoring code | — | — | — |

`third_party/jsm-skills-v2/` holds JSM's later workflow (`/scope`, `/develop`, `/check`, `/audit`, `/debug`, `/document`, `/sync`) for reference. It is **not active**. To adopt one, copy it into `.claude/skills/` under a name that doesn't clash and adapt it the way the five were (see `third_party/README.md`).

---

## 3. Get the most out of the tools

### Which tool for which job

| Job | Use | Not |
|---|---|---|
| Find what the spec says about a step | `spec-scout` agent | Reading all nine spec files into the conversation |
| Current API of NestJS, Drizzle, Tauri, TanStack, Vite, Bun, Playwright | **context7** MCP | Memory: APIs change |
| Add or check a shadcn/ui component | **shadcn** MCP, then copy into `packages/ui` | Hand-writing a component shadcn already has |
| See or debug a screen; check `/imprint` visually; reproduce an e2e failure | **playwright** MCP against `bun run dev:web` | Guessing from the JSX |
| Inspect the real schema, rows, triggers or RLS policies | **postgres** MCP (read-only, local seeded database only) | Inferring from migrations; ever pointing it at production |
| Pull requests, issues, CI logs, branch protection (once D10 is answered) | **github** MCP | Copy-pasting logs |
| AWS service facts: Cognito, RDS, S3, KMS, SES, regions (D6) | **aws-docs** MCP | Memory |
| Terraform for the S1 landing zone | **terraform** MCP (AWS provider docs, Checkov) | Unchecked resource arguments |
| See or debug the real desktop window (WebView2, IPC) | **playwright-desktop** MCP against the shell started with remote debugging (`.claude/rules/desktop.md`) | Guessing from the Rust or the browser build |
| Independent check of a payroll, WPS, compliance, security, migration or desktop IPC change | `independent-reviewer` agent | The builder reviewing its own work |
| Turn a TR-ID into its failing test | `/tr-test TR-XXX-NN` | Writing the code first |
| A new migration | `/new-migration` | Hand-creating a `.sql` file |
| A new or changed desktop IPC command | `/tauri-command` | Editing `lib.rs` alone |
| Mutation score near the 80 % gate | `mutant-hunter` agent | Lowering the threshold or weakening a test |
| How code connects: callers, dependents, paths between modules, hubs | **graphify** (MCP `query_graph`/`shortest_path`/`get_neighbors`, or `graphify query/path/explain`) — see the `## graphify` section below. Its spec layer is coarse; for TR-IDs, screens and tables use `spec-scout` | Grepping and reading whole files |
| Where is this defined, who calls it | LSP (go-to-definition, find-references; TypeScript and Rust) | Grepping and reading whole files |
| Broad codebase search when only the answer is needed | A subagent (the built-in Explore agent) | Many Grep/Read calls in the main context |
| Big or ambiguous change | Plan mode, then `/architect` | Starting to type code |

### Servers, agents, hooks and permissions

The details — every MCP server and its safety limits, the subagents, each hook and what it blocks, the permission lists — are in **`.claude/rules/agent-setup.md`**, which loads when the agent setup is read or changed. In short: hooks **block** the Never items they can see (secrets, applied migrations, golden values, git rewrites while dev servers run), run the gates after every edit, and run typecheck, hook tests and Rust checks before a turn ends. Personal exceptions go in `.claude/settings.local.json` (git-ignored), never in the shared file.

### Context hygiene
- One step per session and `/clear` between steps; the state lives in `docs/`, not in the chat.
- Delegate searches and reviews to subagents.
- Load spec sections, not whole documents.
- Navigate code with the LSP (definitions, references) rather than reading whole files.
- Area-specific parts of this hub live in `.claude/rules/` and load only when matching files are read or edited.
- Skills stay under 500 lines; the doctor checks this.
- Run `bun run agent:doctor` after cloning, after changing `.claude/` or `.mcp.json`, and whenever a skill or MCP server misbehaves.

---

## 4. Every file and what it is for

| Path | What it is | Who writes it | When to read it |
|---|---|---|---|
| `CLAUDE.md` | This hub: how to work, tools, file map, rules | Humans, by reviewed PR | Every session (loaded automatically) |
| `README.md` | Human overview: what works, how to run it | Humans | When onboarding |
| **State (`docs/`)** | | | |
| `docs/PROGRESS.md` | Where the build is: phase, sprint, step, completed, blocked, notes, session log | `/remember save` (and `/recover` reset notes) | **First**, every session |
| `docs/DECISIONS.md` | D1–D12 UNANSWERED (who answers each, what they block); A1–A15 ANSWERED | `/remember`, when an answer arrives; never deleted | Before planning any step |
| `docs/DEFERRED.md` | Deliberately not built, and what it would take (Version 2, Phase 12) | `/remember`, `/architect` | When something sounds like scope creep |
| `docs/SCHEMA_GOVERNANCE.md` | Database rulebook: migrations, naming, money, dates, effective dating, RLS, locking | Humans, by reviewed PR | Before any migration; in `/review` |
| `docs/ui-registry.md` | How screens apply the Design Brief; first audit; S2 fix list | `/imprint` | Before and after any UI work |
| `docs/init-test-db.sql` | Creates the test database in Docker | Humans | Rarely |
| **Specification (`docs/spec/`)**, read-only mirror of the shared document | | | |
| `01-PRD.md` | Business needs, users, modules, release scope, time budgets | Owner and architect | Scope questions |
| `02-Technical-Spec.md` | Architecture, data model, engines, security | Architect | Design questions |
| `03-Delivery-Phases.md` | 14 phases, 8 gates, who signs | Architect | Phase and gate context |
| `04-Build-Documents.md` | How the build documents fit together | Architect | Orientation |
| `05-TRD.md` | Every TR-ID requirement and the test that proves it | Architect | **Every step** (via spec-scout) |
| `06-App-Flow.md` | Screens (S/M/C/W IDs) and flows | Architect | Any UI or workflow step |
| `07-Backend-Schema.md` | Tables, constraints, endpoints | Architect | Any data or API step |
| `08-Implementation-Plan.md` | Sprints S1–S33: goals, demos, testing, cut-over | Architect | **Every step** |
| `09-Design-Brief.md` | Look and behaviour: shadcn/ui and the approved Aceternity list | Architect | Any UI step; `/imprint` |
| `diagrams/` | Ten diagrams referenced by the spec | Architect | As referenced |
| **Agent configuration and checks** | Skills, agents, hooks, settings, `.mcp.json`, `scripts/agent-doctor.ts`, CI — full map in `.claude/rules/agent-setup.md` | Humans, by reviewed PR | When changing the agent setup or CI |
| `scripts/gates.ts` | `bun run gates`: G1 migrations lock, G2 money types, G3 time zones, G4 sequences, G5 bun.lock only, G6 golden sign-off, G7 no Oman IBANs, G8 colours from tokens, G9 print spooler never panics, G10 desktop commands registered and called by the right names | Humans | When a gate fails: the message says what to do |
| **Product code** — each area's file map and stack notes load with its files | | | |
| `packages/core` | Pure domain engines (`checkEligibility`, money, dates, renewals, masters) → `.claude/rules/core.md` | Build steps, tests first | Before writing any rule: it may already exist |
| `apps/api` | NestJS on Bun, auth, files, masters, sponsors, migrations, API tests → `.claude/rules/api.md` | Build steps | Any API or data step |
| `apps/web`, `packages/ui`, demo | React interface, e2e, shadcn tokens, hosted demo → `.claude/rules/web.md` | Build steps | Any UI step |
| `apps/desktop` | Tauri 2 shell and Rust print spooler → `.claude/rules/desktop.md` | Build steps | Printing and desktop work |
| `docker-compose.yml` | Local PostgreSQL 16 (`mms_dev`, plus test database) | Humans | Local setup |
| **Upstream (`third_party/`)** | Verbatim JSM (video set and v2) and Karpathy sources, with commits and licences in `third_party/README.md` | Upstream only; never edited | To compare against or take an update |

---

## 5. The rules (numbered so reviews can cite them)

1. **Tests first.** A requirement becomes a failing test before it becomes code.
2. **Money** is OMR `NUMERIC(14,3)` in the database and `decimal.js` (`packages/core/src/money.ts`) in code; never a JavaScript `number`.
3. **Legal values** (hours, overtime, leave, end of service, deduction caps, the savings system) live only in dated `rule_versions`; never a literal in code or SQL.
4. **Golden expected values** in `**/golden/*.json` are set and signed by named people (payroll officer, accountant, labour lawyer). The AI adds cases with `"expected": null` and flags them. The guard hook and gate G6 enforce this.
5. **`checkEligibility()`** in `packages/core` is the single answer to "may this worker work here on these dates?". Roster, timesheets, payroll and matching all call it; nothing re-implements it. Overrides are records (who, why, until when), never silent bypasses.
6. **Four eyes:** bank details, wage changes, payroll release, rate cards, write-offs and overrides need a second person. Maker ≠ checker is enforced in the API and tested.
7. **Final means final:** locked timesheets, released payroll, issued invoices and closed periods are never overwritten; corrections are new records, enforced by trigger.
8. **Audit:** every write records a row in the hash-chained, append-only `audit_events`.
9. **Migrations:** a new numbered SQL file per change; applied migrations are never edited (`migrations.lock`, gate G1, guard hook).
10. **Codes** come from sequences (`worker_code_seq` → `W-000001`), never `MAX()+1`.
11. **Personal data:** none that is real, anywhere: code, tests, fixtures, prompts, screenshots, MCP queries or memory files. Use the seed generator. Mask passport, civil ID and bank numbers to the last 4 unless the role needs them, and audit every reveal. PDPL applies.
12. **Scope:** Version 2 and Phase 12 aren't built before their sprints. Shells (desktop, mobile) hold no business rules. Logic needed in two places goes in `packages/core`, and the server is the source of truth.
13. **Done** means `bun run gates`, `bun run typecheck` and `bun run test` pass, `/review` has no criticals, and `docs/PROGRESS.md` is updated.

## 6. Never

| Never | Instead | Enforced by |
|---|---|---|
| Edit an applied migration or `migrations.lock` by hand | Next numbered migration; `bun run gates --update-lock` | guard hook, G1 |
| `real` / `double precision` / `float` for money | `NUMERIC(14,3)` | G2 |
| `timestamp` without time zone | `timestamptz`, or `DATE` for calendar dates | G3 |
| `MAX()+1` for a code | Sequence or locked counter | G4 |
| npm, npx, pnpm, yarn or their lockfiles | `bun`, `bunx`, `bun.lock` | permissions, G5 |
| Set, change or delete a golden expected value or sign-off | `"expected": null`, flag for sign-off | guard hook, G6, `/review` |
| Real IBANs, IDs, names, phones or salaries anywhere | Seed generator | G7, `/review`, `/remember` |
| Hard-coded colours in UI code | Design Brief tokens | G8, `/imprint` |
| `unwrap()`/`expect()`/`panic!` in the print spooler; an IPC command that isn't registered; business rules in the desktop shell | `Result`; `/tauri-command`; logic in `packages/core` or the API | G9, G10, `/review` |
| `git checkout`/`switch`/`stash`/`pull` while the dev servers run | `git branch -f`, `git merge --ff-only` on the current branch | bash-guard hook |
| Read or write `.env` files | `.env.example` with placeholders; secrets in your shell | permissions, guard hook |
| Point the postgres MCP at production, or let it write | Local `mms_dev`, restricted mode | `.mcp.json`, agent:doctor |
| Commit a token into `.mcp.json` or settings | `${VAR}` expansion | `/review` |
| Re-implement eligibility, money or audit | Call the existing engine | `/review`, independent-reviewer |
| Let one person make and approve a four-eyes change | Separate checker, tested | `/review`, API tests |
| Delete, skip or weaken a test to go green | Fix the code, or explain in the PR why the test is wrong | `/review` |
| Build on an UNANSWERED decision | Mark the step blocked in PROGRESS | `/architect` |
| Build Version 2 or Phase 12 early | `docs/DEFERRED.md` | `/architect`, `/review` |
| Refactor or reformat code outside the step | Mention it; leave it | Karpathy 3, `/review` |
| Edit `third_party/` or install the JSM originals as personal skills (`~/.claude/skills/architect` etc.) | Change the project skills by PR; personal skills override project ones | agent:doctor warns |
| Trust a library API from memory | context7 | `/architect` |
| Claim a test or gate passed without running it | Report "not run" | `/review` |

## 7. Best practices

- **Plan, then build, then verify, in small steps.** One sprint step per session: plan in `/architect`, confirm, write tests, implement, run gates after every edit (automatic), `/review`, commit.
- **Ask early.** Clarifying questions belong before the code, not after a wrong build. One clear question with a recommended answer is better than a menu.
- **Cite.** Plans, reviews and PRs name TR-IDs, screen IDs and tables. "Not specified" is a valid answer; invention is not.
- **Write state down.** Anything the next session needs goes in `docs/`. Chat history is not memory.
- **Use the right tool** (section 3): docs from context7, components from shadcn, facts from the database through postgres, screens through playwright, reviews from a fresh agent.
- **Commit small, reviewed, green.** Every change goes through a pull request with green CI and a human reviewer. Payroll, compliance, security and migration changes need a senior reviewer. Commit messages say why.

## 8. Stack notes (learned the hard way)

- **Bun** is the runtime, package manager and test runner: `bun install`, `bun run`, `bunx`. The API runs on Bun everywhere (`bun src/main.ts`, `bun test`, `bun build --target=bun`).
- **Area notes** (postgres.js laziness, the self-contained API tsconfig, Vitest for web and mutation tests, Rust and Tauri) are in `.claude/rules/{api,web,core,desktop}.md` and load with those files.
- **Pin exact versions** for anything tied to a downloaded binary (`@playwright/test`).
- **TypeScript strict.** No `any` without a comment saying why.
- **Dates:** calendar dates are `YYYY-MM-DD` strings in Oman time (`DATE` in SQL); moments are `timestamptz`.
- **Modules** follow the PRD: workers, compliance, clients, roster, timesheets, payroll, billing, ledger.

## 9. Commands

```
bun install                 # once
docker compose up -d        # local PostgreSQL 16
bun run db:migrate && bun run db:seed
bun run gates               # repository rules (also runs after every agent edit)
bun run typecheck && bun run test
bun run test:tooling        # hook tests
bun run test:mutation       # core mutation score (CI gate 80 %)
bun run --filter @mms/desktop lint:rust   # Rust fmt + clippy -D warnings, both crates
bun run --filter @mms/desktop test:rust   # print spooler tests
bun run agent:doctor        # agent setup health
bun run dev:api / dev:web
```

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.
