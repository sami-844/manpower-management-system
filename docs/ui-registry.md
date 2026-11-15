# UI registry

> How screens actually apply the design system, so the next screen matches. Written by `/imprint` after every screen; never edited by hand without updating the entry's date. The target system is `docs/spec/09-Design-Brief.md`. If an entry and the Design Brief disagree, the Design Brief wins and the entry is a defect to fix.

## Baseline (from the Design Brief — decided, not inferred)

| Property | Rule |
|---|---|
| Components | shadcn/ui copied into `packages/ui` (Radix primitives); Aceternity only from the approved list (D11 before first use) |
| Tokens | CSS variables in `packages/ui/styles/tokens.css`, mapped into Tailwind v4 with `@theme inline`, shadcn naming. No hex outside the token file |
| Radius | `--radius: 0.5rem` |
| Type | Inter, tabular figures for every number column; sizes 12/13/14/16/20/24/30; body 14 desktop, 16 mobile |
| Spacing | 4 px grid; table rows 36 px compact (desktop default) or 44 px comfortable (web default) |
| Primary | `--primary` deep blue, `oklch(0.45 0.12 250)` light / `oklch(0.70 0.12 250)` dark |
| Accent | `--accent` site amber, sparingly |
| Status | One `Badge` with a `status` variant: **ok** (`--success`, check), **due** (`--warning`, clock), **expired** (`--destructive`, alert), **blocked** (`--destructive` outline, ban), **incomplete** (`--muted-foreground`, dashed circle), **draft / locked / released** (neutral / primary / success; pencil / lock / send). Always icon + word; the word comes from the API |
| Money | Right-aligned, tabular figures, OMR with three decimals |
| Confirm | `AlertDialog`; the button names the action and the amount or count |
| Blocked action | Says why and links to the fix; never a grey button with no reason |
| Personal data | Passport, civil ID, bank numbers masked to the last 4; reveal needs `pii.view` and is audited |
| Direction | Logical properties only (`ms-`, `pe-`, `start-`); `rtl: true` in `components.json` |
| Motion | Only with meaning; off with `prefers-reduced-motion` and in desktop performance mode |
| Print | A4, solid, no motion: payslips, daily sheets, timesheet packs, ID cards, invoices, settlement statements |

## Components

Built 2026-11-09 for the Version 1 demo foundation (see DECISIONS A16–A18).

| Component | File | How it applies the brief |
|---|---|---|
| Tokens | `apps/web/src/styles.css` | Every brief value copied (light and dark), shadcn names, `@theme inline`; Inter variable; radius 0.5rem; reduced-motion and A4 print rules |
| App shell | `components/app-shell.tsx`, `app-sidebar.tsx`, `site-header.tsx`, `nav-user.tsx` | shadcn dashboard-01 block adapted: `Sidebar` (collapsible to icons) + `SidebarInset`, breadcrumb, Ctrl+K, notifications; sidebar groups filtered by role |
| Command palette (S-03) | `components/command-menu.tsx` | `Command` dialog: screens, live worker search, clients, sites, actions |
| Status badge | `components/status-badge.tsx` | One badge, tones ok / due / expired / blocked (outline) / incomplete (dashed) / draft / locked / released; always icon + word; keeps the `tag` class for the first-slice e2e |
| Data table | `components/data-table.tsx` | TanStack Table v9; sticky header, sort, paging, selection + bulk bar, skeleton rows, empty state, `/` filter, J/K/Enter |
| Money | `components/money.tsx` | `@mms/core` formatting (decimal.js), right-aligned, tabular, 3 decimals |
| Confirm | `components/confirm-dialog.tsx` | `AlertDialog`, button names the action and amount, optional type-to-confirm |
| Page header, KPI card | `components/page-header.tsx`, `kpi-card.tsx` | Title + actions top-right; "Sample data" badge for demo-layer screens (the same badge, labelled "Hosted demo", sits in the header of the Cloudflare build); number cards link to the names behind them |
| Aceternity | `components/aceternity/*` | Approved list only: background beams (S-01), multi-step loader (payroll calculate, WPS generate), number ticker (S-32, in-house on `motion`). Colours mapped to tokens; `MotionConfig reducedMotion="user"` app-wide. Timeline and Animated Tooltip were tried and removed: both hard-code palette colours and photo avatars, so worker history (S-06) and the site crew stack (S-13) use token-based equivalents |
| Scan actions | `components/scan-actions.tsx` (2026-11-10) | "Upload scan" (hidden file input, `.pdf,.jpg,.jpeg,.png,.heic`, 15 MB checked before sending, server message in a toast) and "View scan" (fetched with the bearer token as a Blob, opened from an object URL in a new tab; HEIC is downloaded because browsers can't show it). Used by S-45 and S-06 |

### Document masters (S-44, S-45) — 2026-11-10

| Screen | File | How it applies the brief |
|---|---|---|
| S-44 Document masters | `pages/masters/Masters.tsx` | `PageHeader`; one-line summary (tabular counts); one `section` per group (In House, Purchase, Sales) with a responsive card grid (1 column on a phone, 2 / 3 wider) of links, each with the master's number (mono), label and `StatusBadge` counts (expired, missing, due, valid, no expiry, not verified; zeros left out). Skeletons while loading |
| S-45 Master register | `pages/masters/MasterRegister.tsx` | `PageHeader` (label, "Master N" chip, Add client / Add sub-contractor top-right); state counts as pressable filter tiles (the S-09 Renewals pattern, `?state=` in the URL); `DataTable` with subject (worker link, code, engagement and sponsor), masked number, dates, days left in words, state `StatusBadge` (icon + word: Expired, Missing, Due, Valid, No expiry date), verified by whom, scan state; row actions Record/Renew (`Dialog`, native date inputs), Verify, Upload scan, View scan, each shown only when `useSession().allows(permission)`; empty states say who adds what |

### Cloudflare client demo notices (A32) — 2026-11-15

| Where | File | How it applies the brief |
|---|---|---|
| S-01 Sign in | `pages/shell/SignIn.tsx`, `lib/deployment.ts` | On a `VITE_CLIENT_DEMO=true` build, a neutral `Alert` above the fields: "Client demo: every person and figure here is fictional. Don't enter real personal data." A `NOT_CONFIGURED` or `API_NOT_STARTED` answer from the Worker is shown in its own words (the deployer needs the secret's name), on sign-in and when the session is restored |
| Header | `components/site-header.tsx` | The same `SampleDataBadge` as the browser-only demo, labelled "Client demo", tooltip with the notice; hidden below `md` like that badge, so on a phone only the sign-in screen carries the notice |

### My account (S-46) — 2026-11-11

| Screen | File | How it applies the brief |
|---|---|---|
| S-46 My account | `pages/settings/Account.tsx`, shared pieces in `components/auth-parts.tsx` (code box, QR code, error alert and messages, also used by S-01) | `PageHeader`; two cards in one `max-w-2xl` column (works at phone width): Account (name, username in mono, role) and Two-factor sign-in with a `StatusBadge` (On: `ok`, Off: `incomplete`; icon and word, never colour alone). Turning on fetches the set-up code once, on the click, then shows the set-up pattern inline (QR always dark on light, grouped key, numbered steps: scan, code, password); turning off asks for the password and a code, with the destructive button. Field-level errors (`aria-invalid`, `aria-describedby`); a wrong entry clears that field and puts the cursor back in it; finishing or Cancel returns focus to the card's button. Reached from the sidebar (Settings section, every role) and the user menu. The hosted demo shows an explanation instead |

Permissions in the UI: `useSession().allows("…")` reads `/api/auth/me` permissions in live builds and `DEMO_ROLE_PERMISSIONS` (`lib/roles.ts`) in the hosted demo. An action the account can't perform is not shown.

**Deviation to confirm:** shadcn uses `--accent` for every hover/selected surface. Putting the brief's site amber there would turn every menu hover amber, against "one accent colour, sparingly". The amber lives in `--highlight` (same values as the brief's `--accent`), and `--accent` is a quiet blue-grey. Change the brief or this file, whichever the reviewer prefers.

## First audit — 2026-11-09 (`/imprint audit` on the first slice, `apps/web/src`)

The slice predates the Design Brief and uses its own CSS (`apps/web/src/styles.css`, 548 lines). Findings, for the S2 migration:

| Property | Found | Baseline |
|---|---|---|
| Radius | `--radius: 4px`; `50%` for the tag hole | `0.5rem` |
| Font | Atkinson Hyperlegible Next | Inter (tabular figures already used, line 44) |
| Tokens | Own names (`--paper`, `--ink`, `--action`, `--tag-*`) | shadcn names |
| Hard-coded colours outside the token block | 6: `styles.css` lines 131, 182, 208, 273, 315, 374 | none |
| Spacing | Ad hoc rem values (0.35, 0.45, 0.6, 0.85, 1.1 …) | 4 px grid |
| Physical left/right properties | 10 | 0 (logical properties) |
| Print styles | none | payslip and sheet print styles from S9 |
| Status | `Tag` with tones green / yellow / red / none, a word and a hole marker (`components/Tag.tsx`) | `Badge` status variants with icon + word |

**Colour-only signals: 0.** Every `Tag` carries a word ("Expired", "Renewal due", "Cannot be deployed"). One mismatch to fix: "Cannot be deployed" uses the red tone; the baseline gives *blocked* its own outline style and ban icon, distinct from *expired*.

**Screens to fix in S2** (confirmed against the Design Brief, which is authoritative):

- `apps/web/src/styles.css` — custom layout, tokens and 6 hard-coded colours → shadcn `Sidebar`/`SidebarInset`, Tailwind utilities, Design Brief tokens
- `apps/web/src/components/Tag.tsx` — tones → `Badge` status variants (ok, due, expired, blocked, incomplete) with icons
- `apps/web/src/pages/Workers.tsx`, `Renewals.tsx`, `Today.tsx` — hand-made tables → `Table` + TanStack Table
- `apps/web/src/pages/WorkerFile.tsx` — page → `Sheet` from the list with `Tabs`, full page on deep link; eligibility result as *ok* / *blocked* badge
- All screens — 10 physical left/right properties → logical properties
