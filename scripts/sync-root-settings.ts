#!/usr/bin/env bun
/**
 * Mirrors this project's Claude Code setup into the parent workspace folder
 * (`../../.claude/settings.json` and `../../.mcp.json`, two levels up), so the
 * hooks, guards, permissions and token savers still load when VS Code is opened on
 * `Manpower-Management-System/` instead of `04-Build/manpower-system/`.
 *
 * Generated, never hand-edited: `bun run agent:sync-root` writes it, and
 * `agent:doctor` fails when it drifts. The parent folder is not in git, so this is
 * per machine. Only the graphify MCP server is mirrored; the others need this
 * folder's working directory (shadcn reads components.json), so open the
 * subfolder for them.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
export const PARENT = join(ROOT, "../..");
export const SUB = "04-Build/manpower-system";

type Hook = { type: string; command: string; timeout?: number };
type Group = { matcher?: string; hooks: Hook[] };

/** Runs a project hook from the parent workspace: project dir and cwd both point at the subfolder. */
export function rootCommand(cmd: string): string {
  return `export CLAUDE_PROJECT_DIR="$CLAUDE_PROJECT_DIR/${SUB}" && cd "$CLAUDE_PROJECT_DIR" && ${cmd}`;
}

/** Path rules are relative to the open folder; `./**` rules already cover the whole tree. */
export function rootRule(rule: string): string {
  const [, tool, path] = rule.match(/^(Read|Edit)\((.*)\)$/) ?? [];
  if (!tool || path === undefined || path.startsWith("./**/")) return rule;
  return `${tool}(./${SUB}/${path.replace(/^\.\//, "")})`;
}

export function rootSettings(project: any, local: any = {}): any {
  const hooks = Object.fromEntries(
    Object.entries(project.hooks ?? {}).map(([event, groups]) => [
      event,
      (groups as Group[]).map((g) => ({ ...g, hooks: g.hooks.map((h) => ({ ...h, command: rootCommand(h.command) })) })),
    ]),
  );
  const perms = project.permissions ?? {};
  return {
    $schema: project.$schema,
    permissions: Object.fromEntries(Object.entries(perms).map(([k, rules]) => [k, (rules as string[]).map(rootRule)])),
    enabledMcpjsonServers: ["graphify"],
    enabledPlugins: { ...project.enabledPlugins, ...local.enabledPlugins },
    env: project.env,
    hooks,
  };
}

export function rootMcp(mcp: any): any {
  const g = mcp.mcpServers?.graphify;
  return { mcpServers: g ? { graphify: { ...g, args: [`${SUB}/graphify-out/graph.json`] } } : {} };
}

const readJson = (p: string) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {});
const text = (o: unknown) => JSON.stringify(o, null, 2) + "\n";

/** The two generated files, keyed by absolute path. */
export function expected(): Record<string, string> {
  return {
    [join(PARENT, ".claude/settings.json")]: text(rootSettings(readJson(join(ROOT, ".claude/settings.json")), readJson(join(ROOT, ".claude/settings.local.json")))),
    [join(PARENT, ".mcp.json")]: text(rootMcp(readJson(join(ROOT, ".mcp.json")))),
  };
}

/** The parent workspace exists only on machines that keep the full project folder. */
export const hasParent = () => existsSync(join(PARENT, SUB, "CLAUDE.md")) && existsSync(join(PARENT, "CLAUDE.md"));

if (import.meta.main) {
  if (!hasParent()) { console.log("No parent workspace folder here — nothing to mirror."); process.exit(0); }
  mkdirSync(join(PARENT, ".claude"), { recursive: true });
  for (const [file, body] of Object.entries(expected())) writeFileSync(file, body);
  console.log("Mirrored the Claude Code setup into the parent workspace folder.");
}
