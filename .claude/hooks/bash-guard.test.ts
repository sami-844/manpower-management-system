import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { check, listeningPorts, rewritingGit } from "./bash-guard";

describe("bash-guard: which git commands rewrite files", () => {
  test.each([
    ["git checkout main", "checkout"],
    ["git switch feat/x", "switch"],
    ["git -C apps/web checkout -- src/main.tsx", "checkout"],
    ["git stash", "stash"],
    ["git restore src/a.ts", "restore"],
    ["git pull --rebase", "pull"],
    ["git rebase main", "rebase"],
    ["git merge feat/x", "merge"],
    ["git reset --hard HEAD~1", "reset"],
    ["git status && git checkout main", "checkout"],
    ["git checkout -b feat/x main", "checkout"], // a start point other than HEAD rewrites files
  ])("%s → %s", (cmd, sub) => expect(rewritingGit(cmd)).toBe(sub));

  test.each([
    "git status",
    "git diff HEAD",
    "git log --oneline -5",
    "git switch -c chore/agent-automation",
    "git checkout -b feat/x",
    "git branch -f main abc123",
    "git reset HEAD src/a.ts",
    "git commit -m 'merge notes'",
  ])("%s → allowed", (cmd) => expect(rewritingGit(cmd)).toBeNull());
});

describe("bash-guard: blocks only while dev servers listen", () => {
  test("blocks with the ports named", () => {
    const reason = check("git checkout main", [5173]);
    expect(reason).toContain(":5173");
    expect(reason).toContain("git branch -f");
  });
  test("allows when nothing listens", () => expect(check("git checkout main", [])).toBeNull());
  test("allows harmless git even while servers run", () => expect(check("git status", [5173, 3100])).toBeNull());
});

describe("bash-guard: port probe", () => {
  test("finds a listening port and ignores a closed one", async () => {
    const server = createServer().listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await listeningPorts([port, 1])).toEqual([port]);
    } finally {
      server.close();
    }
  });
});
