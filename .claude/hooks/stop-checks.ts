#!/usr/bin/env bun
/**
 * Stop: before Claude ends a turn, run the slower checks the per-edit gates can't afford,
 * only for what this session edited (post-edit-gates.ts records the paths):
 *
 *   TypeScript in a workspace   → that workspace's typecheck (core also checks api and web)
 *   .claude/hooks               → the hook tests
 *   Rust in apps/desktop        → cargo fmt --check, clippy -D warnings, spooler tests
 *
 * On failure, exit 2 with the first lines of each failure so Claude fixes them before
 * stopping; the record is kept so the next stop checks again. On success, it is cleared.
 * The harness caps consecutive blocks (CLAUDE_CODE_STOP_HOOK_BLOCK_CAP in settings).
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

export type Check = { name: string; cmd: string[] };
const MAX_LINES = 40;

/** Where post-edit-gates.ts appends the paths edited in one session. */
export function editLog(sessionId: string): string {
  const dir = join(tmpdir(), "mms-claude-edits");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${sessionId.replace(/[^\w-]/g, "_")}.txt`);
}

const cargo = (crate: string, ...args: string[]) => ["cargo", args[0], "--manifest-path", `apps/desktop/${crate}/Cargo.toml`, ...args.slice(1)];
const rustChecks = (crate: string): Check[] => [
  { name: `rustfmt ${crate}`, cmd: cargo(crate, "fmt", "--check") },
  { name: `clippy ${crate}`, cmd: cargo(crate, "clippy", "--all-targets", "--message-format=short", "--", "-D", "warnings") },
];

/** The checks owed for a set of repo-relative, forward-slash paths. */
export function checksFor(paths: string[]): Check[] {
  const ts = (p: string) => /\.(ts|tsx)$/.test(p);
  const under = (prefix: string, pred: (p: string) => boolean = () => true) => paths.some((p) => p.startsWith(prefix) && pred(p));
  const rust = (p: string) => /\.rs$|Cargo\.toml$/.test(p);
  const out: Check[] = [];

  const typecheck = new Set<string>();
  if (under("packages/core/", ts)) ["core", "api", "web"].forEach((w) => typecheck.add(w));
  if (under("apps/api/", ts)) typecheck.add("api");
  if (under("apps/web/", ts)) typecheck.add("web");
  for (const w of typecheck) out.push({ name: `typecheck @mms/${w}`, cmd: ["bun", "run", "--filter", `@mms/${w}`, "typecheck"] });

  if (under(".claude/hooks/") || under("scripts/")) out.push({ name: "tooling tests", cmd: ["bun", "test", "./.claude/hooks", "./scripts"] });

  const spooler = under("apps/desktop/print-spooler/", rust);
  const shell = under("apps/desktop/src-tauri/", (p) => rust(p) || p.endsWith("tauri.conf.json") || p.includes("/capabilities/"));
  if (spooler) out.push(...rustChecks("print-spooler"), { name: "cargo test print-spooler", cmd: cargo("print-spooler", "test") });
  if (spooler || shell) out.push(...rustChecks("src-tauri")); // the shell depends on the spooler
  return out;
}

/**
 * Whether the knowledge graph (graphify-out/) needs an AST refresh: code changed and a graph exists.
 * `graphify update .` is local and free (no LLM); docs need `/graphify --update` and are left to a person.
 */
export function graphUpdateOwed(paths: string[], hasGraph: boolean): boolean {
  return hasGraph && paths.some((p) => /\.(ts|tsx|rs|sql)$/.test(p) && !p.startsWith(".claude/") && !p.startsWith("third_party/"));
}

/** Whether the parent-folder mirror (scripts/sync-root-settings.ts) must be regenerated. */
export function mirrorOwed(paths: string[]): boolean {
  return paths.some((p) => [".claude/settings.json", ".claude/settings.local.json", ".mcp.json", "scripts/sync-root-settings.ts"].includes(p));
}

const NO_LINKER = /linking with `link\.exe` failed|linker `link\.exe` not found/;

if (import.meta.main) {
  let input: { session_id?: string };
  try { input = JSON.parse(await Bun.stdin.text()); } catch { process.exit(0); }
  const root = process.env.CLAUDE_PROJECT_DIR ?? join(import.meta.dir, "../..");
  const log = editLog(input.session_id ?? "unknown");
  if (!existsSync(log)) process.exit(0);

  const paths = [...new Set(readFileSync(log, "utf8").split("\n").filter(Boolean))]
    .map((p) => relative(root, resolve(root, p)).replaceAll("\\", "/"))
    .filter((p) => !p.startsWith(".."));

  const failures: string[] = [];
  const skipped: string[] = [];
  for (const c of checksFor(paths)) {
    const r = Bun.spawnSync(c.cmd, { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode === 0) continue;
    const out = `${r.stdout.toString()}\n${r.stderr.toString()}`;
    if (NO_LINKER.test(out)) { skipped.push(c.name); continue; }
    const lines = out.split("\n").filter((l) => l.trim() && !/^\s*(Compiling|Checking|Finished|Running|Blocking)\b/.test(l));
    failures.push(`── ${c.name} (\`${c.cmd.join(" ")}\`)\n${lines.slice(0, MAX_LINES).join("\n")}${lines.length > MAX_LINES ? `\n… ${lines.length - MAX_LINES} more lines` : ""}`);
  }

  if (failures.length) {
    console.error(`Checks failed for files edited this session — fix before finishing (CLAUDE.md rule 13):\n\n${failures.join("\n\n")}`);
    process.exit(2);
  }
  const notes: string[] = [];
  if (skipped.length) notes.push(`Skipped (no MSVC linker on this PC; CI runs them): ${skipped.join(", ")}`);
  if (graphUpdateOwed(paths, existsSync(join(root, "graphify-out/graph.json")))) {
    const g = Bun.which("graphify") ? Bun.spawnSync(["graphify", "update", "."], { cwd: root, stdout: "pipe", stderr: "pipe" }) : null;
    if (!g) notes.push("Knowledge graph not refreshed: graphify is not on PATH (uv tool install \"graphifyy[sql,mcp]\")");
    else if (g.exitCode !== 0) notes.push(`Knowledge graph refresh failed: ${g.stderr.toString().trim().split("\n").pop()}`);
  }
  if (mirrorOwed(paths)) {
    const m = Bun.spawnSync(["bun", "scripts/sync-root-settings.ts"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (m.exitCode !== 0) notes.push(`Parent workspace mirror not refreshed: ${m.stderr.toString().trim().split("\n").pop()} — run: bun run agent:sync-root`);
  }
  rmSync(log, { force: true });
  if (notes.length) console.log(JSON.stringify({ systemMessage: notes.join(" · ") }));
  process.exit(0);
}
