---
paths:
  - "apps/web/**"
  - "packages/ui/**"
  - "wrangler.jsonc"
  - "docs/ui-registry.md"
---

# Web interface (`apps/web`, `packages/ui`)

Loads when Claude reads or edits the web app, the UI package or the demo config. The rules in `CLAUDE.md` sections 5 and 6 apply in full.

| Path | What it is | Who writes it | When to read it |
|---|---|---|---|
| `apps/web/src` | Shared React interface: `pages/`, `components/`, `lib/` (`api.ts`, `format.ts`, `desktop.ts`); `styles.css` is pre-shadcn until S2 | Build steps | Any UI step |
| `apps/web/src/lib/desktop.ts` | The typed bridge to the Tauri shell; every `invoke("…")` must name a registered desktop command (gate G10) | Build steps; `/tauri-command` | Any desktop feature |
| `apps/web/e2e` | Playwright journeys | Build steps | UI flows |
| `packages/ui` (from S2) | shadcn components and Design Brief tokens (`styles/tokens.css`) | S2 onwards | Any UI step |
| `wrangler.jsonc`, `apps/web/src/demo/server.ts` | Hosted client demo on Cloudflare Workers (DECISIONS A20): static `--mode demo` build whose API calls are answered in the browser by `server.ts` from `@mms/core` and fictional data. Demo hosting only; production is AWS (A10). When an `apps/api` endpoint the web calls changes, change `server.ts` with it (`server.test.ts`) | Humans (config); build steps (`server.ts`) | Deploying the demo; any change to an endpoint the web calls |

## Stack notes

- **Web component tests use Vitest on purpose** (jsdom). Don't move them to `bun test` without proving they still work.
- **Pin exact versions** for anything tied to a downloaded binary (`@playwright/test`).
- After every screen or component, run `/imprint`; colours come from tokens (gate G8).
