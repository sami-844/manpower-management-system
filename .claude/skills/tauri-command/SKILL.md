---
name: tauri-command
description: Add or change a desktop IPC command in the manpower system's Tauri shell end to end — Rust command, registration, capability, typed web bridge with a browser fallback, and tests — without putting business rules in the shell. Use when the desktop app needs something a browser can't do (printing, OS credential store, files).
disable-model-invocation: true
argument-hint: "<what the command does, e.g. read the default printer's paper size>"
---

A desktop command is a door from the web page into the PC. It has five places that must agree, and a mismatch only shows up at runtime on an office PC. So it is built in this order.

**Input:** `$ARGUMENTS` — what the command does. If empty, ask.

## 0. Does it belong in the shell at all?

Rule 12: shells hold no business rules. A command may only do what a browser can't — talk to printers, the Windows credential store (TR-SEC-03), local files the user picked. Anything that decides *who, what, how much or whether* belongs in `packages/core` or the API. If the request mixes both, split it and say so.

Check the current Tauri 2 API with **context7** (`/tauri-apps/tauri-docs`) before writing; do not trust memory.

## 1. Rust, tested where it can be

- OS-independent logic goes in a library crate (like `apps/desktop/print-spooler`) behind a trait, with a fake for tests — see `print-spooler/src/batch.rs` and `tests.rs`. Write the failing test first (rule 1).
- The `#[tauri::command]` in `apps/desktop/src-tauri/src/lib.rs` stays thin: decode input, call the library, map errors to a `String` the user can read.
- Never `unwrap()`/`expect()`/`panic!` in library code; return `Result` (gate G9).
- **Bound every input from the web page**: count of items, byte sizes, string lengths. The webview is untrusted input like any HTTP client.
- Blocking or long work goes in `tauri::async_runtime::spawn_blocking`; progress goes out as an event; cancellation through shared state (see `run_batch`).

## 2. Register and permit

1. Add it to `tauri::generate_handler![…]` (gate G10 fails otherwise).
2. Check `apps/desktop/src-tauri/capabilities/default.json` still describes what the window may do, and update its `description`. Editing capabilities or `tauri.conf.json` asks for approval: say why the change is needed. Once there is more than one window, switch to `tauri_build::AppManifest::commands(&[…])` in `build.rs` and grant per-window `allow-<command>` permissions.
3. If the command needs a new network origin, the CSP in `tauri.conf.json` must allow it — the narrowest origin, never `*`.

## 3. The web bridge

In `apps/web/src/lib/desktop.ts`:
- a typed wrapper `invoke<Result>("command_name", { … })` whose argument and result types mirror the Rust `serde` structs (snake_case fields stay snake_case);
- the feature is hidden, not broken, on the plain website: callers check `isDesktop()` first;
- a component or unit test for the screen that uses it, with the bridge mocked.

## 4. Verify

```
bun run gates                                   # G9, G10
bun run --filter @mms/desktop lint:rust         # fmt + clippy -D warnings, both crates
bun run --filter @mms/desktop test:rust         # library tests
bun run --filter @mms/web typecheck
```
Then run the real shell (`bun run --filter @mms/desktop dev` with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`) and exercise the command through the **playwright-desktop** MCP. Printing to a real printer is a human check; say so instead of claiming it.

## 5. Review

Run the `independent-reviewer` agent: a new IPC command, capability or CSP change is a security change.

## Report

The command name and signature, where each of the five places changed, input bounds chosen, tests and their results, and anything left for a human to check on a real PC.
