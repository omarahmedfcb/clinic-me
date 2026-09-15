# Phase 5 — the build order

**What this document is.** A proposed order of pull requests taking Phase 5 from ruled to built, with
the deliverable, the guard that finishes each one, and an estimate. Produced 2026-09-09, the day
Phase 4 closed, against `develop` at `96c990b`.

**What it is not.** It is not a status section and must never become one. Nothing here records what
is built; that is read from `gh pr list` and `git log`, per `CLAUDE.md`. There are no ticks beside
these pull requests, deliberately — a tick is the one thing here that would go stale.

**The rulings are not reopened.** `PHASE-5-DESIGN.md` §7 carries seven decisions, all ruled by the
founder on 2026-09-03. This document decides only the order they are built in and what proves each
one done. Where this plan disagreed with the design it said so out loud and left the decision to the
founder; there was one such place, §2, and he ruled it on 2026-09-09.

---

## 1. What the tree actually holds

Checked against `develop` at `96c990b` and against every branch via `git log --all -- <path>`, not
against any document.

| | What exists |
|---|---|
| **Built and load-bearing for this phase** | `visit_procedures` with `unit_price_minor`, `quantity` and a `source` enum (Phase 4 D29); `appointments.quoted_price_minor` (the price snapshot); visit completion with its state machine; `insurance_policies` and the whole `modules/insurance` backend |
| **Exists and is not what the name suggests** | `Invoice` — SaaS **subscription** billing, per `PHASE-5-DESIGN.md` §1.2. The clinical document cannot reuse that name |
| **Exists with no application code** | `payments`, including a `GENERATED` `remaining_minor` column (D7) |
| **Does not exist** | `visit_charges`, `visit_charge_lines`, `chargeable_materials`, any coverage rate, any per-clinic patient number, any settlement code |

**Two facts shape everything below.**

**First: Phase 4 built B.** `PHASE-5-DESIGN.md` §6.1 argued that procedures must *not* be built in
Phase 4, because "procedures are written into a table that nothing reads" — and Phase 4 built them
anyway, in PR 4. That argument was not wrong; it was overtaken. The consequence is concrete and §2
records how it was settled.

**Second: `payments` is simultaneously an invoice and a receipt.** It carries `service_price_minor`
and `discount_amount_minor` beside `method`, `paid_at` and `collected_by_user_id`. One such row
cannot hold three procedures and cannot hold two part-payments in cash and then Instapay. Splitting
it is the largest change in this phase and everything downstream waits on it.

---

## 2. The overlap between procedures and charge lines — RULED 2026-09-09

**`visit_procedures` already exists, and `visit_charge_lines` is specified to hold the same
information.** The design wrote both because it assumed neither existed yet. Now one does, carrying
live seeded data, a partial unique index and a Phase 4 D-entry.

Three ways forward were put to the founder:

1. **Charge lines are derived from procedures at completion** — `visit_procedures` stays the doctor's
   record of what was done; completion snapshots each row into `visit_charge_lines` with its name and
   price frozen. Two tables, one direction, and the snapshot rule the project already applies to
   `quoted_price_minor`. Costs a copy.
2. **`visit_charge_lines` replaces `visit_procedures`** — one table, a migration that moves live rows,
   and D29 rewritten. Cheapest to read afterwards, most expensive to get wrong.
3. **`visit_procedures` gains the charge columns** — no new table; but then the doctor's clinical
   record and the clinic's billing record are one row, which is the mistake `payments` is currently
   an example of.

**The founder ruled option (1) on 2026-09-09**, which is what PR 4 now builds: `visit_procedures`
stays the doctor's record and completion snapshots each row into `visit_charge_lines`. Options 2 and
3 are closed. They are left written down because the next session to propose merging the two tables
will need to know the question was asked and answered.

---

## 3. Which rulings this phase carries

Five of the seven. **Rulings 6 and 7 are Phase 6**, not this phase: ruling 6 is the your-turn message
(a per-clinic setting, default OFF) and ruling 7 is the per-message-type retry policy, already
recorded in `PHASE-4.md` Q20 where Phase 6 will look for it. Neither is billing.

---

## 4. Estimates, and what they measure

**Stated in minutes, from Phase 4's measured times**, as instructed — and the measurement needs its
caveat stated with it or the numbers will be read as something they are not.

The figures are **merge-to-merge intervals within a continuous working run**, taken from Phase 4's
2026-09-08 and 2026-09-09 sequences:

| Shape of pull request | Phase 4 examples | Observed |
|---|---|---|
| Backend only, against a ruled design | 7b, 7e, 7h, 7i, 7j, PR 5 | **15–30 min** |
| One screen plus its backend | 7f, 7g, 7d, PR 1, PR 4 | **26–59 min** |
| Several items in one pull request | consultations + attachments + Playwright | **~115 min** |
| Anything including investigation before the first commit | 7a, 7l (with the Q47 dataset inspection) | **130–334 min** |

**What they exclude, and it is the whole constraint:** the founder's review time. Phase 4's own plan
recorded the same caveat about the same kind of figure — *"they measure build-and-verify against a
ruled design, not the review time that is the actual constraint."* A screen-carrying pull request
below may take 40 minutes to build and wait days to be looked at. **These numbers are not a schedule.**

A second exclusion worth naming: every figure above is for work whose design was already ruled. §2
is now ruled too, and it went to the option that carries no data migration, so these figures apply
to it.

---

## 5. The order

**1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12.** Amended 2026-09-09 by the founder: the patient
file number moves to PR 2 and everything after it shifts; staff accounts and the audit log viewer
join the phase after the desk.

**A note on the numbering, because the amendment crossed it.** The instruction referred to receipts
belonging in "PR 4" and "PR 8" — the numbers those pull requests carried *before* the file number
moved. The changes have been applied by identity rather than by number: receipts belong to the pull
request that turns `payments` into a receipt (now **PR 5**) and to the desk screens (now **PR 9**).
The numbering below is the one this document now uses throughout.

Schema before service before screens, as `CLAUDE.md` requires, with the insurance registry first
because the founder placed it there and because the payer split needs it.

---

### PR 1 — the insurance registry

**Delivers** what Phase 4's 7c was withdrawn to make room for: the company registry reception picks
from. **~45 min.**

Built on the existing `insurance_policies` model, extending rather than replacing it, with the legacy
free-text `insurerName` staying readable rather than migrated away.

- **Clinic admin:** an insurance companies list and form — name, type (insurer / TPA / corporate
  contract / government), contract number and dates, contact person, phone, email, claim submission
  method, payment terms in days, prior-approval required, active flag.
- **Reception:** a patient's policy names a company **from that list** — member number, plan, card
  expiry, primary or secondary. A patient may hold more than one.

**The two money fields — default coverage percentage and copay — are excluded**, as ruled. Not
deferred by omission: `schema.prisma` on `InsurancePolicy` says *"No money here… A percentage here
invites a service to multiply by it and store the result"*, and §4.2 of the design makes the payer
split manual **because** no coverage rate exists. Adding the fields here would make the split look
automatable while nothing computes it.

**Guard: a policy cannot name a company from another tenant, and the refusal is a 404 rather than a
403.** Proven by pointing a policy at a company in a second seeded clinic and watching the tenant
extension refuse it — then removing the scope and watching the test fail.

**Why first:** PR 7's payer split has no list to split against without it, and it is the one pull
request in this phase that touches no money.

---

### PR 2 — the patient file number

**Delivers** the item Phase 4 §4d carried into this phase. **Moved here by the founder 2026-09-09.**
**~30 min.**

Sequential per clinic. It is a numbering policy before it is a migration: where the sequence starts,
whether a number is ever reused, and whether it is printed on a card the patient keeps. Q45's
printed patient block currently prints a stable reference derived from the patient's UUID, which is
honest and is not what a receptionist reads down a phone.

**Why it moved to second.** It was ninth because receipts are where the number becomes load-bearing.
The reason for moving it ahead of the money work is stronger: **every charge, receipt and screen
built after this point would otherwise be built against the UUID-derived reference and changed
later.** A numbering scheme is cheapest to introduce before anything prints it.

**Guard: two patients registered concurrently in one clinic never receive the same number, and
numbers do not collide across clinics.** Proven with a concurrent insert, which is the only way this
particular bug appears — a sequential number generated by reading the maximum and adding one passes
every single-threaded test ever written.

---

### PR 3 — the charge tables, and the balance view

**Delivers** the schema C rests on. **~40 min.**

- `visit_charges` — total, discount, payer split, status. One per completed visit.
- `visit_charge_lines` — snapshot name, unit price, quantity, `source`
  (`CATALOGUE | AD_HOC | MATERIAL | ADJUSTMENT`). `needs_review` was dropped by R1, which removed the
  queue it fed; `ADJUSTMENT` replaced it, and is the only source a negative price is legal on.
- `chargeable_materials` — name (Arabic and English), unit, `price_minor`, `is_active`. Admin-priced,
  and deliberately **not** in `services`: a material has no duration and is not bookable, and putting
  it there pollutes the booking dropdown and gives the slot engine rows it must learn to ignore.
- `visit_charge_balances` — **a view, not a generated column.** Ruling 3, which amends D7 so the
  principle reads *database-computed* rather than specifically `GENERATED`. The reason is structural:
  the balance is a sum across payment rows, and `GENERATED ALWAYS … STORED` cannot express a
  cross-table aggregate.

**Guard: the balance cannot drift from its inputs, because nothing can write it.** Proven by
attempting an update against the view and watching Postgres refuse, and by inserting a payment
directly and watching the balance move with no application code involved. The contrast to record is
the one D7 exists for: application-side summation is what this forbids.

---

### PR 4 — completion writes the charge

**Delivers** B joined to C: completing a visit produces a charge with its lines. **~35 min.**

**Ruled 2026-09-09, closing §2: charge lines are snapshotted from `visit_procedures` at completion.**
`visit_procedures` remains the doctor's record of what was done; completion copies each row into
`visit_charge_lines` with its name and unit price frozen. The two other options — replacing
`visit_procedures`, or adding charge columns to it — are closed. The reason the ruling went this way
is that a snapshot is reversible and matches what the project already does with
`appointments.quoted_price_minor`, while merging the tables would put the doctor's clinical record
and the clinic's billing record in one row, which is precisely what `payments` is currently an
example of.

A line is never re-joined to `services.price_minor` afterwards. The moment an admin edits a price,
every prior charge would otherwise become retroactively wrong and unrecoverably so.

A procedure with no price is written at zero and **the invoice proceeds and settles anyway**. The
founder's reason is worth keeping in view: *"pushing the price to reception moves the guess to
someone who wasn't in the room."* Ruling 2's `needs_review` flag was withdrawn by R1 — the doctor
moves the total directly, as a signed line, and an admin reads it afterwards.

**Guard: a completed visit's charge line never changes when the service's price changes.** Proven by
completing a visit, editing the service price, re-reading the charge, and watching the line hold —
then re-joining the line to `services` and watching the test fail.

---

### PR 5 — `payments` becomes a receipt, with a receipt number

**Delivers** the split the design calls the largest change in the phase, plus receipt structure.
**~75 min.**

`service_price_minor`, `discount_amount_minor` and the amount-due concepts leave `payments` for
`visit_charges`; what stays is a money movement — patient, appointment, amount, method, status,
collector, timestamp, confirmation fields. Settlement attaches payments to charges.

**This is what makes `PHASE-4.md` Q19 expressible**: a payment can arrive before the invoice exists.
A receipt can precede a charge; an invoice row pretending to be a receipt cannot.

**Receipts — added by the founder 2026-09-09. Structure only.** Sequential and **gapless** numbering
per clinic, a receipt date, and the clinic's tax registration number printed on the document.
**No e-receipt integration yet** — the Egyptian Tax Authority's e-receipt system is not being
integrated in this phase, and nothing here should be shaped as though it were about to be.

*Gapless is a materially harder guarantee than unique, and it is the reason this pull request grew.*
A sequence is unique and **not** gapless: a rolled-back transaction consumes a value and leaves a
hole, which is exactly what a tax authority asks about. So the number is allocated inside the
transaction that writes the receipt, from a per-clinic counter row taken under a row lock — not from
a Postgres `SEQUENCE`.

**Migration rule, ruled by the founder:** **every existing `payments` row survives as a receipt**,
carrying its amount, its date and its method. **Nothing is dropped.** The rows that exist today were
written by a real clinic taking real money, and a migration that "cleans them up" is a migration that
loses them.

**Guards:**

- **Two concurrent receipts never share a number, and a failed transaction never burns one.** Proven
  twice over, because these are two different failures: concurrently, by issuing receipts from two
  connections and asserting the set of numbers has no duplicate; and for gaplessness, by forcing a
  transaction to roll back after allocation and asserting the next receipt takes the number the
  failed one would have had. A `SEQUENCE`-based implementation passes the first and fails the second,
  which is the contrast to record.
- **A pre-migration payment row is readable as a receipt after the migration**, with its amount, date
  and method intact. Proven by writing a row in the old shape, running the migration, and reading it
  back through the new path — not by counting rows, which would pass while every amount was zeroed.

**The `remaining_minor` generated column on `payments` is removed here**, and the D7 amendment is
what permits it. Removing it in the same pull request that moves the concept keeps the reason and the
change in one diff.

---

### PR 6 — discounts, with the ceiling as a constraint

**Delivers** ruling 4. **~30 min.**

Reception discounts up to a tenant-configured ceiling; owner and admin above it. The default ceiling
is **10% or 50 EGP, whichever is lower** — which, as the founder ruled when he read it back, is *two
settings and a `LEAST`, not one number*. So the tenant carries a nullable percentage and a nullable
minor-unit amount, and the effective ceiling is the lower of those that are set.

**The 50 EGP cannot be stored as EGP.** `CLAUDE.md` forbids a column named or formatted as a
currency; currency lives in `tenants.currency`. It is **5000 minor units applied as a default at
tenant creation in that tenant's own currency**, never a constant the discount check reads.

**Guard: the ceiling is a `CHECK` constraint, not a DTO rule** — ruled explicitly, and the
distinction is the one this project keeps relearning: a service-layer check passes on a machine where
the migration was never applied. Proven by writing an over-ceiling discount directly through the
client and watching Postgres reject it.

---

### PR 7 — the payer split, manual

**Delivers** §4.2. **~35 min.**

A covered patient's charge splits between patient and payer **by hand**, against the registry from
PR 1. Automatic splitting is **not** built, and the blocker is factual rather than preferential:
there is no coverage rate anywhere in the schema, and real Egyptian corporate and insurer policies
vary the rate by service, add annual ceilings and add per-visit co-payments. Building automation
against a rate nobody has entered would be building a guess.

**Guard: the two halves of a split always sum to the charge total, at the database.** Proven by
writing a split that does not and watching it refused.

---

### PR 8 — doctor pricing

**Withdrawn and replaced, 2026-09-11 (R1).** It was "the admin review queue": every `needs_review`
line listed for an admin to approve or correct.

**The queue is removed — no screen, no `needs_review`, no flow.** A doctor the clinic has allowed
(«يُسمح له بتعديل الأسعار», set by an admin on the doctor's own record) sees the visit total before
«إنهاء الزيارة» and may raise or lower it. The move is recorded as a **signed adjustment line on the
charge** — amount, optional reason, doctor, time — and **never** by editing a snapshotted line,
because a snapshot that can be edited is not a snapshot. Admin oversight is those lines appearing in
the payments screen (PR 9), which is a record of what happened rather than a list of things waiting
for someone.

**Guard: a doctor without the flag gets no control and a 403 on the route.** Proven by removing the
flag check and watching the refusal test fail — 10 passing before, 8 with the check and the doctor
scoping removed.

**Amended 2026-09-11: the permission gains an optional cap.** Percent of the visit, a flat amount, or
both, set on the doctor form; empty means unlimited, which is what every allowed doctor had until
now. The lower of the two binds, by the same `LEAST`-ignoring-nulls rule as the discount ceiling. The
cap is a **distance, not a direction** — a doctor allowed to vary a bill by 10% may reduce it or add
to it by that much.

**Guard: refused at the route and at the database.** The route returns a sentence naming the limit,
which a constraint cannot; a `BEFORE INSERT OR UPDATE` trigger on `visits` refuses the row however it
is written, which a service check cannot — it would pass on a machine where the migration never ran,
and never see the seed, direct SQL, or a future bulk import. A `CHECK` cannot express this: the cap
lives on `doctors` and the base is a sum over `visit_procedures`.

---

### PR 9 — «المدفوعات» and the desk

**Delivers** the screens reception actually works in: the day's money, a visit's charge, settlement,
part-payments, and the printed receipt. **~70 min. Waits for the founder's eyes.**

**R2, 2026-09-11 — one screen, read three ways, enforced at the route.** Reception gets the list
(today's charges and receipts, outstanding balances) and issues and collects from it; the desk opens
from a row. A doctor gets the same list narrowed to their own patients, and collects only when
«يحصّل المدفوعات بنفسه» is set on their record. An admin or owner reads it — day totals by method,
outstanding balances, doctors' adjustments, discounts above the ceiling — and **cannot collect**.
`payments.read` carries the screen, `payments.record` carries the act, and an admin holds only the
first. Above-ceiling authorisation (ruling 4) keeps its own route on `payments.adjust`, so an admin
can still allow a discount nobody else can without being able to take money.

**The founder's review of #99, 2026-09-11.** Six findings, all on this pull request:

- **Money is entered and shown in major units everywhere**, converted to minor units only on the
  wire, through one shared `MoneyInput`. The desk's boxes previously sent their own text through as
  minor units, so a receptionist typing `50` applied a discount of half a pound and nothing failed.
- **A negative amount is formatted as a negative number, never signed by hand.** `Intl` emits an LRM
  immediately before its own minus so the sign stays inside the number's left-to-right run; a `−`
  concatenated in front sits outside that run and detaches from the figure in an Arabic paragraph.
- The insurer share takes an amount **or** a percentage, which the screen converts; the section
  offers nothing at all when the patient has no policy.
- The collection box is **prefilled with the remaining balance**, editable downward, and more than
  the balance is refused by the server as well as by the button.
- **«طباعة الفاتورة»** prints the charge as a document — lines, discount, insurer share, paid,
  remaining — on the English letterhead, with the charge id as the invoice number and the patient's
  file number. Separate from the per-payment receipt, which keeps its own button and its own number.
- A doctor may complete **date of birth, sex and phone** from the visit header when the file is
  incomplete, through reception's own `PATCH /patients/:id`. Nothing else is reachable there.
- The sidebar highlights the section on nested routes too (`/visits/:id`, `/charges/:id`,
  `/patients/:id`), and every route the shell renders must map to a section or be listed as unmapped.

The receipt screen prints what PR 5 stores: the receipt number, the receipt date and the clinic's tax
registration number, on the letterhead. Printed documents are English (Q45), so this sheet follows
the same rules as the prescription and uses the same blocks.

Excluded from any standing merge authorization, like every screen-carrying pull request: opened, CI
green, handed over as `npm run preview -- --pr <n>`.

**Guard: reception can settle a charge and can see no clinical content while doing it.** The existing
`clinical-leak-guard.integration.spec.ts` sweep is extended to cover the new charge and receipt
endpoints — a charge line's snapshot name is a service name, not a diagnosis, and the sweep is what
keeps that true as the payload grows.

---

### PR 10 — «المستخدمون», the staff list

**Delivers** the tab that has carried a قريبًا badge since Phase 1. **~70 min.** *Carries a screen.*
Added to this phase by the founder 2026-09-09; **scope set by him 2026-09-11**, and it is larger
than the one sentence that stood here before.

> **Numbering — settled by the founder, 2026-09-11.** His earlier ruling named this "PR 11"; the
> plan has called it PR 10 since it was written, and PR 11 is the audit log viewer. His answer:
> **keep the plan’s numbering, and name the pull request by its content.** So this stays PR 10 and
> the branch is named for «المستخدمون» rather than for a number.

**Starts after #99 is approved**, by his instruction. Nothing here is built before that.

The list shows, per staff member: **name, phone, role, status, last login.**

- **Role is RECEPTIONIST or ADMIN, one per person.** Doctors are not created here — their record is
  a `Doctor` row hanging off a membership, which the Doctors tab owns.
- **Status is active or suspended, with suspend and reactivate. Never delete.** Medical and
  financial records are never hard-deleted (`CLAUDE.md`), and a staff row is the actor on every
  audit line they ever wrote.
- **Reset password**: a temporary password, **shown once**, and a forced change at next login.
- **Create user**: name, phone and role, producing a temporary password shown once.
- **Doctors appear read-only**, with a link across to the Doctors tab, so the list answers "who has
  an account here" without becoming a second place to edit a doctor.
- **Admin only.** The badge comes off — for work that lands, never for work that is merely deferred.

**Needs, and these are the reason for the estimate:** a `must_change_password` flag on `users`, a
temporary-password path that cannot be read back after it is shown, and a login that refuses to
proceed to the app until the change is made.

**Guard: a suspended account cannot authenticate, and suspension is not deletion.** Proven by
suspending and then attempting a login, and by asserting the membership and user rows survive — a
deleted staff account takes its audit trail's foreign key with it.

**Guard: a temporary password is single-use and unreadable afterwards.** Proven by reading the user
row back and finding no plaintext, and by logging in twice with it — the second attempt must refuse.

---

### PR 11 — the audit log viewer

**Delivers** a read-only view of who did what, when. **~40 min.** *Carries a screen.* Added to this
phase by the founder 2026-09-09.

Admin only, read-only, filterable by person, by date and by record. `audit_logs` already exists and
is append-only with a bound actor (D16); this builds nothing new underneath it.

**Guard: the viewer cannot write, and cannot read another tenant's rows.** Proven by attempting a
write through the same path and watching the append-only trigger refuse it, and by querying with a
second tenant's id and getting nothing rather than a 403.

---

### PR 12 — clinic credit

**Delivers** ruling 5. **~40 min.**

An abandoned pre-payment becomes clinic credit by default, refundable on request, never forfeited.
**Confirmed by the founder 2026-09-09**, so the check with the pilot doctor that ruling 5 carried is
closed. His reason for the default stands: forfeit is *"the kind of rule that ends up being overridden
manually every time — which means it isn't the rule."*

**Settled 2026-09-13**, the open question this section carried: a `patient_credits` **ledger**, not an
unallocated `payments` row. Partial application — 500 in, 200 spent now and 300 later — is three rows
and is inexpressible as one payment row; and attaching an existing receipt to a later charge would
rewrite what a printed, numbered document refers to.

**Credit is per clinic.** Ruled by the founder 2026-09-14, confirming what the schema already does:
`patient_credits` is tenant-scoped like every other financial table, so a balance earned at one
clinic cannot be spent at another. Patients are per clinic too, so there is no cross-clinic identity
for a shared balance to hang on, and a clinic cannot be made to honour money it never took.

**R-A, 2026-09-14 — overpayment at the desk is refused again**, reversing the desk half of ruling 5.
Credit arises only where refusal is impossible: a pre-payment larger than the final bill at
completion, a pre-paid appointment that is cancelled or abandoned, and a manual refund-with-reason
against the balance. A payment against an existing charge may not exceed its remaining balance
(`PAYMENT_EXCEEDS_BALANCE`, 422), and neither may credit applied to one — the same rule reached by
the other button, since both drive the same balance below zero. Apply-credit and refund stand.

---

### PR 13 — «المواعيد», the appointment book

**Delivers** the section that has carried a قريبًا badge since Phase 1. **~90 min.** *Carries a
screen.* **Decided by the founder 2026-09-11**, having held it open for a day: it was scoped here as
"not built yet — I am deciding", and this is the decision.

A **month calendar**. Each day shows its booking count **per doctor**. Clicking a day opens that
day's bookings — all doctors, or one — where a new booking can be made on that date, or an existing
one moved to another slot **through a dialog. No drag.**

**The same slot engine and the same double-booking guard as today**, which is the point rather than
an economy: the engine is pure, it already takes its reference instant as a parameter, and
`no_double_booking` already arbitrates every write. The book is a second way to reach them, not a
second implementation of them. A doctor sees their own days **read-only**. Badge off.

**Guard: a move goes through the state machine and the exclusion constraint, never a raw update.**
Proven from both ends — a raw `UPDATE ... SET scheduled_start` onto an occupied slot is refused by
the database, and a move of a COMPLETED appointment is refused by the state machine with a *valid*
token, so the refusal is the machine's rather than the token check's. The new time travels as a
signed slot token, so no screen ever names an instant.

**Why the drag was ruled out, recorded because it was considered:** a drag that reschedules a real
appointment needs a confirmation step, a keyboard path and a touch story on the iPad reception
actually uses. A dialog has all three by construction, and it is also the only shape that has
somewhere to put the refusal when the slot is taken between the screen drawing and the click.

---

### PR 14 — «تقارير المدفوعات», the payments reports

**Delivers** the reports the founder asked for on 2026-09-13, in his words: *"day/month totals by
method, outstanding balances, doctor adjustments, above-ceiling discounts, per doctor; read-only."*
**~50 min.** *Carries a screen.*

`ARCHITECTURE.md` §18 had cut a reports screen from the pilot; this reinstates a narrow one. It reads
from the invoices and receipts already in the system and adds no table, no column and no write path.

**`reports.financial`, which is NONE for reception and `own` for a doctor.** The capability registry
recorded the condition attached to building this, when it had no consumer: *"scope a DOCTOR's report
to their own data explicitly rather than relying on a WHERE clause that happens to be right, and test
the refusal."* The caller's own doctor row is resolved once and applied to every query **and every
total** — scoping the rows and not the totals hands a doctor the clinic's takings as a subtraction —
and the payload says which scope it is, so a doctor is told the figures are their own.

**Guard: a doctor's report contains none of a colleague's figures, in the rows or the totals.**
Proven by breaking it: with the doctor filter removed from the receipts query, the doctor's collected
total became the clinic's and the test failed.

**The outstanding balance is deliberately not period-bounded.** A debt does not expire because
somebody selected a quiet day, so the totals for a period sit beside a balance that is current.

---

## 6. What this phase deliberately does not contain

**Full inventory — and it is now its own phase after this one**, ruled 2026-09-09.
`PHASE-5-DESIGN.md` §5.2 prices it at roughly seven tenant-scoped tables, each with RLS policies,
audit triggers and seed data. What C needs from it is a description and a price, which is the
`MATERIAL` line in PR 3. The `source` discriminator is what lets that future phase subscribe to
completion and read material lines without data archaeology across live history.

**HR — attendance and payroll — stays Phase 7**, ruled 2026-09-09. PR 10 builds staff *accounts*,
which is access control and not employment: a login, a role and a deactivation switch. Nothing in it
records a shift worked or a salary paid, and the distinction is worth holding because the same screen
is where someone will later be tempted to put both.

**E-receipt integration.** PR 5 builds receipt *structure* — numbering, date, tax registration
number. Integration with the Egyptian Tax Authority is not in this phase and the structure should not
be shaped as though it were imminent.

**Claims.** Egyptian insurers offer a portal each plus paper; modelling a claim now builds an
integration nobody can use.

**Automatic coverage splitting.** See PR 7.

**Anything from the Egyptian drug dataset.** `PHASE-4.md` §4d: blocked on licensing, removed rather
than deferred.
