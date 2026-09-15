# @clinic-os/web

React + Vite frontend. Arabic and right-to-left by default.

## Run it

```bash
cd apps/web
npm ci          # first time only
npm run dev
```

Opens <http://localhost:5173> automatically. The only page that exists today is the **component
gallery** at `/` — Phase 1, Checkpoint 4, first piece. There is no login page and no application
shell yet.

## Scripts

| | |
|---|---|
| `npm run dev` | Dev server with hot reload. The right tool while writing code |
| `npm run build` | Typecheck then production build into `dist/` |
| **`npm run preview:fresh`** | **Build, then serve what was just built, on 4173. The one command for reviewing a screen** |
| `npm run preview` | Alias of `preview:fresh` |
| `npm run review` | Alias of `preview:fresh` |
| `npm run typecheck` | `tsc --noEmit` |

**No script here serves a build it did not just make.** `npm run preview` used to be plain
`vite preview`, which serves whatever is already in `dist/` — and a `dist/` older than the source
does not look like a tooling failure, it looks like the work was never done. That cost three review
cycles, the last on 2026-09-02 when a full day of merged work was invisible behind a three-day-old
build. Each one produced confident and completely wrong review feedback.

`docs/SETUP.md` had said "use `npm run review`, not `npm run preview`" since the second occurrence.
The advice was right and it did not hold, because the command it warned against still worked. So the
aliases above are the fix: the stale path is gone rather than discouraged. To serve `dist/` untouched
on purpose, run `npx vite preview` — deliberately not a script, so habit cannot reach it.

Reviewing against the review database rather than the dev one also needs
`VITE_API_TARGET=http://localhost:3100`; see `docs/SETUP.md` §9.

## RTL

`dir="rtl"` and `lang="ar"` are set on `<html>` in `index.html`, before the first paint — not
applied by JavaScript after mount, and not a toggle.

All spacing and positioning uses **CSS logical properties** (`ps-`/`pe-`, `ms-`/`me-`,
`inset-inline-*`, `text-start`/`text-end`) rather than physical left/right, per `ARCHITECTURE.md`
§2: *"RTL via CSS logical properties, not a mirrored stylesheet."* One stylesheet serves both
directions.

Runs of digits — phone numbers, money, times — are wrapped in `.numeric`, which sets
`direction: ltr; unicode-bidi: isolate`. Without it a leading `+` on a phone number jumps to the
wrong end of the string when it sits inside Arabic text.

## Where things live

```
src/
├── design-system/   Button, fields, overlays, display primitives, Toast
├── features/        mirrors apps/api/src/modules/
│   └── gallery/
├── i18n/            ar.ts — Arabic strings and the appointment-status map
└── lib/
```
