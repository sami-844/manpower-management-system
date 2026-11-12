#!/usr/bin/env bun
/**
 * `bun run agent:doctor` — checks that the agent setup will actually work on this machine:
 * skills load (and aren't shadowed), hooks point at real scripts, MCP servers have what they
 * need, and no upstream file can leak instructions. Exits 1 only on FAIL; WARN is advice.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
type Level = "PASS" | "WARN" | "FAIL";
const results: [Level, string][] = [];
const say = (l: Level, m: string) => results.push([l, m]);
const onPath = (bin: string) => Bun.which(bin) !== null;
const json = (p: string) => { try { return JSON.parse(readFileSync(join(ROOT, p), "utf8")); } catch (e) { say("FAIL", `${p}: not valid JSON (${(e as Error).message})`); return null; } };

// Bun
const [maj = 0, min = 0] = Bun.version.split(".").map(Number);
say(maj > 1 || (maj === 1 && min >= 4) ? "PASS" : "FAIL", `Bun ${Bun.version} (need ≥ 1.4)`);

// Skills
const skillsDir = join(ROOT, ".claude/skills");
const skills = readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory());
for (const s of skills) {
  const f = join(skillsDir, s, "SKILL.md");
  if (!existsSync(f)) { say("FAIL", `skill ${s}: no SKILL.md`); continue; }
  const text = readFileSync(f, "utf8");
  const fm = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  if (!/^description:/m.test(fm)) say("FAIL", `skill ${s}: front matter has no description, so it will never auto-load`);
  const lines = text.split("\n").length;
  say(lines <= 500 ? "PASS" : "WARN", `skill /${s}: ${lines} lines${lines > 500 ? " (docs advise under 500; move reference material to a supporting file)" : ""}`);
  const personal = join(homedir(), ".claude/skills", s);
  if (existsSync(personal)) say("WARN", `~/.claude/skills/${s} exists and OVERRIDES the project /${s} (personal beats project). Rename or remove the personal one to use this project's version`);
}

// Agents
const agentsDir = join(ROOT, ".claude/agents");
for (const a of existsSync(agentsDir) ? readdirSync(agentsDir).filter((f) => f.endsWith(".md")) : []) {
  const fm = readFileSync(join(agentsDir, a), "utf8").match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  say(/^name:/m.test(fm) && /^description:/m.test(fm) ? "PASS" : "FAIL", `agent ${a}: name and description`);
}

// Settings and hooks
const settings = json(".claude/settings.json");
if (settings) {
  say("PASS", ".claude/settings.json is valid JSON");
  for (const groups of Object.values(settings.hooks ?? {}) as { hooks: { command: string }[] }[][])
    for (const g of groups) for (const h of g.hooks) {
      const script = h.command.match(/\.claude\/hooks\/[\w.-]+/)?.[0];
      if (script) say(existsSync(join(ROOT, script)) ? "PASS" : "FAIL", `hook script ${script}`);
    }
}

// MCP servers
const mcp = json(".mcp.json");
if (mcp) {
  say("PASS", `.mcp.json is valid JSON (${Object.keys(mcp.mcpServers).length} servers)`);
  for (const [name, s] of Object.entries(mcp.mcpServers) as [string, { command?: string; type?: string; url?: string }][]) {
    if (s.url && !s.type) say("FAIL", `MCP ${name}: has url but no type (read as stdio)`);
    if (s.command && !onPath(s.command)) say("WARN", `MCP ${name}: '${s.command}' not on PATH — install it (uvx comes with uv: https://docs.astral.sh/uv/)`);
  }
  if (mcp.mcpServers.github) say(process.env.GITHUB_PAT ? "PASS" : "WARN", `MCP github: GITHUB_PAT ${process.env.GITHUB_PAT ? "set" : "not set — the server will fail to authenticate (and D10: no repository yet)"}`);
  if (mcp.mcpServers.postgres) {
    const url = process.env.MCP_DATABASE_URL ?? "postgresql://mms:mms@localhost:5432/mms_dev";
    if (/amazonaws\.com|prod/i.test(url)) say("FAIL", "MCP postgres: MCP_DATABASE_URL points at a production-looking database. The agent may only see the local seeded database (fictional data)");
    else say("PASS", `MCP postgres: read-only (restricted) on ${url.replace(/\/\/[^@]*@/, "//***@")}`);
  }
}

// Path-scoped rules: without `paths:` a rule file loads every session, which defeats the split
const rulesDir = join(ROOT, ".claude/rules");
for (const r of existsSync(rulesDir) ? readdirSync(rulesDir).filter((f) => f.endsWith(".md")) : []) {
  const fm = readFileSync(join(rulesDir, r), "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  say(/^paths:/m.test(fm) ? "PASS" : "WARN", `rule ${r}: ${/^paths:/m.test(fm) ? "path-scoped" : "no paths: front matter, so it loads every session"}`);
}

// The hub keeps every numbered rule (reviews cite them by number)
const hub = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");
const missingRules = Array.from({ length: 13 }, (_, i) => i + 1).filter((n) => !new RegExp(`^${n}\\. \\*\\*`, "m").test(hub));
say(missingRules.length ? "FAIL" : "PASS", missingRules.length ? `CLAUDE.md is missing rule(s) ${missingRules.join(", ")} — rules stay in the hub, never in .claude/rules` : "CLAUDE.md has rules 1–13");

// Personal settings never get committed
const ignored = Bun.spawnSync(["git", "check-ignore", "-q", ".claude/settings.local.json"], { cwd: ROOT }).exitCode === 0;
say(ignored ? "PASS" : "FAIL", `.claude/settings.local.json ${ignored ? "is git-ignored" : "is NOT git-ignored — add it to .gitignore"}`);

// Code intelligence and Rust tools behind the LSP plugins and the Stop hook
for (const [bin, fix] of [["typescript-language-server", "bun add -g typescript-language-server typescript@<project version>"], ["rust-analyzer", "rustup component add rust-analyzer"]] as const)
  say(onPath(bin) ? "PASS" : "WARN", `LSP ${bin} ${onPath(bin) ? "on PATH" : `not on PATH — the LSP plugin can't start (${fix})`}`);
if (onPath("cargo")) {
  for (const sub of ["fmt", "clippy"]) {
    const ok = Bun.spawnSync(["cargo", sub, "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
    say(ok ? "PASS" : "WARN", `cargo ${sub} ${ok ? "installed" : `missing — rustup component add ${sub === "fmt" ? "rustfmt" : "clippy"}`}`);
  }
  if (process.platform === "win32") {
    const vswhere = join(process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)", "Microsoft Visual Studio/Installer/vswhere.exe");
    const vc = existsSync(vswhere) && Bun.spawnSync([vswhere, "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"]).stdout.toString().trim();
    say(vc ? "PASS" : "WARN", vc ? "MSVC linker available (Rust builds locally)" : "No MSVC build tools — Rust clippy/tests/tauri dev can't link here; install VS 2022 Build Tools with 'Desktop development with C++'");
  }
} else say("WARN", "cargo not on PATH — desktop checks run only in CI");

// Token savers: graphify (knowledge graph + MCP + hooks) and rtk (compressed command output)
if (!onPath("graphify") || !onPath("graphify-mcp")) say("WARN", "graphify not on PATH — its hooks and MCP server fail. Install: uv tool install \"graphifyy[sql,mcp]\"");
else {
  const graph = join(ROOT, "graphify-out/graph.json");
  if (!existsSync(graph)) say("WARN", "No knowledge graph yet — build it: graphify extract . --code-only (then /graphify . for the spec)");
  else {
    const head = Number(Bun.spawnSync(["git", "log", "-1", "--format=%ct"], { cwd: ROOT }).stdout.toString().trim()) * 1000;
    const stale = head > statSync(graph).mtimeMs;
    say(stale ? "WARN" : "PASS", stale ? "Knowledge graph is older than the last commit — run: graphify update ." : "Knowledge graph is current");
  }
  const hooks = Bun.spawnSync(["graphify", "hook", "status"], { cwd: ROOT }).stdout.toString();
  say(/installed/i.test(hooks) && !/not installed/i.test(hooks) ? "PASS" : "WARN", /installed/i.test(hooks) && !/not installed/i.test(hooks) ? "graphify git hooks keep the graph current on commit/checkout" : "graphify git hooks not installed — run: graphify hook install (the Stop hook covers Claude's own edits)");
}
say(onPath("rtk") ? "PASS" : "WARN", onPath("rtk") ? "rtk on PATH (Bash output compression)" : "rtk not on PATH — a global `rtk hook claude` hook would fail on every Bash call (winget install rtk-ai.rtk, then restart the editor)");

// Prompt routing: ponytail and caveman plugins (user scope) must be installed and not switched off here
const userPlugins = (() => { try { return JSON.parse(readFileSync(join(homedir(), ".claude/plugins/installed_plugins.json"), "utf8")).plugins ?? {}; } catch { return {}; } })();
const localPlugins = existsSync(join(ROOT, ".claude/settings.local.json")) ? json(".claude/settings.local.json")?.enabledPlugins ?? {} : {};
for (const p of ["ponytail@ponytail", "caveman@caveman"]) {
  const off = localPlugins[p] === false || settings?.enabledPlugins?.[p] === false;
  say(userPlugins[p] && !off ? "PASS" : "WARN", userPlugins[p] && !off ? `${p} active (the prompt router picks its workflows)` : `${p} ${off ? "is switched off for this project" : "not installed"} — the prompt router's ${p.split("@")[0]} routes do nothing`);
}

// Parent workspace mirror: hooks and guards must load when the editor opens Manpower-Management-System/
const { expected, hasParent } = await import("./sync-root-settings");
if (hasParent()) {
  const drift = Object.entries(expected()).filter(([f, body]) => !existsSync(f) || readFileSync(f, "utf8") !== body);
  say(drift.length ? "FAIL" : "PASS", drift.length ? "Parent workspace settings are missing or out of date — opening the parent folder would skip the hooks and guards. Run: bun run agent:sync-root" : "Parent workspace folder mirrors the hooks, guards and token savers");
}

// Upstream isolation
for (const bad of ["CLAUDE.md", ".claude"]) {
  const hits = existsSync(join(ROOT, "third_party")) ? readdirSync(join(ROOT, "third_party")).filter((d) => existsSync(join(ROOT, "third_party", d, bad))) : [];
  say(hits.length ? "FAIL" : "PASS", hits.length ? `third_party/${hits[0]}/${bad} would load upstream instructions — rename it (see third_party/README.md)` : `third_party has no ${bad}`);
}

// State freshness
const last = readFileSync(join(ROOT, "docs/PROGRESS.md"), "utf8").match(/\*\*Last session:\*\* (\d{4}-\d{2}-\d{2})/)?.[1];
if (!last) say("FAIL", "docs/PROGRESS.md has no **Last session:** date");
else {
  const days = Math.floor((Date.now() - Date.parse(last)) / 86_400_000);
  say(days <= 7 ? "PASS" : "WARN", `docs/PROGRESS.md last updated ${last} (${days} days ago)${days > 7 ? " — run /remember save at the end of each session" : ""}`);
}

for (const [l, m] of results) console.log(`${l}  ${m}`);
const fails = results.filter(([l]) => l === "FAIL").length;
const warns = results.filter(([l]) => l === "WARN").length;
console.log(`\n${fails} fail, ${warns} warn, ${results.length - fails - warns} pass`);
process.exit(fails ? 1 : 0);
