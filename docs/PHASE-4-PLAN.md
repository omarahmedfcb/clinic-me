# Phase 4 — the build order

**What this document is.** A proposed order of pull requests taking Phase 4's fifteen unbuilt items
to built, with the guard each one is finished by. Produced 2026-09-07, after a reality check against
the tree rather than against `PHASE-4.md`.

**What it is not.** It is not a status section, and it must never become one. Nothing here records
what is built; that is read from `gh pr list` and `git log`, per `CLAUDE.md`. What is recorded here
is an ordering and the reasons for it — a decision, which does not go stale when a branch merges.
The one thing that *would* go stale is a tick beside each PR, so there are none. If you want to know
how far this plan has got, read the log.

**The rulings are not reopened here.** All eighteen questions in `PHASE-4.md` are ruled. This
document decides only the order they are built in and what proves each one done.

---

## 1. What the tree actually holds

Checked 2026-09-07 against `develop` at `3fc0a00`, and against every branch that has ever existed
via `git log --all -- <path>`.

| | Questions | |
|---|---|---|
| **Built** | Q11, Q13, Q18 | Storage seam; route→capability manifest; past-visit detail |
| **Partial** | Q10, Q16 | Attachments backend complete, no screen; HTTPS dev server exists, no device result |
| **Not built** | Q1–Q9, Q12, Q14, Q15, Q17 | The visit screen, the typing guarantee, prescriptions, drafts, the queue's visit status |

**The single fact this plan is shaped by:** `npm run routes` prints 60 routes and every clinical one
is a `GET`. There is no endpoint anywhere in the product that writes visit clinical content.
`git log --all -S "visitRevision.create"` returns nothing on any branch. The code says so itself, at
`apps/api/src/modules/clinical/visit-detail.ts:68` — *"They will be empty until the visit write path
exists."*

So Phase 4 is not partly done with a screen missing. **The read half is built and the write half
does not exist**, and everything below is the write half.

### The two schema items that were promised and never landed

`PHASE-4.md` §5 says *"two integer columns and one partial unique index."* One integer column
shipped (`appointments.quoted_price_minor`, PR #50). Missing:

- **a revision counter on `visits`** — Q7's compare-and-set has nothing to compare
- **a partial unique index, one `COMPLETED` visit per appointment** — Q2's constraint does not exist;
  `visits` carries no unique index on `appointment_id` at all

Both are prerequisites, which is why PR 1 is a migration.

---

## 2. The order, and why this one

Ten pull requests. The shape is the workflow `CLAUDE.md` already mandates — schema, then backend
with tests, then endpoints, then screens — applied to a phase whose backend is entirely absent, with
**one deliberate exception** recorded below.

**Backend first is not a preference here, it is arithmetic.** The founder reviews frontend with his
eyes and has ten to fifteen hours a week. Seven of these ten PRs need no review time at all beyond
reading a diff, because a test proves them. Putting a screen early would spend the scarce resource
on a screen whose backend could still move underneath it — which is how the schedule editor, the day
view and the visit history each got reviewed against a build that no longer matched.

That argument is sound and it is not the whole picture, which is what the exception is about.

### The order

**7d → 3 → 4 → 7e → 5 → 7f → 8 → Phase 5 → inventory → 9 → 10.** Rewritten 2026-09-08 after the
founder's first review of the built visit screen (`PHASE-4.md` §4b, Q21–Q33).

**PR 6 and PR 7c no longer exist as separate steps.** PR 6's prescription backend folds into 7e,
which builds the structured prescription the screen actually needs (Q24) — a backend written first
would have been written against a guess at the line shape. PR 7c, the insurance registry, is
withdrawn from this phase: its money fields conflict with a recorded ruling and are unresolved.

The order the founder proposed is kept unchanged. Dependencies were checked against it and agree:

- **7d before everything** — three intake defects, one of them a bug PR 7a introduced (Q32). A
  defect in the screen reception uses all day outranks new work.
- **3 before 4 and 7e** — draft privacy has to land before any real doctor writes a draft, which was
  already this plan's constraint and has not moved.
- **4 before 7e** — 7e's end-visit button (Q26) *is* Q6's completion, and 7e's procedures section
  (Q25) is what the completion turns into an invoice. Building the button before the thing it
  triggers would mean building it twice.
- **7e before 5** — the queue's visit status (Q14) reports on a visit whose shape 7e changes.
- **7f before 8** — printing cannot render a letterhead that does not exist (Q28, Q29).

**Phase 5 and the inventory module now interrupt Phase 4** (Q33). The attachments UI and the iPhone
check wait behind them. That is the founder's call and it follows from Q33's reason: the visit cycle
has to be usable end to end before anything else earns time.

### Estimates

A **day** below means one working session of build-and-verify, not a calendar day. At ten to fifteen
hours a week, **one day here is roughly half a calendar week.**

**Every PR body records its start and end time, and the elapsed figure.** Six PRs have now done so,
and the figures are 6–20 minutes each rather than days — they measure build-and-verify against a
ruled design, not the review time that is the actual constraint. **They are not a basis for
rescaling the remaining estimates**, and saying so is the point of recording them.

---
---

### PR 1 — the migration Q2 and Q7 depend on

**Delivers** the foundation for Q2 and Q7. **1 day.**

Two changes and nothing else:

- `visits.revision INTEGER NOT NULL DEFAULT 0`
- a partial unique index: one `COMPLETED` visit per `appointment_id`. Not one *row* per
  appointment — several drafts may exist and one may finish, which is exactly what Q15 requires

**Guard: a second `COMPLETED` visit is refused by the database, not the service.** The Definition of
Done says this explicitly, and the distinction is the whole point — a service-layer check passes on
a machine where the index was never applied. Proven by inserting a second completed row directly
through the client and watching Postgres reject it, then removing the index and watching the test
fail.

Also corrects `ARCHITECTURE.md` §4, which describes `appointments 1:0..1 visits` — a constraint that
never existed and, after Q15, is not the one we want.

**Why first:** PRs 2, 4 and 5 cannot be written against a schema that has no revision column. This
is also the last cheap moment to change either decision; both are expensive to reverse once drafts
exist.

---

### PR 2 — the draft write path

**Delivers Q2 (partly), Q4 (server half), Q7, Q17 (server half). 2–3 days.**

The first endpoint in the product that writes clinical content: create a draft, autosave into it,
with compare-and-set on `revision` — never last-write-wins, never a lock.

**Guard: every reader of `visits` goes through one shared draft filter, and a reader that does not
fails the build.** Modelled on `route-capability-manifest.spec.ts`, which already does exactly this
shape of static check and shares its source scanner. Proven by adding a query that reads `visits`
directly and watching the build reject it.

**Second guard:** two clients editing one visit — the second is refused with a code, not silently
overwritten. Proven by making the update unconditional and watching the test fail.

---

### PR 3 — whose draft it is, and what happens to one nobody finishes

**Delivers Q2 (completing it), Q15. 2 days.**

Draft content private to its author; abandonment derived on read against a passed-in instant — no
job, no stored status.

**Guard: a draft's content is invisible to everyone but its author**, proven with a second doctor's
token *and* a reception token against a draft containing sentinel text, and added to
`clinical-leak-guard`. That file already carries the machinery and learned this lesson once: it
gained an attachment sentinel because it could not previously see a whole class of leak.

**Second guard: the abandonment test moves only the clock.** `CLAUDE.md` is emphatic that anything
called reproducible takes its reference point as a parameter — a derived status that reads
`new Date()` is untestable at exactly the boundary that matters.

**Also:** accepting a transfer gives the receiving doctor an *empty* draft, and a pending transfer
changes nothing for the originating doctor.

---

### PR 4 — completion, and what an amendment is

**Delivers Q6, and extended 2026-09-08 to carry Q24's follow-up appointment and Q25's procedures.
3 days.** Completion is the moment both happen: the follow-up becomes a real appointment, and the
recorded procedures become the invoice `PHASE-5-DESIGN.md` says is built at COMPLETE. Building the
button in 7e before the thing it triggers exists would mean building it twice.

Completing a visit; editing a completed one writes a `visit_revisions` row with a reason, originals
recoverable.

**Guard: the D5 append-only trigger proven by attempting both an `UPDATE` and a `DELETE`** on
`visit_revisions` and watching the database refuse. The trigger has existed since
`20260821193441_constraints` and **nothing has ever written a row through it** — so this is the
first time it is exercised at all, and an untested trigger is indistinguishable from an absent one.

**Note for the founder:** Q6's completion trigger is the one ruling `PHASE-4.md` flags as most
wanting a sanity check. This PR is where it becomes expensive to change. Worth re-reading §Q6 before
it is merged, not after.

---

### PR 5 — reception sees that a visit is in progress

**Delivers Q14. 1 day.**

`visitStatus` on the queue row. The queue DTO currently carries no visit field at all.

**Guard: an allow-list over the DTO's keys**, so a field added later fails this test rather than
passing silently. The Definition of Done singles this out — the sentinel sweep cannot catch a
*derived* leak such as a character count, and this box is the only thing that guards it. Proven by
adding a second visit field and watching it fail.

Small and self-contained, so it slots wherever review capacity allows.

---

### PR 6 — prescriptions, backend — **RETIRED 2026-09-08, folded into 7e**

Q24 rules the prescription as structured lines on the visit screen. A backend built first would have
been built against a guess at the line shape, and 7e is where the shape becomes known. Kept here
rather than deleted so the entry is not re-derived: the reasoning below still applies to 7e.

**Delivers Q8, and Q9's data half. 2 days.**

`prescription_items` has existed since Phase 1 and nothing writes it. Free text **with autocomplete
from this clinic's own history**, as Q8 rules — a tenant-scoped query, through the tenant extension.

Scope confirmed unchanged 2026-09-07. Autocomplete was briefly deferred earlier the same day; the
deferral is withdrawn and it ships with PR 6.

**Guard: a prescription sentinel in `clinical-leak-guard`.** Prescription items are clinical content
under `CLAUDE.md`, and the sweep currently has no sentinel that would notice one reaching reception.

**Constraint:** the Arabic normalisation written for patient-name search must not be reused.
Clinical free text is stored and searched byte-identical.

**Open, and it decides the shape:** what the matching rule should be. D19 records a 0.7 threshold
tuned on synthetic names with trigram indexes that turned out unused. Flagged before building.

---

### PR 7 — the visit screen

**Delivers Q1, Q3, and the client halves of Q4, Q5, Q17. 3–4 days, and the estimate I trust least.**

One screen, free text, autosave with an indicator that never claims "saved" when it has not,
resuming a draft that says so with a timestamp, and two drafts open at once saving independently.

**This is the founder's visual review checkpoint, and the first screen in the phase.**

**Guard: a visit survives a simulated crash** — typed, client killed with no cleanup, reopened, text
present. A kill, not a logout; the Definition of Done is explicit, because a logout runs cleanup and
proves nothing.

**Second guard:** two drafts open, one with a failing save — neither loses text, and the indicator
reports per draft rather than globally. `apps/web` gained a vitest runner in PR #65, so this is
testable now in a way it was not a week ago.

**Before review begins:** confirm the build he is looking at is current. This project has put a
stale build in front of him three times, and his ruling stands — *"a review loop where I can be
looking at last week's code is worse than no review loop."*

---
### PR 7a — patient intake

**Delivers the registration path the product did not have. 2–3 days.**

Before this, `POST /patients` existed and **nothing in the client called it** — no create function in
`patients-api.ts`, no button on `PatientsPage`, and no way out of the booking dialog's empty search
result. A walk-in whose name was not already in the system could not be booked at all.

- **"مريض جديد"** on `PatientsPage`, and inside **"موعد جديد"** when the search finds nothing,
  prefilled with what was typed.
- **Required at intake:** full name (Arabic), phone, date of birth, gender, nationality. Columns stay
  nullable for rows already recorded — **D26**, which reverses the 21 August ruling and says why.
- **"ملف ناقص"** badge on any patient missing a required field, derived on read, cleared by
  completing the record.
- **Nationality** is an ISO country list with Arabic names, default `EG`.
- **Egyptian national ID** optional, 14 digits, validated on century, date and governorate. Fills date
  of birth, gender and governorate; staff may correct, and a disagreement warns rather than refuses.
  Unique per tenant when present, searchable from the same box as name and phone — **D27**.
- **Non-Egyptian:** the national ID field is not shown; passport number is offered instead.
- **Family:** a phone that already belongs to a contact offers *"فرد جديد في نفس الأسرة"* with a
  relationship, or opens the existing patient. A child may have neither phone nor ID — **D28**. Family
  members are listed on the patient detail page.
- **Optional:** English name, second phone, address and governorate, emergency contact, referral
  source, notes.

**Guards:** the NID parser is a pure function with tests; a second patient with the same NID is
refused **by the database**; the booking dialog's no-results path offers the button.

---

### PR 7b — clinical profile and vitals

**Delivers the patient-level clinical record and per-visit measurements. 2 days.**

- **Profile**, patient-level and doctor-editable: family and hereditary history, risk factors.
  **Allergies already exist** (`patient_allergies`, and the safety summary reads them) — linked, not
  duplicated. A second allergy list is a second thing to keep in step, and one of them would go stale.
- **Vitals**, per visit, on the visit screen: weight, height, blood pressure, temperature, pulse, and
  **head circumference when the patient is under 5**. Free numeric fields with fixed units
  (kg / cm / mmHg / °C / bpm), shown against the previous visit's values so a trend is visible without
  opening the history.

**Guards:** vitals go through `visitScope` like every other visit read — the counting guard from PR 2
already fails a reader that does not; and `clinical-leak-guard` gains a vitals sentinel, because a
weight reaching reception is a clinical leak the existing sentinels cannot see.

---

### PR 7c — insurance registry — **MOVED TO PHASE 5, ruled 2026-09-08**

Not a Phase 4 step. **The two money fields — default coverage percentage and copay — wait for Phase
5**, because `schema.prisma` on `InsurancePolicy` says *"No money here… A percentage here invites a
service to multiply by it and store the result"* and `PHASE-5-DESIGN.md` §4.2 makes the payer split
manual precisely because no coverage rate exists yet.

The rest ships as **the first PR of Phase 5**, built on the existing `insurance_policies` model: a
registry the policy points at, with the legacy free-text `insurerName` staying readable rather than
migrated away.

**Delivers the company registry reception picks from. 2 days.**

**Reports what the insurance module already models before changing anything, and extends rather than
replaces.** `patient_insurance`, `insurance_policies` and the household policy shape exist
(`prisma/sql/21-patient-insurance.sql`). **Claims stay in Phase 5** — `PHASE-5-DESIGN.md` records the
finding that Egyptian insurers offer a portal each plus paper, so modelling a claim now builds an
integration nobody can use.

- **Clinic admin:** an insurance companies list and form — name, type (insurer / TPA / corporate
  contract / government), contract number and dates, contact person, phone, email, claim submission
  method, payment terms in days, default coverage percentage and copay, prior-approval required,
  active flag.
- **Reception:** a patient's insurance names a company **from that list** — member number, plan, card
  expiry, primary or secondary. A patient may hold more than one.

**Guard:** an inactive company cannot be attached to a patient.

---


### PR 7d — the intake defects

**Delivers Q30, Q31, Q32. 1 day.** Three defects in the screen reception uses all day, one of them
mine.

- **Booking a new patient does not select them (Q32).** PR 7a searched by patient id; search matches
  name, phone and national ID, so a UUID matched nothing and the selection was silently `null`. The
  comment beside it described the correct intent while the code did the wrong thing.
- **Date of birth is typed `dd/mm/yyyy` with a computed age beside it (Q31)**, past years only.
- **Family linking (Q30)** — kinship, bidirectional, distinct from D28's shared-phone household.

**Guards:** the created patient is asserted *selected*, not merely created; a future date of birth is
refused; a link written in one direction is asserted readable from the other.

---

### PR 7e — the visit screen, restructured

**Delivers Q21–Q27, and folds in the prescription backend that was PR 6. 4–5 days, and the largest
step left.**

Patient header (Q21); the profile becomes append-only with author and timestamp (Q22); per-visit
`medicalHistory` becomes history of present illness (Q23); investigations, follow-up and a structured
prescription (Q24); the procedures section (Q25); the end-visit button (Q26); the disabled stock
placeholder (Q27).

**Guards:** append-only proven by attempting an update and a delete; the follow-up appointment
asserted to exist after completion; the stock button asserted disabled and handler-less; procedures
asserted to carry a price snapshot that a later price change does not move — the rule PR #50 already
enforces for `quoted_price_minor`.

**Migration rule, ruled 2026-09-08.** Q22's append-only profile replaces the single mutable row PR 7b
built the day before, and that table has rows in it. **Every existing `patient_clinical_profiles` row
becomes the first append-only entry, authored by its `updatedByUserId` at its `updatedAt`. Nothing is
dropped.** Guard: a row present before the migration is readable after it with the same author.

---

### PR 7f — clinic identity and doctor print fields

**Delivers Q28. 1 day.** Pulled forward from Phase 5 because printing needs them.

Clinic name, logo, address and phones; per doctor a printed name and title, syndicate number,
signature image and stamp image. Images go through the `StorageProvider` seam PR #53 already built —
a second upload path would be a second thing to secure.

---

### PR 8 — the prescription screen, and it prints

**Delivers Q9. 2 days.** Print is the delivery mechanism by ruling — no PDF service, no email.

**Guard:** print layout asserted as rendered output rather than eyeballed, so a CSS change that
breaks the printed sheet fails a test. The screen still needs his eyes; the layout regression does
not.

---

### PR 9 — the attachment screen, and the camera

**Delivers Q10 (completing it), Q12. 2 days.**

The backend is done and tested — 939 lines of integration spec, sniffing, archiving, the reception
summary that shows existence and never content. What is missing is any way to use it: there is no
`<input type="file">` anywhere in `apps/web`.

**Guard: reception's view of the screen shows no filename**, asserted against raw response text with
a real uploaded filename. The API already refuses to send one; this asserts the screen does not
reconstruct it from somewhere else.

---

### PR 10 — one screen on a real iPhone

**Delivers Q16. 0.5 days. Confirmed in scope by the founder on 2026-09-07.**

`dev:https` already exists (commit `57ff421`), so the enabling work is done. This needs the device
and a screen worth testing, which is why it is last rather than optional.

**It is not dropped, and the reason is the pilot.** §8 of `PHASE-4.md` records WebKit as not a Phase
4 deliverable by default, and the founder's ruling here is that the default does not apply: the
pilot doctor is likely to be on a phone, so a screen that has never been rendered on WebKit is a
screen nobody has checked in the place it will actually be used. Half a day against that is not a
trade worth making.

Q16 therefore closes by being **done**, not by being decided away.

---

## 3. Orderings I considered and rejected

**Kept here after being overruled: putting PR 7 last among the backend work.** This was the original
proposal, and the founder moved the visit screen to third on 2026-09-07. The argument for it is in
§2 and is better than the one it replaced; it is recorded here rather than deleted so the next
reader can see that the ordering principle has a known exception and why, instead of re-deriving it.

What the original got wrong was treating the screen as *presentation of* the draft write path. It is
not — it is the other end of a contract, and a contract with one end built is one end of a guess.

**Schema, then all screens, then backend.** Rejected outright, and the amendment above does not
reopen it. Moving one screen up to exercise a contract is not the same as moving every screen ahead
of the work it displays. PRs 8 and 9 stay behind their backends, which are settled by tests.

**One "drafts" PR covering PRs 2, 3 and 4.** Rejected. It is the natural unit conceptually — create,
own, finish — and it would be roughly 1,500 lines with four guards, which is not one reviewable step.
The split at PR 3 is deliberate: PR 2 is *can it be written*, PR 3 is *who may see it*. Those fail
differently and a reviewer holding both at once will check neither properly.

**Prescriptions (PR 6) before completion (PR 4).** Rejected, but it is close, and it is the one place
this order could reasonably change. Prescriptions do not depend on the amendment machinery, so
they *could* come earlier. Kept later because Q6 carries a flagged uncertainty the founder wants to
sanity-check, and the longer that sits unbuilt the more code gets written against an assumption he
might overturn.

**Q14 (PR 5) first, as a warm-up.** Rejected as sequencing, not on merit. It is genuinely
independent and genuinely one day. But it touches the queue DTO, which PR 3's leak sweep also
touches, and doing it first means doing that merge twice.

**Deferring the partial unique index to PR 4, where completion lives.** Rejected. It is the
constraint that makes "one completed visit per appointment" true, and adding it after drafts exist
in a real database means discovering then whether any data already violates it. Constraints are
cheapest before there are rows.

---

## 4. Open questions, flagged rather than absorbed

1. **Q6's completion trigger — still open.** `PHASE-4.md` marks it as the ruling most wanting a
   sanity check, and PR 4 is where reversing it stops being cheap. The reordering makes this
   slightly more urgent, not less: PR 7 now ships a visit screen *without* a completion button
   precisely so that Q6 stays movable while a real screen exists to think about it against.
2. **Prescription autocomplete matching — open, and in scope for PR 6.** The rule itself is
   undecided; the feature is not deferred. Must not reuse the patient-name normalisation.
3. **Q16 / WebKit — closed. In scope, as PR 10.** Ruled by the founder on 2026-09-07: the pilot
   doctor is likely on a phone, so `PHASE-4.md` §8's default does not apply. Q16 closes by being
   done.
4. **`prisma/sql/` next free number is 22.** `PHASE-4.md` §5 says the same, checked against every
   branch. Now that all merged branches are deleted, 22 is unambiguous.
