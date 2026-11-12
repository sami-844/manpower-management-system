---
name: tr-test
description: Turn one TR-ID requirement of the manpower system into a failing test before any implementation (CLAUDE.md rule 1). Finds the requirement and its stated verification in docs/spec/05-TRD.md, picks the right package and test style, writes the test, and proves it fails for the right reason. Use when a plan names TR-IDs and building starts, or when asked to write tests for a requirement.
argument-hint: "<TR-ID, e.g. TR-SEC-07>"
---

Rule 1 says a requirement becomes a failing test before it becomes code. This skill does that for one TR-ID, and stops there: it writes no implementation.

**Input:** `$ARGUMENTS` — one TR-ID (`TR-XXX-NN`). Several → run once per ID.

## 1. Read the requirement, not a memory of it

Use the `spec-scout` agent (or `grep -n "| $ARGUMENTS |" docs/spec/05-TRD.md`) to get:
- the requirement text, its priority (MUST/SHOULD), and the **verification column** — that column says what kind of test proves it;
- the screens (`06-App-Flow.md`), tables (`07-Backend-Schema.md`) and DECISIONS entries it touches.

If the ID is withdrawn, Version 2 or Phase 12, stop and say so (rule 12). If it depends on an UNANSWERED decision, stop: the step is blocked.

## 2. Choose where the test lives

| The requirement is about… | Package | Runner and style |
|---|---|---|
| A pure rule: eligibility, money, dates, renewals, pay, billing maths | `packages/core/src/<engine>.test.ts` | Vitest. Add a **fast-check** property when the rule holds for all inputs (sums, rounding to the baisa, date ranges). Money is `decimal.js`, never `number` (rule 2). |
| An endpoint, permission, four-eyes, audit, RLS, trigger | `apps/api/test/<module>.test.ts` | `bun test` on PostgreSQL 16 with `test/helpers.ts`. Wrap postgres.js queries before `.rejects`. |
| A screen's behaviour | `apps/web/src/**/<name>.test.tsx` | Vitest + Testing Library (jsdom). |
| A whole journey | `apps/web/e2e/` | Playwright. |
| Silent printing | `apps/desktop/print-spooler/src/tests.rs` | `cargo test` with the fake backend. |

Reuse the existing helpers and fixtures in that package; read one neighbouring test first and match it.

## 3. Write the test

- Name it with the ID so reviews can trace it: `describe("<what> (TR-XXX-NN)", …)`.
- One `it` per sentence of the requirement that can fail on its own. A MUST with three clauses gets three assertions, not one.
- Test the behaviour the requirement states, through the public interface (engine function, HTTP endpoint, rendered screen) — not internals.
- Fictional data only, from the seed generator or obviously fake values (rule 11). Golden cases are added with `"expected": null` and flagged for sign-off (rule 4).
- No legal value as a literal in the test either; read it from the rule version the code will use (rule 3).

## 4. Prove it fails for the right reason

Run only the new test (`bun test <file>`, `bunx vitest run <file>`, `cargo test --manifest-path … <name>`). It must fail **because the behaviour is missing** — a missing function, a 404, a wrong value — not because of a typo, an import error or a broken fixture. Fix the test until the failure message describes the requirement.

## Report

The TR-ID, the file and test names, which clause each test covers, and the failure output (trimmed). Then stop; implementation is the next step of the plan.
