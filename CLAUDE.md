# CLAUDE.md

Read this before doing anything. Read `docs/ARCHITECTURE.md` before writing code in a new module.

## What this is

A multi-tenant SaaS for small outpatient clinics in Egypt. Replaces paper appointment books, WhatsApp threads, paper patient files, and Excel accounting with one system. Patients do not install anything.

Built by a solo non-developer founder with ~10–15 hours a week, working with Claude Code. **The scarce resource is the founder's review time, not code generation.** Optimise for code that is obviously correct on first read.

## Locked decisions — do not revisit without asking

| | |
|---|---|
| Backend | NestJS + TypeScript strict |
| DB | PostgreSQL 16 + Prisma |
| Frontend | React + TypeScript + Vite, Tailwind |
| Jobs | BullMQ + Redis |
| Realtime | Polling (15s). **Not** SSE or WebSocket in V1 |
| Auth | Custom JWT + rotating refresh, `memberships` table |
| Language | Arabic default, RTL first. English secondary |

## Rules that are never broken

**Tenant isolation.** Every tenant-scoped query goes through the Prisma tenant extension. `tenantId` comes from the validated JWT only — never from a request body, query string, or header. A cross-tenant request returns **404, not 403** (403 confirms the record exists).

**Money is integer minor units.** Never a float. Never a column named or formatted as EGP — currency lives in `tenants.currency`.

**No timezone literals.** `Africa/Cairo` appears in seed data only. The slot engine takes timezone as a parameter.

**Phone numbers are E.164** via `libphonenumber-js`, parsed with the tenant's country as hint. Never assume +20.

**Clinical content is doctor-only.** Visit metadata (date, doctor, service, follow-up date) and payments are visible to reception and admin. Diagnosis, plan, notes, examination, and prescription items are not. **Enforced by separate endpoints and separate DTOs — never by filtering fields out of one response.**

**Medical and financial records are never hard-deleted.** Archive, or write a revision/adjustment row.

**No secrets in code or Git.** Environment variables only. `.env.example` stays current.

**The slot engine is pure.** `modules/appointments/domain/` has zero I/O. If you need a database call there, the design is wrong.

**The application connects via `APP_DATABASE_URL` (`clinic_os_app`), never `DATABASE_URL`.** `DATABASE_URL` is the migration superuser and bypasses RLS. Application code reading `DATABASE_URL` is a security bug.

**Anything whose output is called reproducible takes its reference point as an explicit parameter, and never reads the clock.** A fixed PRNG seed sitting next to a `new Date()` looks deterministic and is not — which is worse than no guarantee at all, because nobody rechecks a guarantee they believe they already have. The seed carried exactly that combination from the day it was written: `docs/PHASE-1.md` called it deterministic while it quietly produced different data every day, and the visit count in that document was wrong for months with nobody able to explain why. Pass the instant in (`SEED_REFERENCE_DATE`, `apps/api/prisma/seed/blueprint.ts`), and let a test fail if the clock is read again.

**A unit spec that needs a database URL has an import-graph bug, not a missing environment variable.** Fix the import; never add the variable. `src/prisma/client.ts` reads `APP_DATABASE_URL` at module scope, so one `import` reaching anything under `src/prisma/` gives a unit spec a hidden dependency on a running environment — green locally, where `dotenv` loads `apps/api/.env`, and unable to even load on CI, which has none. The fix is to split the pure code out, as `prisma/seed/generate.ts` was split from `seed-clinical.ts`. Run `npm run test:no-dotenv` and `npm run test:integration:no-dotenv` before pushing anything that touches imports or environment handling: four separate CI failures in this project have had this one root cause — a local environment richer than CI.

## Conventions

- Modules mirror between `apps/api/src/modules/` and `apps/web/src/features/`
- No file over ~300 lines. Split it.
- DTOs validate at the boundary: `whitelist: true, forbidNonWhitelisted: true`
- Never expose a Prisma model directly from a controller
- Commits: `feat(appointments): add slot generation`. Small and logical. Never one giant commit.
- Branches: `main` ← `develop` ← `feature/*`

**The admin app is generic, and the OWNER is never assumed to practise.** Setup is normally done by
the vendor's onboarding or sales team on the clinic's behalf, not by a doctor-proprietor sitting at
the screen. Copy, defaults and navigation must not assume otherwise: no "your clinic" written as
though the reader owns it and treats patients, no default that only makes sense for a
single-doctor practice, and no screen that a person configuring a clinic they do not work in cannot
finish.

Ruled 2026-09-09. The seed had manufactured the opposite: a second RECEPTIONIST membership for the
owner of عيادة النيل, so that a working owner could switch into the desk. That was a real escape
hatch for a real shape of clinic, and it was also the product quietly deciding that the owner is a
practitioner. **One person now holds one role per clinic**, and the clinic switcher lists clinics
rather than memberships. The schema is unchanged — `memberships` still permits several per person
per clinic, because a doctor working in two clinics is the case that constraint was lifted for.

**Never edit a file containing Arabic text with `sed`, `perl -i`, or any shell substitution — use the
editor.** Ruled 2026-09-07, after a `sed` rewriting `fireEvent` calls in a spec whose matchers held
Arabic produced `فireEvent`, three times, silently. This codebase is Arabic-first: a one-liner is
written against how a bidirectional line *looks*, which is not how its bytes are ordered.

**Comments: at most two lines per file, saying what and why.** No rejected alternatives in source —
those go in `docs/`, three lines max per decision. Guards, and the recorded contrast from breaking
one, are exempt and unchanged.

Ruled 2026-09-07, correcting a habit rather than filling a gap: docblocks of twenty to forty lines
rehearsing a decision's history had left several files with more prose than code. A long comment
does not make a diff easier to review, it makes it longer — and the scarce resource here is review
time. Reasoning worth keeping is more useful in `docs/`, where someone not already reading that file
can find it, and where it need not be re-read every time the code beneath it changes.

## Start of every session

**Run `gh pr list` and `git branch -r` before doing anything else.** Not as a formality — as the
first two commands of the session, before reading the phase document.

This exists because it already failed. On 27 and 28 August 2026 two sessions built the same
doctors/services/schedules backend independently, with different module layouts, both green, both
opened as pull requests. Neither knew the other's branch existed, and the second one only found
out at merge time — by which point the first had also claimed a `prisma/sql/` number that the
second had taken, so the two could not both land.

Nothing about that was a mistake in either session's work. It is a property of a project where
context does not survive between sessions and branches do: **a session that does not look cannot
know.** The founder's own words on it — "that's a process gap, not a mistake — and it will happen
again."

What to look for in the output: an open PR touching the area about to be worked on, a remote
branch whose name overlaps the current task, and a migration or `prisma/sql/` number already
claimed on an unmerged branch. Any of those is a question for the founder before writing code, not
something to resolve by picking one silently.

**Session status comes from `gh pr list` and `git log`. From nothing else.** Not from a phase
document's status section, **not from the founder's recollection, including his own account of
where the last session stopped**, and **not from a handoff summary — including one this session
wrote itself an hour earlier.** All three are claims to check, never a brief to act on.

The third was added on 2026-09-02, in the founder's words: *"a handoff summary is a snapshot and
goes stale the moment anything merges. Same rule as phase-document status sections."* A summary is
worse than a status section in one respect — it is written by whoever is about to be believed, so
it carries the authority of having just been derived, and nothing re-derives it after the next
merge.

**A branch name is a claim too, and it is the one nobody checks.** The same morning, the founder
twice stated that the patient detail screen existed and only insurance was missing from it. The
belief was traceable: PR #32 merged a branch called `feature/patient-detail-and-insurance`. Its
actual diff was an orphan SQL file, appointment transition guards, status colours and the
*appointment* detail panel — no patient detail screen and no insurance code at all. `git log --all
-- apps/web/src/features/patients` returns nothing on any branch that has ever existed.

He had also read the i18n strings and found `patients`, `visits`, `payments` and no `insurance`,
and concluded a screen existed with a gap in it. The data was real and read correctly; the
conclusion was wrong. Those are `shell.nav.*` sidebar labels whose nav items have no `path` and
render **"coming soon"**, plus `detail.*` strings belonging to the appointment panel. The router
in `AppShell.tsx` has exactly three branches: `/day`, `/queue`, `/schedules`.

So the check is never "does the name, the summary or the string table say it exists" but **"does
the artefact exist"** — the file, the route, the endpoint, the row. `git log --all -- <path>` costs
one second and answers it for every branch at once. Say the finding plainly when it comes back
empty: the thing is not there.

The first half of that rule was already learned: `PHASE-3.md` §10 sent a session to open an
already-merged pull request and rebuild two finished checkpoints, and the section is now deleted
rather than corrected. The second half was learned on 1 September 2026, and it is the founder's own
ruling on himself.

That morning he opened a session with an ordered summary of where work stopped and a pointer to
`SCHEMA-DECISIONS.md` D22 for an approved patient-transfer design. Checked against the repository:
D22 is *"`tenants` is scoped by neither layer"*, the decisions document ends at D23, and the word
"transfer" appeared nowhere in the project except `BANK_TRANSFER` and a PDPL note. Of the three
items he listed as queued, the first was half-merged with its actual root cause sitting uncommitted,
the second was uncommitted work in a dirty tree he believed he had just pulled, and the third had no
written existence at all — no document, no code, no commit, no branch.

None of that was carelessness. He works ten to fifteen hours a week across sessions that share no
context, so his recollection drifts for exactly the same structural reason a dated status section
does — and it carries more authority, which makes it more dangerous, not less. **His words: "you're
right, and it's the second time."**

So: verify, then report precisely what the repository does and does not contain, quoting what a
cited reference actually says. Say it plainly — a soft "I couldn't quite find it" invites the reply
"look harder", when the finding is that the thing is not there. A dirty working tree when he says he
has just pulled is itself a signal that his model and the machine have diverged.

This never means refusing his scope decisions. Whether a requirement belongs in a phase is his call
and he can add one at any time; what cannot be taken on trust is a claim that some artefact already
exists. Scope is a decision. Status is a fact, and facts get checked.

---

## Browser testing

**Never drive a browser against the founder's dev database.** Stand up a throwaway, seed it, point
the API at that, and drive the browser against it — the same discipline every migration in Phase 2
used, applied to the one place it was not.

**A browser session against a live database is a WRITE session, not a read.** Coordinate-based
clicking cannot be assumed to be safe: a click lands where the pixels are, not where the intent
was, and "take a screenshot to check the layout" ends with rows in the database. On 29 August 2026
a verification session added a sixth `schedule_template` to a seeded doctor and two reasonless
`BLOCKED` exceptions, and the founder then spent a review cycle testing against data that had been
corrupted underneath him — which made a real bug look like several.

Both rules exist because the pattern was already established and simply not carried across. Assume
any click may write, and put a disposable database behind it before the first one.

**Verification never writes to the review database. Destructive-shaped checks run against
`clinic_os_test`.** Reading `clinic_os_review` is fine and often necessary — listing rows, decoding a
stored key, hashing a served image. Anything that writes, or might write, goes to the test database
the integration suite already owns and recreates.

Ruled 2026-09-13, generalising the browser rules above, because a session broke them twice in one
morning through paths that were not a browser. A probe proving a trigger ran a direct `UPDATE` that
demoted an admin — permitted, correctly, because another administrator remained — and left the review
data changed. A `PATCH` sent to check that editing an owner's name no longer demoted him worked, and
wrote a mangled name into his row. Both were repaired; both were noticed only by re-reading
afterwards.

The review database is a deliverable, not a scratch space: the founder reviews with his own eyes, so
whatever is in it is part of what he is reviewing, and data changed underneath him produces confident
wrong feedback exactly the way a stale build does.

**Arabic never travels through a shell payload.** The rule above about `sed` and `perl` was written
too narrowly: the same morning, `curl -d '{"fullName":"أحمد عبد الرحمن الشناوي"}'` mangled every
Arabic character to `?`, and the API stored `"???? ??? ?????? ???????"` as the owner's name. No file
was edited and no `sed` was involved. Either write the text with the editor, or hold it as a literal
in a file the editor wrote and run that file — never interpolate it into a command.

---

## Workflow

One phase at a time. The current phase is defined in `docs/PHASE-N.md` with a Definition of Done checklist. **Do not start work outside the current phase**, even if it seems small and related.

Within a phase, work in this order and stop at each checkpoint for review:

1. Schema + migration → **checkpoint**
2. Backend services + tests → run tests → **checkpoint**
3. API endpoints + tests → **checkpoint**
4. Frontend → **checkpoint** (this is where the founder's visual review happens)

Backend correctness is proven by tests, not by the founder's eyes. Frontend correctness requires his eyes. So finish and verify backend fully before touching UI — it concentrates his limited hours where they are actually needed.

**Changes reach `develop` through a pull request whose CI has already passed — never a local merge.** Work on a `feature/*` or `fix/*` branch, push it, let CI run on the branch, then open the PR. The point is the order: the check has to be able to say no while saying no is still cheap. CI used to trigger only on pushes to `develop`, which meant its first word on any change arrived after `develop` was already carrying it — a report, not a gate. `.github/workflows/ci.yml` now runs on `feature/**` and `fix/**` too, and can be started by hand with `workflow_dispatch`.

**Nothing is pushed without `npm run verify` at the repository root.** It runs, in order: the API
typecheck, the API unit suite, the API integration suite, **both suites again without `dotenv`**, the
web typecheck and the web suite. One command, and it is the whole gate — not a selection of it.

The `no-dotenv` pair is the reason this exists rather than being a habit. `apps/api/.env` makes the
local environment richer than CI's, and **five separate CI failures in this project have had that one
root cause** — the fifth on 2026-09-14, when a spec that boots the real `AppModule` passed locally
and failed on CI because `ATTACHMENTS_STORAGE_ROOT` is set here and not there. The rule already said
to run those two commands "before pushing anything that touches imports or environment handling",
which requires knowing in advance that a change touches them. It did not; the author did not think it
did; that judgement is the part that keeps failing. So the condition is removed: run it every time.

**A pre-push hook refuses text that looks mangled by a shell.** `.githooks/pre-push`, installed with
`npm run hooks:install`, greps the pushed diff for **U+FFFD** and for **runs of question marks inside
a quoted string** — the residue of `curl -d` with an Arabic payload, which on 2026-09-13 stored a
clinic owner's name as a row of question marks.

What it cannot see is the other half of that story: `فireEvent`, one ASCII letter replaced by one
Arabic letter, leaves behind neither of the two things it looks for. **The hook narrows the blast
radius of breaking the editor rule; it does not make the rule optional.** Its false positives — any legitimate `???` inside
a string — are listed in `check-encoding.spec.ts`, and the escape is `--no-verify` with the reason
stated in the commit.

**Merging a pull request is the founder's action, and is never inferred from intent.** Open it, say
it is ready, and stop. `gh pr merge` is not a step in any workflow here — not when CI is green, not
when the branch is trivial, not when the next piece of work depends on it, and not when a message
looks like it must have meant that.

Added 2026-09-06, after exactly that inference. The founder wrote *"Merge #59"* when #59 had already
been merged an hour earlier and #60 was the only pull request open; #60 was merged on the reasoning
that it was plainly what he meant. It probably was. That is not the point: **the reasoning that gets
one merge right is the same reasoning that gets the next one wrong**, and the cost is asymmetric —
an unmerged branch waits, a wrongly merged one is on `develop`.

His ruling: *"merging a PR is the founder's action only, never inferred from intent."*

**Standing exception, granted 2026-09-07 — the Phase 4 plan only.** A pull request that is one of
the numbered PRs in `docs/PHASE-4-PLAN.md` may be merged without asking, when **both** hold: CI is
green, and every guard it adds has been proven by breaking what it guards and watching the failure.
**PRs 8 and 9 are excluded** — they carry screens, and a screen waits for the founder's eyes. PR 7 was
excluded and has merged. **7a, 7b and 7c are covered**, by the founder's ruling of 2026-09-07: they
carry screens too, and he reviews them on `develop` with `npm run preview` and files fixes as
follow-ups rather than gating the merge. Report each merge after the fact.

This narrows nothing about the rule above, which still governs everything else. The authorization is
specific to a numbered, already-agreed list; a pull request that is not on that list is not covered
by it, and neither is one whose guards were only observed passing.

**In a stacked chain, never delete a branch until the whole stack has landed on `develop`.** Deleting a base branch does not retarget its child to `develop` — GitHub **closes** the child instead, and its own base then points at a branch that no longer exists. That happened on 2026-09-06: `--delete-branch` on #61 closed #62 and left it `CONFLICTING/DIRTY`. Nothing was lost, because the head branches survived, but recovering it took a replacement pull request. Merge the whole stack first, delete the branches afterwards.

So when an instruction names a pull request that is already merged, or names one number and means
another, report the discrepancy and wait. "You asked me to merge #59; #59 merged at 07:46 and #60 is
the only one open — do you want #60 merged?" costs one exchange. It is also the same rule the
session-start check exists for: **status is a fact, and facts get checked** before they are acted on.

**Every pull request delivers a numbered phase item or fixes a named bug.** Nothing else. No
standalone infrastructure or tooling pull request unless something is actually blocked — and then
the pull request says what is blocked, in its first line.

Ruled 2026-09-07. Of the sixteen pull requests merged after #49, eleven delivered none of Phase 4's
eighteen questions. Each was defensible alone; together they were most of a week. Tooling that a
blocked phase item needs is part of that item's pull request, not a separate one.

**Verify by running the thing and inspecting the result — never by reading the command or trusting its exit code.** Every defect this project has found in its own documentation and tooling failed by *appearing to work*: a seed command that reported success and seeded nothing, a restore that returned zero patients and reported mostly-success, a typecheck that passed against a renamed column, a CI pipeline that had never run the seed at all, a `--dry-run` that passed on exactly the lockfile CI then rejected. Five for five. An exit code of 0 is a claim, not evidence; the evidence is the row count, the rendered page, the error you deliberately introduced and watched appear.

**Prove a guard by breaking what it guards, before trusting it.** A guard that silently does nothing looks exactly like one that works — both produce a green run. So a change whose purpose is to make some class of mistake detectable is not finished when the suite passes; it is finished when the mistake has been deliberately introduced, the tooling has been watched to fail, and the change has been reverted. Record the contrast, not the claim: "0 errors before, 18 after" is a fact, "this adds type safety" is not. This applies to every guard added from here on, without being asked.

**`docs/SETUP.md` must be checked whenever a change adds a package tree, a new service, or a new required environment variable.** It went stale two commits after it was written — it still claimed `apps/web` did not exist — and nothing caught it. A setup document is only load-bearing on a machine that has never seen the project, which is exactly the machine nobody tests on.

## Ask before

- Changing any locked decision above
- Adding a dependency
- Anything that touches auth, permissions, or tenant scoping in a new way
- Anything not in the current phase document

## Flag, don't absorb

If you hit technical debt, an ambiguity in the spec, or a decision that should be the founder's, say so explicitly in your summary. Do not quietly pick an option and move on. A flagged question costs five minutes; a wrong silent assumption costs a week.

## Docs

- `docs/SETUP.md` — fresh clone to a green test suite on a new machine
- `docs/DEPLOY.md` — a brief for standing up a server. Not SETUP.md: several of that document's steps are actively wrong on a machine with a public IP
- `docs/ARCHITECTURE.md` — full design, schema, state machines, security model
- `docs/PRICING.md` — commercial model (context, not implementation)
- `docs/PHASE-*.md` — scope and Definition of Done per phase

**No phase document carries a status section.** No "Where things stand", no "current state", no
dated snapshot of what is done and what is next — in any `docs/PHASE-*.md`. Status is read from `gh
pr list` and `git log`, which the session-start rule already requires and which cannot go stale.

A snapshot is a second copy of a fact git holds authoritatively, and nothing keeps the copy honest.
`PHASE-3.md` §10 was written on 29 August 2026 and was wrong the next morning — PR #28 merged three
checkpoints it described as one-merged-one-next. On 31 August a session was briefed from it and
instructed to open an already-merged pull request and rebuild two finished checkpoints; the
mandatory branch check was the only thing that caught it. The section even carried the caveat
"branches outlive snapshots", which did not help: **a document that admits it might be wrong is
still read as true.** So the fix is deletion, not a warning label and not a correction — correcting
it just resets the clock on the same failure.

Phase documents hold what git cannot: scope, rulings and their reasons, the Definition of Done, and
open questions. Those are decisions, and decisions do not go stale when a branch merges.

**Tick a Definition of Done box only against evidence you actually have.** Leave the rest unticked.
An unticked box costs nothing; a wrongly ticked one is indistinguishable from a verified one and is
exactly how a finished thing gets rebuilt and an unfinished one gets shipped.
