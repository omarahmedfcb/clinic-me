# Pilot readiness — a week of work, as a checklist

Phase 5 closes with the audit viewer and the payments reports. What follows is **not a feature
phase**: it is the set of things that stand between a working product and a clinic using it in
anger, plus the non-engineering track that has to run alongside.

**One pull request per numbered line.** Every line names the guard that proves it, and carries an
estimate in minutes. Where an item is genuinely several shippable pieces — item 0 is — it is split
into sub-lines, each of which is one pull request, because "the platform console" is not a thing
that can be reviewed in one sitting.

**Nothing here is built yet.** This document is the plan, and the estimates are for building it.

## Two rulings that landed as code rather than as plan

Both were ruled on 2026-09-14 alongside the seven below, and neither is an item in this checklist —
they are review feedback on the two screens Phase 5 closed with. Recorded here so the plan and the
code do not disagree, with where each one actually shipped.

**Reports default to MONTH** — shipped in the reports pull request itself, where the review
feedback belongs. `«تقارير المدفوعات»` opened on the day, and a day with no receipts yet — any
morning, and every seeded or quiet day — renders as zeroes, which reads as a broken screen rather
than as an answer. The month is the period the figures are actually read against.

**The seed updates one user, so the audit viewer is never empty** — shipped with this document.
`users_audit` is `AFTER UPDATE ON users` only, and the seed created users and never updated one, so
`«سجل التدقيق»` carried 9,794 rows across 17 record types and **not one `users` row** — precisely the
record type the viewer was asked to show. The trigger was right; the data had nothing to prove it
with, and a reviewer opening that filter would have found a correct feature indistinguishable from a
broken one.

## How to read the estimates

They are the same currency `PHASE-5-PLAN.md` uses: minutes of building, against a codebase that
already has the schema, the guards and the test harnesses these items reach for. They do not
include the founder's review time, and they assume the item is picked up with the repository in the
state this document was written against.

An item marked ***carries a screen*** is opened and left unmerged, and the handover is a preview.
That is the standing rule and it applies here unchanged.

---

## 0. Platform console — the operator's own surface

The founder's surface, not a clinic's. `PHASE-1.md` scheduled it after Phase 5 deliberately: it
serves the operator, and the clinic-facing work is what stands between this and revenue.

### What already exists, because it changes what these pull requests are

Three things are already in the schema and are load-bearing here. Each is checkable:

| | |
|---|---|
| `users.is_platform_admin` | `schema.prisma:450`. A boolean on the global `users` row, **not** a membership role — which is exactly the shape item 0 asks for: an operator with no membership in any clinic |
| `AccessGrant` | `schema.prisma:1303` — `reason`, `expiresAt`, `approvedByUserId`. No hand-written code reads or writes it |
| `AuditAction.BREAK_GLASS_ACCESS` | In the enum, emitted by exactly one thing: `read_orphaned_audit_logs()`, the break-glass reader for a deleted tenant's audit rows (`prisma/sql/08-audit-logs-rls.sql`) |

**RULED 2026-09-14: `PLATFORM_ADMIN` is `users.is_platform_admin`, not a `MembershipRole`.**
`MembershipRole` stays `OWNER | ADMIN | DOCTOR | RECEPTIONIST | AI_AGENT` and is not touched. A sixth
value would put the operator *inside* the membership model — which contradicts "no membership in any
clinic" and would make every capability-matrix row grow a column for somebody who must never appear
in one. The boolean already says the same thing in the right place, and is already what the
database's own break-glass check reads.

**RULED 2026-09-14: the `AccessGrant` door to clinical data is SHUT, not unbuilt.** `PHASE-1.md` §6
had ruled that a platform admin *may* reach clinical data through an `AccessGrant` — written reason,
≤24h expiry, audited at grant time and on every read, clinic owner notified. That door is now closed:
the operator **never reads clinical or financial rows**, and there is **no impersonation**. The
distinction matters because an unbuilt door invites somebody to build it; a shut one does not.
`AccessGrant` stays in the schema as an unused table, and **`PHASE-1.md` §6 says so in as many
words** rather than leaving the reader to infer it from an absence.

This is what lets the founder say the sentence `PHASE-1.md` identified as the point of the whole
constraint, without qualification: **our staff cannot read your records.**

### The pull requests

**0a. The operator's identity and the wall around it. ~70 min.**
A platform admin authenticates, holds no membership, and reaches a `/platform/*` surface that no
clinic role can reach and that reaches no tenant-scoped row. No screens.

> **Guard: RLS blocks the operator from clinical and financial rows, and the sweep proves it.**
> An authenticated platform-admin session queries `patients`, `visits`, `payments`, `visit_charges`
> and `patient_credits` directly and gets **zero rows** — not a 403, and not an application filter:
> the operator's session binds no `app.current_tenant_id`, so every policy's `tenant_id = NULLIF(...)`
> is false and the rows are not there. Proven by breaking it: bind a tenant id in the operator's
> session and watch the same queries return rows.
>
> **And the second half, which is the one that rots:** a sweep in the shape of
> `clinical-leak-guard.integration.spec.ts` over **every** `/platform/*` endpoint, with the clinical
> sentinels. A route nobody lists is a route nobody sweeps, and that list is the point of the file.

**0b. Create a clinic, with its first ADMIN and a one-time password. ~80 min.** ***Carries a screen.***
Name, country, currency, timezone; one ADMIN membership; a temporary password shown once and never
readable again. The password path already exists — `PHASE-5-PLAN.md` PR 10 built
`must_change_password` and a temporary-password flow for the staff list — so this reuses it rather
than inventing a second one.

> **Guard: the created clinic is isolated from the moment it exists.** The new tenant's first read
> from another tenant's session returns nothing, and the new ADMIN cannot sign in without changing
> the password. Proven by breaking it: skip the `must_change_password` flag and watch the login
> succeed with the temporary credential.

**0c. The clinic list: status, last activity, aggregate counts, plan. ~60 min.** ***Carries a screen.***
Counts only — patients, doctors, appointments this month. No names, no rows, nothing a clinic would
recognise as its own data.

> **Guard: the list is aggregates and cannot become rows.** A response-shape assertion plus the
> clinical sentinel sweep from 0a covering this endpoint. Proven by breaking it: select a patient
> name into the payload and watch the sweep fail.

**RULED 2026-09-14: "plan" is computed from `PRICING.md`, never stored.** There are no tiers to
display. `PRICING.md` §3 is **one plan priced by size**: 1,500 EGP base (one doctor, 1,000 messages),
+900 EGP per additional doctor (+700 messages), 1 EGP per message beyond allowance, 3,500 EGP
one-time setup. The "plan" column is therefore a **computed line** — base + doctors + allowance —
derived from the doctor count the list already has. Nothing about a plan is written to `tenants`.

A stored tier would be a second copy of a fact `PRICING.md` holds authoritatively, and nothing would
keep the copy honest — the same reasoning that deleted the status sections from the phase documents.

**0d. Suspend and reactivate, with a reason. ~45 min.** ***Carries a screen.***
Never delete. `ARCHITECTURE.md` §6 already rules this: *"Suspension blocks access; it never deletes
data. A clinic that stops paying must not lose patient records — that is a PDPL problem, not a
commercial one."*

> **Guard: a suspended clinic's staff are refused and its data is untouched.** Row counts before and
> after suspension are identical, and a session for a suspended tenant is refused. Proven by breaking
> it: remove the suspension check from the auth path and watch a suspended clinic sign in.

**0e. Reset a clinic admin's password, on request. ~35 min.** ***Carries a screen.***

> **Guard: the reset is `BREAK_GLASS_ACCESS`-audited and cannot read anything.** The operator gets a
> one-time password to hand over and never sees the old one, never sees a clinical row, and the
> action writes an audit row naming who asked and who acted. Proven by breaking it: drop the audit
> write and watch the assertion that the row exists fail.

**0f. Every operator action audited. ~40 min.**
Not a screen — the interceptor and its coverage test, closing over 0a–0e.

> **Guard: a `/platform/*` route that writes and does not audit fails the build.** The same shape as
> `route-capability-manifest.spec.ts`: enumerate the write routes on the platform controllers, assert
> each one produced an `audit_logs` row in an integration test. Proven by breaking it: add a write
> route with no audit and watch the enumeration fail.
>
> This is also where `BREAK_GLASS_ACCESS` stops being emitted by nothing. `PHASE-1.md` states the
> trap plainly: an unused action is the correct state today and becomes a defect the moment a support
> path exists without it.

**0g. The seed's two clinics become creatable through the console. ~50 min.**
`blueprint.ts` hard-codes `nile-family-clinic` (عيادة النيل لطب الأسرة) and `shifa-derm-center`. This
turns the tenant-creation half into a call to the same service 0b uses, leaving the clinical and
scheduling seed data exactly where it is.

> **Guard: the seed and the console create the same shape of clinic.** Assert that a tenant created
> by the console and a tenant created by the seed carry the same columns, policies and first-ADMIN
> membership. Proven by breaking it: skip the membership in one path and watch the comparison fail.
>
> `SEED_REFERENCE_DATE` still governs: nothing in this item may read the clock.

---

## 1. Backups — automated, off-machine, encrypted, and drilled

**What exists, stated because it changes the estimate.** `docs/DEPLOY.md` §7 already carries the
design: what backs up, retention for staging and production, a `pg_dump` script, the **attachments
gap** (`pg_dump` does not cover `ATTACHMENTS_STORAGE_ROOT`, and a restore succeeds anyway, producing
records whose downloads fail), the deliberate ordering choice between an orphan file and a missing
file, §7b on dependency changes, §7c on recovering into a fresh cluster with `NOSUPERUSER` and
`NOBYPASSRLS`, and a drill result dated 2026-08-27.

What does **not** exist: the script anywhere except inside that document, any automation, any
off-machine copy, any encryption at rest, WAL archiving, and any check that runs without a human.

**1a. The backup script, in the repository, with WAL archiving and encryption. ~70 min.**
`scripts/backup.sh` — the dump, the attachment archive, the size floors that refuse to keep a file
that is not a backup, `age` or `gpg` encryption, and upload to object storage in a different failure
domain. A nightly dump on the same VM as the database is not a backup.

> **Guard: the script refuses a backup that is not one.** Run it against an empty database and watch
> the size floor reject the output; run it against a real one and watch both artefacts appear
> encrypted. Proven by breaking it: lower the floor to zero and watch an empty dump be retained.

**1b. The restore drill, as a script rather than a procedure. ~60 min.**
`scripts/restore-drill.sh`: fresh database, restore, compare row counts per table against the source,
**open a restored attachment**, and assert RLS still refuses an unbound session. The drill in §7 is
honest about its own gap — it counts rows, and the rows are all there even when every file is
missing.

> **Guard: the drill fails on a backup that restores rows and loses files.** Delete one file from the
> attachment archive and watch the drill fail on the download rather than pass on the counts. That is
> the contrast to record — the old drill passes this case, which is why it is being replaced.

**1c. The nightly restore, on the server. ~45 min.**
**RULED 2026-09-14: the nightly restore runs on the server, from cron, and alerts on failure — not
on CI.** A CI job would need read access to production backups from GitHub, which puts a credential
for the one copy of the clinic's data in a place that copy is not otherwise reachable from. Running
it where the backups already are keeps that credential off GitHub entirely, and the alert channel
built in **2c** is how a failure reaches a person.

Restores **last night's dump** into a fresh database and asserts the counts.

> **Guard: this is itself the guard, and it has to be able to fail.** Point it at a deliberately
> truncated dump and watch the assertion fail *before* trusting the green run. A restore job nobody
> has seen fail is a cron entry, not a backup.
>
> **And the alert has to fail too.** Break the restore and watch the message arrive on the phone —
> a check that runs on the server and reports only to a log file nobody opens is worse than a CI job,
> because it looks like it is watching.

**1d. The runbook. ~30 min.**
`docs/DEPLOY.md` §7 is already most of it; what it lacks is the "it is 3am and the database is gone"
ordering, an explicit RTO/RPO, and where the encryption key lives — which must not be the bucket the
dump is in.

> **Guard: somebody who has never seen the project can follow it.** The same bar `SETUP.md` is held
> to, and the same reason it went stale: a runbook is only load-bearing on a machine nobody tests on.

---

## 2. Deployment — an Egypt-hosted server

**`docs/DEPLOY.md` already flags the open question**, at §9: *"The provider is not chosen.
`ARCHITECTURE.md` §14 still carries 'Decision required'."* `docker-compose.server.yml` exists and
Caddy already terminates HTTPS, so this item is narrower than it looks.

**2a. Provider comparison, written down. ~60 min.** *Not code.*
Two or three providers with data centres physically in Egypt, each with: monthly price for the
shape §14 needs, what they will sign (a Data Processing Agreement is the one that matters), whether
they can produce a data-residency attestation, and what PDPL needs from each given Decree 816/2025
becomes enforceable on **31 October 2026**.

> **Guard: each row cites a source the founder can re-check.** A price with no link is a
> recollection, and this project has a rule about those.

**2b. Production compose, HTTPS, secrets outside the repo. ~50 min.**
Hardening what `docker-compose.server.yml` already does, plus the `clinic_os_app` password trap
`DEPLOY.md` §3 documents at length, as a scripted step rather than a paragraph somebody follows.

> **Guard: a fresh host reaches a healthy stack from the document alone.** Run it on a throwaway VM
> and watch `/health` go green, then break the app-role password and watch the health check fail the
> way §3 says it will — the failure that looks like a hang.
>
> **`.env.example` stays current**, and `docs/SETUP.md` is checked in the same pull request: both are
> standing rules, and both have gone stale before.

**2c. Health monitoring and an alert to the founder's phone. ~45 min.**
The health module exists; nothing watches it. An external check — not one running on the host it is
checking — plus one alert channel that reaches a phone.

> **Guard: the alert fires.** Stop the API and watch the message arrive; a monitor nobody has seen
> alert is a dashboard. Record the time from stop to phone.

---

## 3. Real-device pass

**3a. iPhone Safari and Android Chrome, through both flows. ~90 min.** *Not code, unless it finds
something.*
Reception: search, book, check in, take payment, print a receipt. Doctor: queue, open a visit, write
it, prescribe, complete. Then camera attachment, and printing from a phone.

> **Guard: a written per-device result, and a bug for every failure.** Playwright's smoke test
> (`apps/web` `npm run smoke`) exercises a desktop browser and cannot answer this — a real iPhone is
> the only thing that answers an iPhone question. The output of this item is a table of what was
> tried on what, not a green tick.
>
> **The RTL and Latin-digit rules get their eyes here too**: the numerals guard is mechanical, but
> bidirectional layout on a real phone keyboard is not.

---

## 4. Security pass

**4a. OWASP top-10 walk against the API. ~90 min.**
Each of the ten, named, with what was tried and what came back. Most are already answered by the
architecture — tenant isolation is RLS plus a Prisma extension, `tenantId` comes only from a
validated JWT, DTOs run `whitelist: true, forbidNonWhitelisted: true` — and writing down *which*
mechanism answers *which* item is the point, because the next person to ask will not re-derive it.

> **Guard: each item cites the test or the policy that answers it.** An unanswered item is listed as
> unanswered rather than reasoned away.

**4b. Rate limits beyond auth. ~45 min.**
`auth-throttle.ts` exists and covers login with two buckets. Nothing else is limited.

> **Guard: the limit refuses.** Drive a route past its limit and watch the 429; proven by breaking it
> — raise the limit and watch the same script pass. Record both numbers.

**4c. Session lifetimes, reviewed and stated. ~30 min.**
Access token, refresh token, rotation, and what happens to a token after a membership is suspended.
The membership-freshness interceptor already re-checks on every authenticated request, so a
suspension takes effect immediately; that should be asserted rather than believed.

> **Guard: a suspended membership's live token stops working on its next request.** Proven by
> breaking it: remove the interceptor and watch the token keep working.

**4d. The clinical sweep becomes a release gate. ~25 min.**
`clinical-leak-guard.integration.spec.ts` already runs in CI on every push. This binds it to the
deploy step, so a release cannot go out without it.

> **Guard: a release with a leaking endpoint does not ship.** Add a sentinel to a reception payload
> and watch the deploy refuse, then remove it. The sweep already fails correctly — what is being
> proven here is that the *gate* is wired, which is a different claim.

---

## 5. Onboarding kit for the sales team

*Not code. All of it is `docs/`, and the audience is a person who has never read this repository.*

**5a. Clinic setup checklist. ~60 min.**
Identity, doctors, services, prices, hours, staff accounts — in the order the screens actually take
them, with the decisions that block progress called out (a service with no price, a doctor with no
schedule).

**5b. A 10-minute receptionist script. ~45 min.**
**5c. A 10-minute doctor script. ~45 min.**

> **Guard for 5a–5c: ten minutes to competence, measured on a person who has not seen the product.**
> That bar is `ARCHITECTURE.md`'s, and `PRICING.md` treats staff turnover erasing training as a
> listed risk. A script nobody has timed is an estimate.

**5d. The rule that the first admin is created by us. ~15 min.**
Written into the kit and into `docs/PILOT-READINESS.md`'s own §0b, so the console and the sales
process say the same thing. It is also the reason the console exists: there is no self-serve signup
and there should not be one before PDPL is settled.

---

## 6. Quick wins that change adoption

Small, each independently shippable, each *carrying a screen*. These are the ones a doctor notices
in week one, which is the week the pilot is won or lost.

**6a. Favourite prescriptions per doctor. ~70 min.** ***Carries a screen.***
Per doctor, not per clinic. `PHASE-4.md` Q8 already ruled medication is free text with autocomplete
from this clinic's own history; this is that, pinned.

> **Guard: one doctor's favourites are not another's.** Two doctors, and A's list does not contain
> B's. Asserted as *"the query returns nothing"*, never *"the guard rejects"* — the distinction
> `PHASE-1.md` records for every `own`-scoped route.

**6b. Repeat last visit's prescription. ~50 min.** ***Carries a screen.***

> **Guard: repeating is a new prescription, never an edit of the old one.** The previous visit's
> items are unchanged after the repeat, and the new visit carries its own rows. Medical records are
> never rewritten — proven by breaking it: make the repeat mutate the source and watch the
> append-only assertion fail.

**6c. Allergy-vs-prescription red warning. ~60 min.** ***Carries a screen.***

> **Guard: the warning appears on a real match and does not appear on a near-miss.** Both halves, and
> the second is the one that decides whether anyone keeps reading it. This is a **matching rule**, so
> it ships with what it wrongly flags as well as what it catches — the standing rule for any matching
> or normalisation rule in this project.

**RULED 2026-09-14: 6c ships labelled «تنبيه استرشادي — مطابقة نصية» ("advisory — text match"), and
the pilot doctor is asked about it in week one.** It is the first thing in the product that is
clinical advice, and free-text medication names (Q8) mean the matching is on strings a human typed.
The label is not a disclaimer bolted on: it is the honest description of what the check does, and it
is what stops a doctor treating silence as clearance. It ships with the label rather than waiting for
the doctor's answer, and the answer in week one decides whether it stays, tightens, or goes.

This follows the standing rule that a refusal or a warning asserts only what the system can actually
justify. "This name matches a recorded allergy" is justified. "This drug is unsafe for this patient"
is not, and the label is the difference.

**6d. Owner dashboard numbers. ~70 min.** ***Carries a screen.***
Today's revenue, no-show rate, revenue per doctor, open insurance shares. Phase 5 PR 14 already
computes three of the four for the payments report; this is the owner's framing of them plus the
no-show rate.

> **Guard: the dashboard and the report cannot disagree.** Both read the same service, and the
> assertion is that the two payloads carry the same figures for the same day. Proven by breaking it:
> compute one of them locally and watch the comparison fail.

---

## 7. PDPL parallel track — for the founder, not for engineering

`ARCHITECTURE.md` §20 already lists this track and §17 already carries the compliance model. This is
not a pull request; it is a list with what each item needs, pulled forward so it is visible next to
the engineering work rather than buried at the end of a design document.

| | What it needs | Blocks |
|---|---|---|
| **DPO appointment** | A named person, contactable, with the role written into the DPA. May be the founder in the pilot; may not be once there are employees | Nothing technical. Blocks a compliant contract |
| **Data Processing Agreement** | Legal review, and the **Controller/Processor split written down**: the clinic is Controller, the platform is Processor (§17). Must be papered in the subscription agreement | Signing a paying clinic |
| **Egyptian entity, or a local representative** | A decision first — entity or representative — then whichever is chosen. Needed if the contracting entity remains non-Egyptian | Cross-border questions, and the hosting contract in 2a |
| **PDPC licence / permit** | The application itself, which has a lead time nobody here knows | Commercial launch. `ARCHITECTURE.md` §21 lists licensing delay as a high-impact risk |
| **Hosting provider selected and contracted** | Item **2a** produces the comparison; this is the signature | Item 2b, and every date below |

**The date that governs all of it: 31 October 2026.** Decree 816/2025 makes the Executive
Regulations fully enforceable then, and health data is a sensitive category under Law 151/2020.
`ARCHITECTURE.md` §20's own words: these run *"alongside development and are not on the critical path
of any phase, but they are on the critical path of the business."*

**One item from §20 that is still open and is not legal work:** *"Prescription language and mandatory
content — does Egyptian regulation require prescriptions to be in Arabic, and does it mandate
particular fields?"* The schema absorbs either answer (D20 makes document language a tenant setting),
but the answer decides whether the option may exist at all. It is one conversation with the pilot
doctor or a pharmacist, and it is free.

---

## What this week is not

**It is not a feature phase**, and item 6 is the only place features appear. If the week runs long,
**item 6 is what gets cut** — a clinic can be onboarded without favourite prescriptions and cannot be
onboarded without a backup that has been restored. The ordering rule this project already uses:
a slipping phase cuts scope, not quality, and tests are never the thing that gets cut.

**It does not include the WhatsApp or AI work.** Those are Phase 6 and later, and coupling pilot
timing to Meta's verification queue is the thing Guiding Decision 4 exists to prevent.
