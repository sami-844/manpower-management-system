#!/usr/bin/env bun
/**
 * PreToolUse guard for Bash. Blocks (exit 2, reason on stderr) git commands that rewrite
 * the working tree while the local dev servers run (web :5173, API :3100). On 2026-11-09
 * a checkout briefly deleted files, Vite cached the failed import, and the running app
 * broke. Move refs without touching files instead.
 *
 * Creating a branch at HEAD (`git switch -c x`, `git checkout -b x`) changes no file and
 * passes. Everything else passes (exit 0) to the normal permission flow.
 */
import { connect } from "node:net";

export const DEV_PORTS = [5173, 3100];

const REWRITES = /\bgit\s+(?:-[Cc]\s+\S+\s+)*(checkout|switch|stash|restore|rebase|merge|pull|cherry-pick|revert|am)\b([^;&|\n]*)/;
const HARD_RESET = /\bgit\s+(?:-[Cc]\s+\S+\s+)*reset\b[^;&|\n]*--(hard|merge|keep)\b/;
const NEW_BRANCH_AT_HEAD = /^\s*-[cbCB]\s+[^\s-]\S*\s*$/;

/** The git subcommand that would rewrite files, or null. */
export function rewritingGit(command: string): string | null {
  if (HARD_RESET.test(command)) return "reset";
  const m = command.match(REWRITES);
  if (!m) return null;
  if ((m[1] === "switch" || m[1] === "checkout") && NEW_BRANCH_AT_HEAD.test(m[2])) return null;
  return m[1];
}

/** Returns a reason to block, or null to allow. */
export function check(command: string, listening: number[]): string | null {
  const sub = rewritingGit(command);
  if (!sub || listening.length === 0) return null;
  return (
    `\`git ${sub}\` rewrites the working tree while dev servers listen on ${listening.map((p) => `:${p}`).join(", ")}; ` +
    "a checkout once broke the running app (Vite cached a missing import). Move refs without touching files " +
    "(`git branch -f <other-branch> <commit>`, `git merge --ff-only` on the current branch, `git push origin <commit>:<branch>`), " +
    "or ask the user to stop the dev servers first and restart `dev:web` afterwards."
  );
}

/** Vite listens on `localhost` only, which on Windows can be ::1 — so try both loopbacks. */
function open(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ port, host });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(300, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

export async function listeningPorts(ports = DEV_PORTS): Promise<number[]> {
  const up = await Promise.all(ports.map(async (p) => (await open(p, "127.0.0.1")) || (await open(p, "::1"))));
  return ports.filter((_, i) => up[i]);
}

if (import.meta.main) {
  let command = "";
  try { command = JSON.parse(await Bun.stdin.text()).tool_input?.command ?? ""; } catch { process.exit(0); }
  if (!rewritingGit(command)) process.exit(0);
  const reason = check(command, await listeningPorts());
  if (reason) { console.error(`Blocked by .claude/hooks/bash-guard.ts: ${reason}`); process.exit(2); }
  process.exit(0);
}
