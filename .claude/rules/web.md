---
paths:
  - "apps/web/**"
  - "packages/ui/**"
  - "wrangler.jsonc"
  - "wrangler.demo.jsonc"
  - "apps/cloudflare/**"
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
| `wrangler.demo.jsonc`, `apps/web/src/demo/server.ts` | Browser-only demo (DECISIONS A20): static `--mode demo` build whose API calls are answered in the browser by `server.ts` from `@mms/core` and fictional data; `bun run deploy:demo` deploys it alone (free plan), and the client demo serves the same build at `/demo/`. When an `apps/api` endpoint the web calls changes, change `server.ts` with it (`server.test.ts`) | Humans (config); build steps (`server.ts`) | Any change to an endpoint the web calls |
| `wrangler.jsonc`, `apps/cloudflare/src/{worker,config}.ts`, `.dev.vars.example`, root `package.json` `cloudflare.bindings` | Cloudflare client demo (DECISIONS A32), what the README's Deploy button builds: `bun run build` (web with `VITE_CLIENT_DEMO=true`, same-origin API, plus the demo at `dist/demo/`), then `bun run deploy`. The Worker validates the secrets (`config.ts`, tested with `bun test`), derives the auth keys and starts one Container from `apps/api/Dockerfile` with the entrypoint `bun src/deploy/client-demo.ts`. Fictional data only; production is AWS (A10). `wrangler dev` can't run containers on Windows | Humans (config); build steps | Deploying or changing the client demo |

## Stack notes

- **Web component tests use Vitest on purpose** (jsdom). Don't move them to `bun test` without proving they still work.
- **Pin exact versions** for anything tied to a downloaded binary (`@playwright/test`).
- After every screen or component, run `/imprint`; colours come from tokens (gate G8).
