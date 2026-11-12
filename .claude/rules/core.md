---
paths:
  - "packages/core/**"
---

# Domain engines (`packages/core`)

Loads when Claude reads or edits the engines. Rules 2, 3, 4 and 5 in `CLAUDE.md` live here.

| Path | What it is | Who writes it | When to read it |
|---|---|---|---|
| `packages/core/src` | Pure domain engines with no I/O: `compliance.ts` (`checkEligibility`), `renewals.ts`, `money.ts` (decimal.js, OMR), `dates.ts`, `summary.ts`, `masters.ts` (the eighteen document masters, PRD 4.19); tests beside each | Build steps, tests first | Before writing any rule: it may already exist |
| `packages/core/stryker.config.json` | Mutation testing; CI breaks under 80 %. The JSON report lands in `packages/core/reports/mutation/mutation.json` | Humans | When the score drops: use the `mutant-hunter` agent |

## Stack notes

- **Mutation testing and these unit tests use Vitest on purpose** (Stryker's runner). Don't move them to `bun test` without proving both still work.
- No I/O, no clock, no network here (TR-PLT-03): pass dates and rule versions in.
- Use fast-check for rules that hold for all inputs (sums, rounding to the baisa, date ranges).
