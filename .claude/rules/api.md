---
paths:
  - "apps/api/**"
  - "docs/SCHEMA_GOVERNANCE.md"
---

# API and database (`apps/api`)

Loads when Claude reads or edits files under `apps/api`. The rules in `CLAUDE.md` sections 5 and 6 apply in full; this is the map and the stack notes for this part.

| Path | What it is | Who writes it | When to read it |
|---|---|---|---|
| `apps/api/src` | NestJS on Bun: `workers`, `compliance`, `sites`, `audit`, `common`, `db` (`schema.ts`, `client.ts` with the per-request row-level-security scope, `migrate.ts`, `seed.ts` with fictional data only) | Build steps | Any API step |
| `apps/api/src/auth` | Own identity service (DECISIONS A25; two-factor optional, A31): `crypto.ts` (HS256 tokens, refresh tokens, AES-GCM sealing, RFC 6238 TOTP), `passwords.ts` (Argon2id, policy), `auth.service.ts` (sign-in with reserve-then-verify lockout, refresh rotation and reuse detection, idle and absolute limits), `auth.guard.ts` (default deny, permissions, `RequestScopeInterceptor`), `permissions.ts` (catalogue; must match the migrations), `admin-users.ts`, `accounts.ts` (`auth:bootstrap-admin`, `db:seed-users`) | Build steps; security changes need the `independent-reviewer` agent | Any endpoint: declare `@Public`, `@SignedIn` or `@RequirePermission` |
| `apps/api/src/files/files.ts` | Scans (A27, TR-SEC-12): type from the file's bytes, 15 MB, virus scan (EICAR test signature in development, `pending` in production until X15), disk store in development and S3 in production, opened only when clean | Build steps; security changes need the `independent-reviewer` agent | Any upload or download |
| `apps/api/src/masters/masters.ts` | Document masters (PRD 4.19, A26-A30): the client register, organisation documents (company, sub-contractors, clients), scan upload and opening (audited; worker scans need `pii.view`), `/masters` and `/masters/{key}` | Build steps | Any masters, client or document step |
| `apps/api/src/sponsors/sponsors.ts` | Sponsors and outsourced workers (PRD 4.18, A21–A24): sponsor register, dated engagements, verified authorisations, supply agreements (four eyes), the `outsourcing.unauthorised` setting | Build steps | Any outsourcing or sponsor step |
| `apps/api/drizzle/NNNN_*.sql` | Numbered, forward-only migrations — write them with `/new-migration` | New file per change; never edited once locked | Any data step |
| `apps/api/drizzle/migrations.lock` | SHA-256 of every applied migration | `bun run gates --update-lock` only | Never by hand |
| `apps/api/test` | API tests on PostgreSQL 16 (`helpers.ts`, `preload.ts`, `global-setup.ts`) | Build steps | Any API step |

When an `apps/api` endpoint the web calls changes, change `apps/web/src/demo/server.ts` with it (`server.test.ts`).

## Stack notes (learned the hard way)

- **postgres.js queries are lazy.** In `bun:test`, never pass a query straight to `expect(...).rejects`. Wrap it: ``expect((async () => sql`...`)()).rejects``. Passed directly, the test hangs forever and Bun's timeout doesn't stop it.
- **`apps/api/tsconfig.json` stays self-contained** (no `extends`). Bun ignores `experimentalDecorators` in an extended tsconfig, and NestJS then fails at startup.
- **Local port:** the API defaults to 3000; on a PC where 3000 is taken, run `PORT=3100 bun run dev:api` and the web with `VITE_API_URL=http://localhost:3100`. The desktop CSP allows both.
