#!/usr/bin/env bun
/**
 * UserPromptSubmit router: on every prompt, without being asked, it
 *  1. names the ponytail or caveman workflow that fits the kind of request (bug, build,
 *     refactor, review, audit, verify, commit), inlining the small caveman task skills so
 *     no extra Skill call is spent;
 *  2. for prompts about code, attaches a token-capped slice of the knowledge graph
 *     (`graphify query`), so Claude starts from the graph instead of grepping and reading.
 *
 * Ponytail and caveman are always on through their own plugin hooks; this only picks the
 * workflow. Slash commands are left alone (the user already chose). Fails open: any error
 * adds nothing and the prompt goes through unchanged.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const GRAPH_BUDGET = 600;

type Route = { kind: string; test: RegExp; skills: string[]; note: string };

// First match wins, so the narrower intents come first.
export const ROUTES: Route[] = [
  { kind: "commit", test: /\bcommit (message|this|it|these|the changes)\b|\b(write|make|create) (a |the )?commit\b/, skills: [],
    note: "Commit: use the caveman-commit skill (Conventional Commits, why over what). The body stays in plain sentences." },
  { kind: "audit", test: /\b(audit|bloat|over-?engineer\w*|what can (we|i) (delete|remove|cut))\b/, skills: [],
    note: "Audit: use the ponytail-audit skill for the ranked delete/simplify list." },
  { kind: "review", test: /\b(review|pull request|diff)\b|\bpr ?#?\d+/, skills: [],
    note: "Review: the project's /review loop owns this. Add the ponytail-review lens (over-engineering) and write findings caveman-review style: one line each, location, problem, fix." },
  { kind: "bug", test: /\b(bug|error|fail(s|ed|ing|ure)?|broken|crash\w*|not working|doesn'?t work|regression|flaky|exception|wrong (value|total|result)|why (does|is|did))\b/, skills: ["investigate-first", "surgical-patch"],
    note: "Bug: investigate first, then patch the narrowest layer that owns the behaviour, with a regression test." },
  { kind: "refactor", test: /\b(refactor\w*|clean ?up|restructure|extract|consolidate|rename|dedupe|simplify)\b/, skills: ["safe-refactor"],
    note: "Refactor: behaviour stays identical; the same tests prove it before and after." },
  { kind: "verify", test: /\b(verify|confirm|run (the )?(tests|gates|checks)|does (it|this) (pass|work)|is it (done|green))\b/, skills: ["verify-and-stop"],
    note: "Verify: prove it and stop; no new edits unless asked." },
  { kind: "build", test: /\b(add|build|implement|create|wire|integrate|support|feature|endpoint|screen|component|migration|sprint|step s\d+)\b/, skills: ["lean-build"],
    note: "Build: ponytail ladder (reuse, stdlib, native, then minimum code) inside the project loop (/architect, failing TR test, build, /review)." },
];

const CODE_KINDS = new Set(["bug", "refactor", "build", "review", "audit"]);
const EXPLORE = /\b(where (is|are|does)|which (file|module|function)|who calls|what (calls|uses|depends)|depends on|call(ers|s)? of|how does .{1,60} work|trace|flow of|impact of)\b/;
// camelCase / PascalCase identifiers, snake_case, `code`, or a source file path.
const IDENT = /`[^`]+`|\b[a-z]+[A-Z]\w*\b|\b[A-Z][a-z]+[A-Z]\w*\b|\b[a-z]+_[a-z_]+\b|[\w/.-]+\.(tsx?|rs|sql)\b/;

export const PRECEDENCE =
  "Precedence: project rules 1-13, TR-ID tests, gates and the 80% mutation score beat ponytail and caveman brevity. Never trim validation, error handling, security or tests.";

/** The user's own words: harness blocks the editor attaches (`<browser_instruction>…</…>`, `<system-reminder>…`) are not the request. */
export function userText(prompt: string): string {
  return prompt.replace(/<([a-z][\w-]*)(\s[^>]*)?>[\s\S]*?<\/\1>/gi, "").trim();
}

// A slice that starts from a handful of named symbols is useful; one that matched common words
// across the whole graph (hundreds of nodes) is noise that costs tokens and points nowhere.
export const MAX_FOUND = 200;
export function focused(slice: string): boolean {
  const n = Number(slice.match(/\| (\d+) nodes found/)?.[1]);
  return Number.isFinite(n) && n <= MAX_FOUND;
}

export function route(prompt: string): Route | null {
  const p = prompt.toLowerCase();
  return ROUTES.find((r) => r.test.test(p)) ?? null;
}

export function wantsGraph(prompt: string, kind: string | undefined): boolean {
  if (kind && CODE_KINDS.has(kind)) return true;
  return EXPLORE.test(prompt.toLowerCase()) || IDENT.test(prompt);
}

/** A SKILL.md body without its frontmatter, title or blank lines. */
export function skillBody(md: string): string {
  return md.replace(/^---[\s\S]*?\n---\s*\n/, "").split("\n").filter((l) => l.trim() && !l.startsWith("# ")).join("\n");
}

function cavemanSkill(name: string): string | null {
  try {
    const installed = JSON.parse(readFileSync(join(homedir(), ".claude/plugins/installed_plugins.json"), "utf8"));
    const dir = (installed.plugins ?? installed)["caveman@caveman"]?.[0]?.installPath;
    const file = dir && join(dir, "skills", name, "SKILL.md");
    return file && existsSync(file) ? skillBody(readFileSync(file, "utf8")) : null;
  } catch { return null; }
}

/** Code names the prompt mentions, in order: `backticked`, camelCase, PascalCase, snake_case, source paths. */
export function seeds(prompt: string): string[] {
  const found = [...prompt.matchAll(/`([^`\s]+)`|([\w/.-]+\.(?:tsx?|rs|sql))\b|\b([a-z]+[A-Z]\w*|[A-Z][a-z]+[A-Z]\w*|[a-z]+_[a-z_]+)\b/g)]
    .flatMap((m) => m[1] ?? m[2] ?? m[3] ?? []);
  return [...new Set(found)].slice(0, 3);
}

function query(root: string, args: string[]): string | null {
  const r = Bun.spawnSync(["graphify", "query", ...args, "--budget", String(GRAPH_BUDGET)], { cwd: root, timeout: 6000 });
  const out = r.stdout.toString().trim();
  return r.exitCode === 0 && out.includes("NODE ") ? out : null;
}

/** Anchored on the symbols the prompt names when it names any; otherwise kept only when the match is focused. */
function graphSlice(root: string, prompt: string): string | null {
  if (!existsSync(join(root, "graphify-out/graph.json"))) return null;
  try {
    const q = prompt.slice(0, 400);
    const named = seeds(prompt);
    const anchored = named.length ? query(root, [q, ...named.flatMap((s) => ["--seed", s])]) : null;
    if (anchored) return anchored;
    const loose = query(root, [q]);
    return loose && focused(loose) ? loose : null;
  } catch { return null; }
}

export function build(raw: string, root: string): string {
  const prompt = userText(raw);
  if (!prompt || prompt.startsWith("/")) return "";
  const r = route(prompt);
  const parts: string[] = [];
  if (r) {
    parts.push(`[prompt-router] ${r.note}`);
    for (const s of r.skills) {
      const body = cavemanSkill(s);
      if (body) parts.push(`caveman:${s}\n${body}`);
    }
    if (CODE_KINDS.has(r.kind)) parts.push(PRECEDENCE);
  }
  if (wantsGraph(prompt, r?.kind)) {
    const g = graphSlice(root, prompt);
    if (g) parts.push(`[graphify] Graph slice for this prompt (${GRAPH_BUDGET}-token cap). Start here; go deeper with the graphify MCP (get_node, get_neighbors, shortest_path) before reading whole files.\n${g}`);
  }
  return parts.join("\n\n");
}

if (import.meta.main) {
  try {
    const { prompt = "" } = JSON.parse(await Bun.stdin.text());
    const root = process.env.CLAUDE_PROJECT_DIR ?? join(import.meta.dir, "../..");
    const context = build(String(prompt), root);
    if (context) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } }));
  } catch { /* fail open */ }
  process.exit(0);
}
