#!/usr/bin/env bun
/**
 * PostToolUse: after every Edit | Write | MultiEdit, run the repository gates.
 * On failure, exit 2 so Claude sees the failures (stderr) and fixes them in the same turn.
 * The tool has already run; this cannot undo it, only report.
 * It also records the edited path, so stop-checks.ts knows which slower checks the turn owes.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { editLog } from "./stop-checks";

const root = process.env.CLAUDE_PROJECT_DIR ?? join(import.meta.dir, "../..");
try {
  const { session_id, tool_input } = JSON.parse(await Bun.stdin.text());
  if (session_id && tool_input?.file_path) appendFileSync(editLog(session_id), `${tool_input.file_path}\n`);
} catch {
  // A payload we can't read still gets the gates below.
}

const proc = Bun.spawnSync(["bun", join(root, "scripts/gates.ts")], { cwd: root, stdout: "pipe", stderr: "pipe" });
if (proc.exitCode !== 0) {
  const out = `${proc.stdout.toString()}\n${proc.stderr.toString()}`.trim();
  console.error(`bun run gates failed after this edit — fix before continuing:\n${out}`);
  process.exit(2);
}
process.exit(0);
