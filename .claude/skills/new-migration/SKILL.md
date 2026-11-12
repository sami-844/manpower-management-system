---
name: new-migration
description: Write the next numbered database migration for the manpower system the one safe way — schema.ts first, drizzle-kit generates the file, every SCHEMA_GOVERNANCE convention checked, a test proves it, the lock is updated, and an independent review runs. Use when a step needs a table, column, constraint, trigger, policy or permission change.
disable-model-invocation: true
argument-hint: "<what changes, e.g. worker bank accounts table>"
---

A migration is the one change in this repository that cannot be taken back. Once it is in `migrations.lock` it is applied somewhere, and the only way forward is another migration. So this runs in a fixed order, and no step is skipped because the change "looks small".

**Input:** `$ARGUMENTS` — what the migration changes. If it is empty, ask.

## 0. Before writing anything

1. The step must have an approved `/architect` plan that names this change and its tables from `docs/spec/07-Backend-Schema.md`. If it doesn't, stop and run `/architect` first.
2. Read `docs/SCHEMA_GOVERNANCE.md` in full. It is short, and every line of it applies.
3. If the change depends on an UNANSWERED decision in `docs/DECISIONS.md`, stop: the step is blocked.
4. One concern per migration (governance rule 1). Two concerns → two migrations, in order.

## 1. Write the change

**Tables, columns, indexes, constraints** — change `apps/api/src/db/schema.ts`, then generate:
```
cd apps/api && bun run db:generate --name <snake_case_concern>
```
**Triggers, functions, policies, grants, permission rows, data backfills** (things drizzle doesn't model) — generate an empty, correctly numbered file and write the SQL by hand:
```
cd apps/api && bun run db:generate --custom --name <snake_case_concern>
```
Never create or rename the `.sql` file, `meta/_journal.json` or a snapshot by hand: drizzle-kit owns the numbering and the journal, and `migrate.ts` applies only what the journal lists.

Separate statements with `--> statement-breakpoint`. Start the file with a `--` comment naming the requirement (TR-ID, DECISIONS entry or Backend Schema section), as the existing migrations do.

## 2. Check it against the rulebook, line by line

For every new or changed table, confirm each of these, and say which ones apply:

| Check | Rule |
|---|---|
| `entity_id text NOT NULL`, part of every unique key | Conventions: Entity |
| `id uuid` (UUIDv7); human codes from a sequence, never `MAX()+1` | Keys; rule 10; G4 |
| `created_at`/`updated_at timestamptz`, `created_by`/`updated_by` | Audit columns |
| Money `NUMERIC(14,3)` named `_amount`; no float types | Money; rule 2; G2 |
| Calendar dates `DATE` (`_on`), moments `timestamptz` (`_at`) | Dates; G3 |
| Status as `text` + `CHECK` list | Status |
| No `DELETE` paths: `archived_at`, `archive_reason`, FKs `ON DELETE RESTRICT` | Deleting |
| Effective dating: `valid_from`/`valid_to` + exclusion constraint | Effective dating |
| Final records: `locked_at`/`locked_by` + trigger rejecting changes | Locking; rule 7 |
| RLS enabled + `entity_scope` policy **in this migration** | Security inside the database |
| ID/bank numbers encrypted per column, listed for the anonymiser | Personal data; rule 11 |
| No legal value as a literal — only `rule_versions` | Legal values; rule 3 |
| Compatible with the previous release (expand, migrate, contract) | Migrations rule 3 |
| New permissions also added to `apps/api/src/auth/permissions.ts` | must match the migrations |

A "no" on any line is fixed before going on, or recorded as a question in `docs/DECISIONS.md`.

## 3. Prove it

1. Write the failing test first (rule 1) in `apps/api/test/`: the constraint rejects bad rows, the trigger blocks the forbidden change, RLS returns zero rows across entities (TR-SEC-05). Remember postgres.js queries are lazy — wrap them before `.rejects` (`.claude/rules/api.md`).
2. Apply and run: `bun run db:migrate`, then `bun run --filter @mms/api test`.
3. Look at the result with the **postgres** MCP (read-only): the table, its policies, its triggers.

## 4. Lock it

```
bun run gates --update-lock
bun run gates
```
The lock line and the migration go in the **same commit**. Never edit `migrations.lock` by hand (the guard hook blocks it).

## 5. Independent review

Run the `independent-reviewer` agent on the diff. Migrations always count as high-stakes (CLAUDE.md section 7: senior reviewer). Report its findings by severity; fix criticals before committing.

## Report

End with: the file name, the concern, the governance checks that applied, the test that proves it (with its result), the gates result, and the reviewer's verdict. Anything not run is reported as "not run".
