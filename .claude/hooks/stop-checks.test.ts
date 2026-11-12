import { describe, expect, test } from "bun:test";
import { checksFor, graphUpdateOwed, mirrorOwed } from "./stop-checks";

describe("stop-checks: knowledge graph refresh", () => {
  test("code edits refresh an existing graph", () => {
    for (const p of ["apps/api/src/main.ts", "apps/web/src/App.tsx", "apps/desktop/src-tauri/src/lib.rs", "apps/api/drizzle/0013_x.sql"])
      expect(graphUpdateOwed([p], true)).toBe(true);
  });
  test("no graph yet → nothing to refresh", () => expect(graphUpdateOwed(["apps/api/src/main.ts"], false)).toBe(false));
  test("docs, hooks and upstream copies don't trigger it", () =>
    expect(graphUpdateOwed(["docs/PROGRESS.md", ".claude/hooks/guard.ts", "third_party/x/y.ts"], true)).toBe(false));
});

const names = (paths: string[]) => checksFor(paths).map((c) => c.name);

describe("stop-checks: only the checks the edits owe", () => {
  test("nothing edited → nothing run", () => expect(names([])).toEqual([]));
  test("docs only → nothing run", () => expect(names(["docs/PROGRESS.md", "CLAUDE.md"])).toEqual([]));

  test("api TypeScript → api typecheck only", () => expect(names(["apps/api/src/main.ts"])).toEqual(["typecheck @mms/api"]));
  test("core is imported by api and web, so all three are checked", () =>
    expect(names(["packages/core/src/money.ts"])).toEqual(["typecheck @mms/core", "typecheck @mms/api", "typecheck @mms/web"]));
  test("web .tsx counts; web .css does not", () => {
    expect(names(["apps/web/src/pages/Today.tsx"])).toEqual(["typecheck @mms/web"]);
    expect(names(["apps/web/src/styles.css"])).toEqual([]);
  });

  test("hook or script edits → tooling typecheck and tests", () => {
    expect(names([".claude/hooks/guard.ts"])).toEqual(["typecheck tooling", "tooling tests"]);
    expect(names(["scripts/agent-doctor.ts"])).toEqual(["typecheck tooling", "tooling tests"]);
  });

  test("spooler Rust → fmt, clippy and tests for the spooler, then the shell that depends on it", () =>
    expect(names(["apps/desktop/print-spooler/src/batch.rs"])).toEqual([
      "rustfmt print-spooler", "clippy print-spooler", "cargo test print-spooler", "rustfmt src-tauri", "clippy src-tauri",
    ]));
  test("shell Rust, config or capabilities → shell checks only", () => {
    for (const p of ["apps/desktop/src-tauri/src/lib.rs", "apps/desktop/src-tauri/tauri.conf.json", "apps/desktop/src-tauri/capabilities/default.json"])
      expect(names([p])).toEqual(["rustfmt src-tauri", "clippy src-tauri"]);
  });
  test("clippy denies warnings", () => {
    const clippy = checksFor(["apps/desktop/src-tauri/src/lib.rs"]).find((c) => c.name === "clippy src-tauri")!;
    expect(clippy.cmd.slice(-3)).toEqual(["--", "-D", "warnings"]);
  });
});

test("settings and MCP edits owe a parent-folder mirror refresh; others do not", () => {
  expect(mirrorOwed([".claude/settings.json"])).toBe(true);
  expect(mirrorOwed([".mcp.json"])).toBe(true);
  expect(mirrorOwed(["apps/api/src/main.ts", ".claude/hooks/guard.ts"])).toBe(false);
});
