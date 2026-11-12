---
paths:
  - "apps/desktop/**"
---

# Desktop shell (`apps/desktop`)

Loads when Claude reads or edits the Tauri shell or the print spooler. Rule 12 applies above all: the shell holds no business rules; it only does what a browser can't (silent printing, the Windows credential store).

| Path | What it is | Who writes it | When to read it |
|---|---|---|---|
| `apps/desktop/src-tauri` | Tauri 2 shell: `src/lib.rs` (thin `#[tauri::command]`s, registered in `generate_handler!`), `capabilities/default.json`, `tauri.conf.json` (window, CSP, bundle) | Build steps; `/tauri-command` | Any desktop step |
| `apps/desktop/print-spooler` | Rust library for silent batch printing behind a `PrintBackend` trait, with a fake backend for tests (`src/tests.rs`) | Build steps, tests first | Printing work |

## Rules for this part

- **New or changed IPC command → `/tauri-command`.** Five places must agree: Rust command, `generate_handler!`, capability, `apps/web/src/lib/desktop.ts`, tests. Gate G10 checks the names.
- **The library never panics** (gate G9): no `unwrap()`, `expect()`, `panic!` outside tests; return `Result` so a batch report survives a bad document.
- **The webview is untrusted input.** Bound item counts, byte sizes and string lengths in every command before doing work.
- **Security surface edits ask first:** `capabilities/**` and `tauri.conf.json` (permissions `ask`). CSP origins are exact, never `*`; it allows the API on `localhost:3000` and `:3100` in development.
- **Checks:** `bun run --filter @mms/desktop lint:rust` (fmt + clippy `-D warnings`, both crates) and `test:rust`. The Stop hook runs them after Rust edits; CI runs them before building the installer.
- **Local Rust builds need the MSVC linker** (Visual Studio 2022 Build Tools, "Desktop development with C++"). Without it, clippy and tests are skipped locally with a notice and only CI runs them.
- **See the real window:** start `bun run --filter @mms/desktop dev` with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`, then use the **playwright-desktop** MCP. Printing to a physical printer is a human check.
- Current Tauri 2 APIs: **context7** (`/tauri-apps/tauri-docs`), not memory.
