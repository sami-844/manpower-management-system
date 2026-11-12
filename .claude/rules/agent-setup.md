---
paths:
  - ".claude/**"
  - ".mcp.json"
  - "scripts/agent-doctor.ts"
  - "scripts/gates.ts"
  - ".github/**"
---

# Agent setup: servers, agents, hooks, permissions

Moved out of `CLAUDE.md` section 3 so it loads only when the agent setup itself is being read or changed. Which tool to use for which job stays in `CLAUDE.md`.

## MCP servers (`.mcp.json`, project scope)

Claude Code asks you to approve project servers once. The low-risk documentation and UI servers are pre-approved in `.claude/settings.json` (`enabledMcpjsonServers`). **github** and **postgres** need your explicit approval (per person, in `.claude/settings.local.json` or `/mcp`). Run `/mcp` to see their status. MCP tools are loaded on demand (tool search), so having all nine costs little context.

| Server | Runs as | Needs | Safety |
|---|---|---|---|
| context7 | `bunx @upstash/context7-mcp` | — | Read-only public docs |
| shadcn | `bunx --bun shadcn@latest mcp` | `components.json` (from S2) | Writes only when you ask it to install a component |
| playwright | `bunx @playwright/mcp@latest` | Web app running locally | Local browser; never log in to real systems with it |
| graphify | `graphify-mcp graphify-out/graph.json` | `uv tool install "graphifyy[sql,mcp]"`; a built graph | Read-only graph queries (`query_graph`, `get_node`, `get_neighbors`, `shortest_path`, `god_nodes`…); the PR tools call `gh pr view/diff` read-only |
| playwright-desktop | `bunx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:9222` | The Tauri shell started with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` | Drives the real desktop window (WebView2), IPC included; local only |
| postgres | `uvx postgres-mcp --access-mode=restricted` | uv; `MCP_DATABASE_URL` (default: local `mms_dev`) | **Read-only transactions**. Local seeded database with fictional workers only. `bun run agent:doctor` fails if the URL looks like production. Schema changes go through migrations, data changes through the API. |
| github | HTTP `api.githubcopilot.com/mcp/` | `GITHUB_PAT` in your shell (never in a file); repository (D10) | Use a fine-grained token scoped to this repository |
| aws-docs | `uvx awslabs.aws-documentation-mcp-server@latest` | uv | Read-only public docs |
| terraform | `uvx awslabs.terraform-mcp-server@latest` | uv | Docs and scans; it never applies changes. `terraform apply` is a human step. |

Never put a token, password or connection string with real credentials into `.mcp.json`. It is committed. Use `${VAR}` and set the value in your shell.

## Token savers

| Tool | Scope | What it saves | How it is kept safe |
|---|---|---|---|
| **graphify** (knowledge graph, `graphify-out/`, git-ignored) | Project: skill `.claude/skills/graphify`, MCP server, hooks, a `## graphify` section at the end of `CLAUDE.md` (graphify owns it; `graphify claude uninstall` removes it) | Answers "where is X / what calls Y / what depends on Z" from a scoped subgraph instead of grepping and reading files. Code and the 13 migrations (SQL extra) are mapped symbol by symbol; the spec is in at concept level only (one pass, 2026-11-11: ~395k plan tokens; per-requirement extraction would cost ~1.5–2M and still not link to code), so TR-IDs, screens and tables go through `spec-scout` | Code is parsed locally (tree-sitter). The spec pass ran once through the Claude CLI (content to Anthropic only). Hooks are advisory nudges with a 10 s timeout, never strict blocks. `.graphifyignore` keeps out `third_party/`, `.claude/`, generated files |
| **Graph freshness** | Stop hook (`graphify update .` after a turn that edited code, AST-only, no API cost); `graphify hook install` adds git hooks for commits, checkouts and pulls (run it yourself; auto mode won't install persistence) | — | `agent:doctor` warns when the graph is older than the last commit. Spec changes need `/graphify . --update` (LLM pass) |
| **rtk** (user-level hook `rtk hook claude`, `~/.claude/RTK.md`) | All projects | Compresses Bash output (git, cargo, tsc, vitest, playwright, bun…) before it reaches context; `rtk gain` shows savings, `rtk discover` finds missed ones | Returns "allow" only for commands these settings already allow; asked and denied commands (`git push`, `db:migrate`, `bun add`, `npm`, `rm -rf`, force-push) keep their prompt or denial; the bash-guard still sees the original command. `rtk bypass <cmd>` when compressed output is unusable |
| **caveman** (user plugin, standard level) | All sessions and subagents | Shorter chat replies (output tokens cost about 5× input) | Code, commands, paths and errors stay verbatim; files, commits, docs, PRs and memory are written in plain prose (its rule 5); warnings and irreversible actions in full sentences. `/caveman off` to pause |
| **ponytail** (user plugin, full level; on in this project since 2026-11-12) | All sessions and subagents | Less code written and read: reuse, stdlib, native, then the minimum | Its own "never simplify away" list (validation, error handling, security) plus the router's precedence line: rules 1–13, TR tests, gates and the mutation score win |
| **Prompt router** (`.claude/hooks/prompt-router.ts`, UserPromptSubmit) | Every prompt, no slash command needed | Picks the workflow by intent (bug → investigate-first + surgical-patch, refactor → safe-refactor, build → lean-build, verify → verify-and-stop, review → ponytail-review + caveman-review, audit → ponytail-audit, commit → caveman-commit), inlining the ~100-word caveman task skills instead of spending a Skill call. Code prompts also get a `graphify query` slice capped at 600 tokens, seeded from the code names the prompt mentions (`backticks`, camelCase, snake_case, paths); without a name, a match that sprawls past 200 nodes is dropped as noise | Only the user's own words are routed: blocks the editor attaches (`<browser_instruction>`, `<system-reminder>`) are stripped first. Slash commands and prose prompts pass untouched; fails open. Adds about 1k tokens to a code prompt, which one avoided file read repays. Tested in `prompt-router.test.ts` |
| **Read deny list** (`.claude/settings.json`) | Project | Stops accidental reads of `bun.lock`, build output, drizzle snapshots, `graph.json` | Use `git diff`, `bun pm ls`, the graph tools or `drizzle-kit` instead |
| **LSP** (below) and **path-scoped rules** (`.claude/rules/`) | Project | Definitions and references instead of whole-file reads; area notes load only with their files | — |

Considered and left out: **context-mode** (its `ctx_execute` runs commands outside Bash, so the deny list and bash-guard would not apply); **token-savior / code-review-graph / Serena** (overlap graphify + LSP); **claude-context** (sends code to OpenAI and Zilliz); **token-optimizer** (non-commercial licence); **claude-code-router** (routes work to other providers); **claude-mem** (overlaps `/remember` and `docs/PROGRESS.md`).

## Code intelligence (LSP plugins, `.claude/settings.json` `enabledPlugins`)

`typescript-lsp` and `rust-analyzer-lsp` give Claude go-to-definition, find-references and diagnostics after every edit, instead of grepping and reading whole files. They need `typescript-language-server` (`bun add -g typescript-language-server typescript@<project version>`) and `rust-analyzer` (`rustup component add rust-analyzer`) on PATH; `bun run agent:doctor` warns when either is missing.

## Subagents (`.claude/agents/`)

| Agent | Model | Tools | Use for |
|---|---|---|---|
| `spec-scout` | haiku | Read, Grep, Glob | Cited spec lookup for a step (used by `/architect`) |
| `independent-reviewer` | opus | Read, Grep, Glob, Bash; no Write or Edit | Fresh-context review of high-stakes diffs, desktop IPC/capabilities/CSP included (used by `/review`, `/new-migration`, `/tauri-command`) |
| `mutant-hunter` | sonnet | Read, Grep, Glob, Bash, Edit, Write — `packages/core` test files only | Kills surviving Stryker mutants with sharper tests when the mutation score nears the 80 % gate |

Run one by asking for it ("Use the spec-scout agent for S5") or with `@agent-spec-scout`. Subagents keep long searches and reviews out of the main context, and a reviewer that never saw the build can't mark its own homework. Subagents without a `model:` line run on `CLAUDE_CODE_SUBAGENT_MODEL` (sonnet, set in `.claude/settings.json`); the three above pin their own.

## Hooks (`.claude/settings.json`): enforced, not advisory

| Event | Script | Effect |
|---|---|---|
| SessionStart | `.claude/hooks/session-start.ts` | Puts the PROGRESS header, blocked items and open decisions into context |
| PreToolUse (Edit, Write, MultiEdit) | `.claude/hooks/guard.ts` | **Blocks** writes to `.env*`, hand edits to `migrations.lock`, edits to applied migrations, and any change to a signed golden value, a sign-off, a deleted golden case, or a new case without `"expected": null`. Tested in `guard.test.ts`. |
| PreToolUse (Bash) | `.claude/hooks/bash-guard.ts` | **Blocks** git commands that rewrite the working tree (checkout, switch, stash, restore, pull, merge, rebase, hard reset…) while the dev servers listen on :5173 or :3100; creating a branch at HEAD is allowed. Tested in `bash-guard.test.ts`. |
| PostToolUse (Edit, Write, MultiEdit) | `.claude/hooks/post-edit-gates.ts` | Runs `bun run gates` (about 50 ms) after every edit and sends failures straight back to Claude; records the edited path for the Stop hook |
| Stop | `.claude/hooks/stop-checks.ts` | Before a turn ends, runs what that session's edits owe: workspace typecheck (core → core, api, web), hook tests, and for Rust `cargo fmt --check`, `clippy -D warnings` and the spooler tests. Failures (first 40 lines each) go back to Claude; at most 3 blocks in a row (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`). Then refreshes the knowledge graph if code changed, and the parent-folder mirror if settings or `.mcp.json` changed. Tested in `stop-checks.test.ts`. |
| UserPromptSubmit | `.claude/hooks/prompt-router.ts` | Adds the ponytail/caveman workflow for the prompt's intent and, for code prompts, a 600-token graph slice (see Token savers) |
| PreToolUse (Bash\|Grep, Read\|Glob), SessionStart (compact) | `graphify hook-guard … --strict` (written by `graphify install --project`) | Nudges Claude to query the graph before searching or reading source. **Strict:** the first raw Read or Grep of indexed code in a session is redirected to the graph when no graph query ran in the last 30 minutes (the router's query counts); after that, nudges only, on a per-session budget reset after compaction |

## Permissions (`.claude/settings.json`)

- **Allowed without asking:** gates, typecheck (workspaces and tooling), tests, the doctor, read-only git, and `cargo fmt`/`clippy`/`test`/`check` (they only build and read; the Stop hook and `lint:rust` run them).
- **Asks first:** `git push`, `gates --update-lock`, `db:migrate`, `bun add`, and edits to the desktop security surface (`apps/desktop/src-tauri/capabilities/**`, `tauri.conf.json`).
- **Denied:** reading `.env` files; npm, npx, pnpm and yarn; force-push; `git reset --hard`; `rm -rf`.
- Personal exceptions (and plugins you turn off for this project) go in `.claude/settings.local.json` (git-ignored), never in the shared file.

## Files

| Path | What it is | Who writes it | When to read it |
|---|---|---|---|
| `.claude/skills/{architect,review,imprint,recover,remember}/SKILL.md` | The adapted JSM loop | Humans, by reviewed PR | Loaded by `/name` or automatically |
| `.claude/skills/{new-migration,tauri-command}/SKILL.md` | Fixed-order workflows for the two changes that can't be undone casually; user-invoked only | Humans, by reviewed PR | `/new-migration`, `/tauri-command` |
| `.claude/skills/tr-test/SKILL.md` | One TR-ID → one failing test (rule 1) | Humans, by reviewed PR | `/tr-test TR-XXX-NN`, or automatically when building starts |
| `.claude/skills/karpathy-guidelines/SKILL.md` | Verbatim Karpathy guidelines | Upstream only | Loaded automatically when coding |
| `.claude/skills/graphify/`, `.claude/CLAUDE.md` | The graphify skill and its trigger registration (`graphify install --project`, v0.9.106) | Upstream only; update with `uv tool upgrade graphifyy` then `graphify install --project` | `/graphify` |
| `.graphifyignore` | What the knowledge graph leaves out | Humans | When the graph misses or over-includes files |
| `.claude/rules/*.md` | Path-scoped parts of this hub: load only when Claude reads or edits matching files | Humans, by reviewed PR | Automatically |
| `.claude/agents/*.md` | `spec-scout`, `independent-reviewer`, `mutant-hunter` | Humans | Called by the skills |
| `.claude/hooks/*.ts` | SessionStart summary, PreToolUse guards, PostToolUse gates, Stop checks (each with tests) | Humans, with tests | When a hook blocks you: read its message |
| `.claude/settings.json` | Shared permissions, hooks, approved MCP servers, LSP plugins | Humans, by reviewed PR | When a command is denied or prompts |
| `.mcp.json` | The nine project MCP servers | Humans, by reviewed PR | `/mcp` |
| `scripts/sync-root-settings.ts` → `../../.claude/settings.json`, `../../.mcp.json` | Mirrors the hooks, guards, permissions, plugin switches and the graphify server into the parent `Manpower-Management-System/` folder, so opening the wrong folder still loads them. The parent folder is not in git, so the mirror is per machine; skills, rules and the other MCP servers need the subfolder | Generated: `bun run agent:sync-root`; the Stop hook regenerates it after settings edits | `agent:doctor` fails when it drifts |
| `scripts/agent-doctor.ts` | `bun run agent:doctor`: skills, agents, rules, hooks, MCP prerequisites, LSP and Rust tools, shadowed personal skills, upstream isolation, CLAUDE.md rule numbering, PROGRESS freshness | Humans | After cloning or changing agent config |
| `.github/workflows/ci.yml` | gates → typecheck → test → mutation → builds → e2e → API image → Windows installer (Rust fmt, clippy, tests, then the build) | Humans | When CI fails |
