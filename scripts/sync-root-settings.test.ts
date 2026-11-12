import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SUB, rootCommand, rootMcp, rootRule, rootSettings } from "./sync-root-settings";

test("hook commands run from the subfolder with its project dir", () => {
  expect(rootCommand("graphify hook-guard read --strict")).toBe(
    `export CLAUDE_PROJECT_DIR="$CLAUDE_PROJECT_DIR/${SUB}" && cd "$CLAUDE_PROJECT_DIR" && graphify hook-guard read --strict`,
  );
});

test("path rules are re-rooted; tree-wide and Bash rules stay as they are", () => {
  expect(rootRule("Read(./bun.lock)")).toBe(`Read(./${SUB}/bun.lock)`);
  expect(rootRule("Edit(apps/desktop/src-tauri/tauri.conf.json)")).toBe(`Edit(./${SUB}/apps/desktop/src-tauri/tauri.conf.json)`);
  expect(rootRule("Read(./**/.env)")).toBe("Read(./**/.env)");
  expect(rootRule("Bash(rm -rf *)")).toBe("Bash(rm -rf *)");
});

test("the real project settings keep every hook, rule and guard when mirrored", () => {
  const project = JSON.parse(readFileSync(join(import.meta.dir, "../.claude/settings.json"), "utf8"));
  const out = rootSettings(project, { enabledPlugins: { "x@y": false } });
  for (const [event, groups] of Object.entries<any[]>(project.hooks)) {
    expect(out.hooks[event].flatMap((g: any) => g.hooks).length).toBe(groups.flatMap((g) => g.hooks).length);
  }
  for (const k of ["allow", "ask", "deny"]) expect(out.permissions[k].length).toBe(project.permissions[k].length);
  expect(out.permissions.deny).toContain("Bash(git reset --hard *)");
  expect(out.enabledPlugins["x@y"]).toBe(false);
  expect(out.env).toEqual(project.env);
});

test("only graphify is mirrored to the parent .mcp.json, pointed at the subfolder graph", () => {
  const out = rootMcp({ mcpServers: { graphify: { command: "graphify-mcp", args: ["graphify-out/graph.json"] }, shadcn: {} } });
  expect(Object.keys(out.mcpServers)).toEqual(["graphify"]);
  expect(out.mcpServers.graphify.args).toEqual([`${SUB}/graphify-out/graph.json`]);
});
