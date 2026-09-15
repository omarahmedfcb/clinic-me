# Phase 5 design — services, procedures, charges, and the edge of inventory

**What this document is.** A design, produced on 2026-09-03 before any code, in answer to a scope
change the founder raised: *"the invoice is built at COMPLETE, not at booking."* It holds the
reasoning, the schema findings the reasoning rests on, and the alternatives that were considered and
rejected — because a decision without its rejected alternatives gets re-litigated by the next
session that only sees the conclusion.

**What it is not.** It is not a status section. Nothing here records what is built; that is read from
`gh pr list` and `git log`, per `CLAUDE.md`. What is recorded here is decisions, open questions and
their arguments, which do not go stale when a branch merges.

**The design is ruled.** All seven decisions were ruled by the founder on
2026-09-03 and are recorded in section 7. Two of them were raised as questions in `docs/PHASE-4.md`
and their rulings are written there as well as here: **Q19** (payment can arrive before the invoice
exists) and **Q20** (`startConsultation` sends a WhatsApp message).

**The two items inside section A that were open when this document was first written are now ruled
too**, both on 2026-09-03: deactivating a service does nothing to appointments already booked
(section 2.3), and `CONSULTATION` stays in the enum with the seed gap fixed rather than the schema
(section 2.4). Nothing in this document is now awaiting a decision.

---

## 1. Four premise corrections

Each of these was assumed true when the scope change was framed. Each was checked against the
repository on 2026-09-03 and is not. They are first because three of the four change an answer.

### 1.1 `patient_due_minor` does not exist

Not on `payments`, not anywhere in the schema. The columns that exist on `payments` are
`service_price_minor`, `discount_amount_minor`, `amount_due_minor`, `amount_paid_minor`, and
`remaining_minor` — the last `GENERATED ALWAYS … STORED` per D7 and never written.

The name is worth recording rather than dismissing, because it is close to something real.
`prisma/schema.prisma:673` rules, in a comment on `insurance_policies`:

> **No money here.** No coverage percentage, ceiling or co-payment; those belong with the payer
> split on `payments`. A percentage here invites a service to multiply by it and store the result.

That payer split was designed, written down as a rule, and **never given columns**.
`patient_due_minor` is the name of a thing the design already intended and never built. Section 4.2
is where it gets built.

### 1.2 `Invoice` is already taken by SaaS subscription billing

`prisma/schema.prisma:1196` defines `Invoice` with `subscription_id`, `period_start`, `period_end`,
`overage_minor`, `eta_submission_id`, `eta_status`. That is clinic-OS billing *its own tenants* — the
subscription invoice the clinic receives from us, not the bill a patient receives from the clinic.

**A clinic-side invoice therefore cannot be called `Invoice` or `invoices`.** This is not a naming
preference. Two tables both meaning "invoice" in one schema is the kind of collision that produces a
correct-looking query against the wrong table, and the two have different tenancy semantics: one is
scoped to a tenant *as a customer of ours*, the other to a tenant *as a clinic*.

Names used throughout this document: **`visit_charges`** and **`visit_charge_lines`**.

### 1.3 `payments` has no application code at all

A search for `payment.create` across `src/` returns only Prisma's own generated client
documentation. The single real call site is `prisma/seed/seed-clinical.ts:234`.

So the money module is **schema-only**: tables, constraints, the D7 generated column, the
append-only `payment_adjustments` trigger — and no service, no controller, no DTO, no endpoint.

This matters for sizing. Section C is not "extend the payments module." It is "build the payments
module, and change its shape while building it."

### 1.4 Appointments carry no price snapshot

`appointments` has `service_id` and no price column. The only record of what an appointment costs is
a live join to `services.price_minor`, which is a mutable row.

Today nothing edits prices, so nothing has gone wrong. **Section A is precisely the feature that
starts editing them**, and on the day it ships, every past appointment's price silently becomes
whatever the service costs now. The old value is not recoverable, because it was never stored.

This is the one finding in this document that describes a live problem rather than a design choice,
and it is the argument in section 6.2 for pulling one column into Phase 4 regardless of how the
phasing is ruled.

---

## 2. A — services become clinic-managed

The clinic admin creates and prices services, rather than them arriving seeded.

### 2.1 Who can create and price

**Owner and admin only. Doctors none, reception none.**

Pricing is a commercial decision, not a clinical one. The doctor's pricing power is deliberately
confined to one bounded place — the ad-hoc line in section 3.2 — where it is flagged and reviewable.

**One capability, `services.manage`, not a create/price split.** A service without a price cannot be
booked or charged, so a role that may create but not price can only produce unusable rows. Splitting
the capability manufactures a state nobody wants.

### 2.2 What happens to appointments already booked when a price changes

**Two snapshots, not one, because they answer different questions.**

| Snapshot | Written | Means |
|---|---|---|
| `appointments.quoted_price_minor` | at booking | what reception **told the patient** |
| the charge line on `visit_charge_lines` | at COMPLETE | what the clinic **actually charged** |

They can differ, and the difference is the conversation that happens at the desk — *"you told me
three hundred."* Storing only the charge loses the clinic's own record of what was promised; storing
only the quote makes the invoice a fiction.

**The rule this implies, and it should be enforced rather than documented:** `services.price_minor`
is read **only to populate a new row**. No query for a past amount may join to it. A test-level guard
on that join is the mechanical form of this rule.

**A reschedule is a new row for this purpose — RULED 2026-09-03.** `rescheduleAppointment` rewrites
`service_id` from the new slot token, so it can move an appointment onto a different service and
therefore a different price; a quote left pointing at the service the appointment is no longer for
reads as a recorded fact and is a stale one. So the quote is re-taken on reschedule, **including when
the service is unchanged and only the price has moved since**.

The founder ratified this rather than corrected it, and asked for it to be written down so it is not
re-litigated: *"a reschedule is a desk conversation and the patient hears the current price."* The
alternative — preserving the original quote across a reschedule — was rejected because it would make
the stored quote disagree with what was actually said at the desk, which is the one thing this column
exists to record.

**Alternative rejected — versioning the service row** (a price-history table with effective dating,
and historical reads resolving against the date). Rejected because it answers *"what was this
service's price on 3 March"*, which nobody asks, at the cost of every price read becoming a temporal
join. The snapshot answers *"what did we charge this patient"*, which is the only question anyone
ever asks, and it answers it with a plain column read.

### 2.3 Deleted or deactivated

**Deactivated only.** `services.is_active` already exists, and the foreign key from
`appointments.service_id` makes deletion impossible without either orphaning history or cascading it
away — the latter forbidden outright by the never-hard-delete rule.

The live question is not delete-versus-deactivate; it is **what deactivation does to appointments
already in the diary.**

**RULED by the founder 2026-09-03: nothing.** In his words: *"deactivating a service does nothing to
appointments already booked. They keep their quoted price and are honoured. Warn 'N future
appointments use this service' and proceed. A clinic that stops offering something still has three
booked."* Future appointments booked on a now-inactive service keep their
snapshot and are honoured. Deactivation removes the service from the *booking* dropdown and from
nothing else. The UI warns *"N future appointments use this service"* and proceeds.

**Alternative rejected — refusing to deactivate while future appointments exist.** A clinic that
stops offering a service still has three of them booked next week and will still perform them.
Refusal makes the system disagree with the building, and the workaround is renaming the service to
"DO NOT USE", which is worse than either.

### 2.4 A consequence worth catching now — RULED 2026-09-03: the enum is fine, the seed is not

`ServiceType` is `NEW | CONSULTATION | FOLLOW_UP | PROCEDURE`, and **`CONSULTATION` is used by zero
seeded services** — a finding carried over from Phase 3. While services were seeded, a dead enum
value was invisible. Once an admin picks a type from a dropdown it is a user-facing choice, and one
of four options meaning nothing is a support question.

**The founder's ruling, and it corrects where the fault was placed:** *"CONSULTATION stays in the
enum. The seed not using it is a seed gap, not a schema one. Add a seeded service that uses it so the
dropdown isn't showing an option nothing exercises."*

That is the right diagnosis and worth recording as a general one: **an enum value with no rows is
evidence about the seed before it is evidence about the schema.** The original framing — "the enum
needs a review" — assumed the value was wrong because nothing used it, which is the same inference
that would delete a legitimate value the seed simply never exercised. The check that distinguishes
them is whether the value is meaningful to a clinic, not whether a fixture happens to contain one.

---

## 3. B — procedures recorded at COMPLETE

The doctor completes a visit and records what was actually done: items from the clinic's list, plus
ad-hoc ones. Normal in dentistry, aesthetics and surgery.

### 3.1 Does an ad-hoc procedure become a reusable service

**One-off by default, promotable by an admin.**

If ad-hoc entries silently become services, the catalogue accumulates typos, singular one-time
entries, and three spellings of the same procedure within weeks — the standard failure of any free
text field that writes into a controlled list. If they never can, the doctor retypes the same item
forty times and the catalogue never learns.

So: the line is one-off; **autocomplete draws from this clinic's own past ad-hoc lines**; and an
admin screen shows *"recorded ad-hoc 12 times"* with a promote action.

The autocomplete mechanism is **the one already ruled in `PHASE-4.md` Q8 for prescription items** —
free text with autocomplete from this clinic's own history. It is reused, not reinvented. A second
autocomplete with different semantics in the same product is two things to maintain and two
behaviours for the doctor to learn.

### 3.2 Can the doctor price an ad-hoc item

**Ruled by the founder on 2026-09-03: yes, and the line is provisional until reviewed.** His reason:
*"pushing the price to reception moves the guess to someone who wasn't in the room."* The argument
below is what he was agreeing with.

Requiring admin approval *before* the invoice exists blocks the patient at the desk, waiting for
someone who is frequently not in the building. That is unusable in a clinic and will be routed around
within a week.

So: the doctor enters a price; the line carries `needs_review`; **the invoice is still produced and
settled**; the admin gets a queue of doctor-priced lines to confirm or adjust afterwards, using the
correction mechanism of section 4.3.

**Alternative, tighter, available if the founder prefers it:** doctors may only select catalogue
items, and ad-hoc lines are priced by reception before the invoice closes. Rejected as the
recommendation because it moves the pricing decision to the person who was **not in the room** and
does not know what was done — reception's price is a guess with more authority than the doctor's.

### 3.3 When the procedures do not match the booked service

This is the normal case, and it is the design telling us something rather than an exception to
handle.

**`appointments.service_id` is currently doing two jobs**: *how long does this take and where does it
fit in the diary*, and *what does this cost*. Those two were the same thing only for as long as one
appointment meant one service. B breaks the pairing permanently.

**The resolution, stated as a rule:**

> The appointment's service determines **duration and slot placement, and nothing else once the visit
> is COMPLETE.** The charge is the set of lines recorded at COMPLETE. **If no lines are recorded, the
> booked service becomes the single default line.**

The last clause is what keeps the common case free: a plain consultation with nothing added produces
a correct invoice with zero extra clicks. Any design where the ordinary visit requires the doctor to
re-enter what was already booked will be worked around by not completing visits.

Note the second-order effect: the slot engine keeps reading `services.duration_minutes` and
`buffer_minutes` and is entirely unaffected by any of this. The purity rule on
`modules/appointments/domain/` is not touched.

---

## 4. C — invoice generated at COMPLETE, with settlement

### 4.1 Which existing columns carry the offset, and the shape that replaces them

The premise correction in section 1.1 applies: the named column does not exist. But the deeper answer
is that **no column reshuffle solves this**, because the problem is not a name.

**`payments` today is one row that is simultaneously the invoice and the receipt.** It carries
`service_price_minor` and `discount_amount_minor` (invoice concepts) alongside `method`, `paid_at`,
`collected_by_user_id` and the confirmation fields (receipt concepts). One such row cannot represent
three procedures, and it cannot represent two part-payments taken in cash and then by Instapay.

**Three tables:**

| Table | Holds | One per |
|---|---|---|
| `visit_charges` | total, discount, payer split, status | completed visit |
| `visit_charge_lines` | snapshot name, unit price, qty, `source`, `needs_review` | procedure or material |
| `payments` | amount, method, status, who took it, when | money movement |

`payments` becomes a **receipt**: patient, appointment, amount, method, status, collector, timestamp,
confirmation fields. Price, discount and amount-due leave it for `visit_charges`. This is also
exactly what makes `PHASE-4.md` Q19's ordering expressible — a receipt can exist before a charge
does; an invoice row pretending to be a receipt cannot.

`visit_charge_lines.source` is an enum: `CATALOGUE | AD_HOC | MATERIAL`. Its purpose is section 5.

**Ruled by the founder on 2026-09-03: the view — and D7 itself is amended** so that the reason
survives, in his words, *"so nobody 'restores' the column later."* `SCHEMA-DECISIONS.md` D7 now
carries an `Amended 2026-09-03` section stating that the principle is *database-computed*, not
specifically `GENERATED`. The argument he ruled on: `remaining` becomes a property
of the charge, and it is a **sum across payment rows**. A `GENERATED ALWAYS … STORED` column cannot
express a cross-table aggregate. The options:

- **A view, `visit_charge_balances`** — recommended. D7's intent is *never recompute derived money in
  application code*, and a view honours that intent exactly while being structurally incapable of
  drifting from its inputs.
- **A stored column maintained by a trigger** — matches D7's letter (a column, not a query) but
  reintroduces the drift D7 exists to prevent, since a trigger can be bypassed by a bulk operation.
- **Application-side summation** — rejected outright; it is the thing D7 forbids.

The recommendation is the view. It is recorded as an open decision because D7 says "generated column"
in as many words, and quietly reinterpreting a numbered schema decision is how a rule stops meaning
what it says.

### 4.2 Insurance: does a covered patient's invoice split automatically

**Manual split in Phase 5. Automatic not until real policies have been seen.**

**Confirmed 2026-09-08:** a default coverage percentage and copay were proposed for the Phase 4
insurance registry and ruled to wait for Phase 5 — so the registry ships here, in the first PR of
this phase, carrying every field except those two.

The blocker is factual rather than preferential: **there is no coverage rate anywhere in the schema.**
`insurance_policies` carries insurer name, policy number, policyholder name, `valid_from` and
`valid_to` — and the comment at `schema.prisma:673` quoted in section 1.1 says the absence is
deliberate, with the payer split belonging on the payment side.

Automatic splitting needs a coverage rate that varies **by service**, plus annual ceilings and
per-visit co-payments. Real Egyptian corporate and insurer policies do all three, and they differ
between insurers and between employer schemes with the same insurer. Modelling that before seeing a
few hundred real ones is guessing at a structure that is expensive to change once live clinic data
depends on it.

**The design:** `visit_charges.patient_share_minor` and `visit_charges.insurer_share_minor`, entered
by reception, defaulting to the whole amount on the patient. The desk gets the number it needs today,
and the clinic accumulates the evidence that says whether policies are regular enough to automate.
Claim submission stays Phase 6 or later — `ARCHITECTURE.md` already lists insurance claims as out of
scope.

This is the standing pattern for an unknown that is not ours to resolve: record it as an open
question and design so that either answer is a configuration change rather than a migration.

### 4.3 The doctor corrects the procedures an hour later

**The founder's position — a documented credit or addition, never a silent edit of a closed invoice —
is already the schema's position, and the enforcement already exists.**

`payment_adjustments` (`schema.prisma:951`) carries `adjustment_type`, `amount_minor`, a **`NOT NULL`
`reason`**, `actor_user_id`, `previous_status` and `new_status`; and
`prisma/sql/01-constraints.sql:143` installs an append-only trigger on it. A silent edit is not
discouraged by convention — the database rejects the operation.

**Extend the same shape to charges**: a closed `visit_charge` is never updated. A correction writes an
adjustment row referencing it, and a corrected line writes a new line that supersedes rather than
overwrites.

**One addition, and it runs against a common instinct: do not put a time window on corrections.** A
correction at ten minutes and one at ten days are the same act, and a window only teaches staff to
rush the first and telephone the admin about the second. The control that matters is the audit record
— who, when, why, and against which closed charge — not the clock.

### 4.4 Discounts

**Who:** reception up to a **tenant-configured ceiling**; owner and admin above it. **Ruled
2026-09-03, with the default set: 10% or 50 EGP, whichever is lower.**

Note what the ruling does to the shape: the question offered *an amount or a percentage* and the
answer is **both, taking the lower**. So the configuration is two nullable values and the effective
ceiling is the lower of those set — the percentage keeps the ceiling proportionate on a large
invoice, and the flat amount stops 10% of a very large invoice from becoming a discount nobody meant
to authorise. And "50 EGP" is stored as 5000 minor units applied at tenant creation in the tenant's
own currency, never as an EGP constant read by the check: `CLAUDE.md` puts currency on `tenants`, and
a hardcoded default is wrong rather than merely unconverted the day a non-EGP tenant exists.

**Alternative rejected — admin-only discounts.** This is the rule that gets worked around at 6pm when
no admin is present, and the founder's own framing is the argument: *"if it isn't in the system it
happens outside it."* A discount taken outside the system is a cash difference nobody can explain
later. A ceiling that covers the daily "round it down to 500" case and escalates the rest keeps the
common event inside the system and the unusual one under review.

The ceiling is **tenant configuration**, not a constant in code — clinics differ, and a code change
per clinic is not a product.

**Is a reason mandatory: yes, and in the database.** `payments.discount_reason` exists today and is
**nullable**. Under the charge design the discount moves to `visit_charges`, and the reason should
carry a check constraint of the form `discount_amount_minor = 0 OR discount_reason IS NOT NULL`.

A required field enforced only by a DTO is a convention. The standing principle in this project is
that an invariant held up only by application code is unenforced, and belongs in the hardest layer
that can reject it.

**And the discount is a line with its own actor and reason, not a mutated total**, so that *"who took
two hundred off this invoice"* is answerable a month later without reading an audit log.

---

## 5. D — stock consumption, and where the line is drawn

### 5.1 The minimum version that serves C

**The founder's instinct is right and is adopted: the doctor adds a chargeable material as a line item
with a price, and no stock is decremented.**

The invoice needs a **description** and a **price**. Neither requires knowing how many are left on the
shelf. Inventory answers a different question — *when do I reorder, and who took three boxes* — which
no part of C consumes.

**One addition, at a cost of one column:** the `source` discriminator on `visit_charge_lines`
(`CATALOGUE | AD_HOC | MATERIAL`). `ARCHITECTURE.md` section 19 already specifies inventory's seam as
a new module that *"consumes `services` and `visits` via events, no schema coupling"*. With the
discriminator, a future inventory module subscribes to `VisitCompleted` and reads the material lines.
Without it, material lines are indistinguishable from procedure lines, and inventory's first task
becomes data archaeology across live clinic history.

**One control point:** section 3.2's doctor-pricing should **not** extend to materials. Materials are
where over-charging is least visible to the patient, and unlike a procedure, a material has an
objective cost the clinic already knows. Materials come from a small admin-priced table — name
(Arabic and English), unit, `price_minor`, `is_active`.

**Not `services`.** A material has no duration and is not bookable; adding it to `services` pollutes
the booking dropdown and gives the slot engine rows it must learn to ignore. A separate small
`chargeable_materials` table is fewer moving parts than an `is_bookable` flag threaded through every
existing booking query.

### 5.2 What full inventory would cost, stated explicitly

**Schema — roughly seven tenant-scoped tables**, each requiring RLS policies, audit triggers and seed
data: `stock_items`, `stock_batches` (expiry and lot number are not optional for medical
consumables), `stock_movements` (an append-only ledger), `suppliers`, `purchase_orders`,
`stock_counts` with variance rows, and `stock_locations` once there is more than one room.

**The hard parts are not the schema:**

- **Negative stock policy.** The shelf says zero and the doctor used one. Block the invoice, or allow
  and flag? Blocking makes clinical reality wait for data entry.
- **Unit conversion.** A box of 100 gloves, a single glove, a 5ml vial drawn twice.
- **Wastage and breakage**, which are consumption with no charge attached.
- **Expiry alerts**, which are the main reason a clinic would want this at all.
- **Reconciliation** — the periodic count where the system says 40 and the shelf has 37, and a human
  must resolve a discrepancy the system cannot explain.

**The real cost is operational, not engineering.** An inventory is only correct if **every**
consumption is recorded, including the many that are never billed. A clinic that records materials
only when charging for them has an inventory that is permanently and unpredictably wrong. Staff stop
trusting it within a month, and it becomes a second paper system running beside the one this product
exists to remove — which is a worse outcome than not having it.

**Rough size:** three to four weeks of build, plus a permanent daily discipline burden on the clinic,
against roughly two days for the line item. `ARCHITECTURE.md` lists inventory as out of scope and that
should stand.

---

## 6. Phasing — the disagreement, and how it was resolved

**The founder's original read:** A and B in Phase 4, C in Phase 5 with payments, D later or never.

**This design's position:** **A in Phase 4. B *and* C together in Phase 5. D's line item inside C.
Full inventory unscheduled.**

**Ruled 2026-09-03 in favour of the design**, in the founder's words: *"You're right, I was wrong. B
and C are one feature and splitting them means writing charge lines into a table nothing reads. Phase
4 gets A plus `quoted_price_minor`; Phase 5 gets B and C together with D's line item."* The argument
that persuaded him is 6.1 below and it is left standing rather than summarised, because the next
session to propose splitting B from C will need it.

### 6.1 The argument against B in Phase 4

**B cannot be built before C's tables exist, because B's output *is* charge lines.**

Putting B in Phase 4 leaves two possibilities and both are bad:

1. Procedures are written into a table that nothing reads, because the invoice that would read it is
   a phase away. Untested against its actual use — which is the exact shape of the
   `appointments.queueActions` capability that sat wired to nothing until a founder review found it.
2. `visit_charges` and `visit_charge_lines` get built in Phase 4 after all, which is moving C forward
   while calling it something else, and it lands the largest schema change of the project in the
   phase whose Definition of Done is about a clinical screen.

B and C are one feature with two halves — the half that records what was done and the half that bills
for it. Splitting them across a phase boundary buys no earlier value and costs a schema revision.

A genuinely does belong in Phase 4: it is a CRUD screen, it unblocks everything downstream, and it
closes the section 1.4 problem before that problem can produce wrong history.

### 6.2 One column that should move regardless of the ruling

**`appointments.quoted_price_minor` belongs in Phase 4 whichever way the phasing goes.** One column
and one write at booking.

Every day without it is a day of appointments whose price is a live join to a mutable row. That is
harmless only while nobody edits prices — and **A is the feature that starts editing them.** The
moment an admin changes a price, every prior appointment's price becomes retroactively wrong, and it
is unrecoverable, because the previous value was never written anywhere.

### 6.3 A scope reality worth naming before the phase is planned

Given section 1.3 — `payments` has no application code — Phase 5 as now scoped is: charges, lines,
settlement against prior payments, discounts with ceilings, the payer split, adjustments, and the desk
screens for all of it.

**That is the largest phase in the project, larger than Phase 3.** It is better to decide that with
the number in view than to discover it in week three.

**Endorsed by the founder on 2026-09-03 as an instruction for when Phase 5 is scoped:** *"your point
about Phase 5 being the largest phase in the project is worth saying out loud now rather than
discovering in week three. When we scope it, scope it honestly."* Recorded here rather than in a
status section, because it is a ruling about how the phase document gets written and it does not go
stale.

---

## 7. The seven decisions — all ruled by the founder on 2026-09-03

Every decision in this document is ruled. Each row states what was decided and, where the reason
changes how it must be built, why.

**A naming note that is load-bearing.** In conversation these were numbered D1–D7.
**They are written here as Rulings 1–7 deliberately**, because `docs/SCHEMA-DECISIONS.md` already
carries a numbered **D7** — derived money — and *ruling 3 amends that very decision*. Two different
things called D7, one of which changes the other, is exactly the collision that produces a confident
wrong reading six weeks later.

| # | Decision | Ruling |
|---|---|---|
| 1 | **Phasing** | **Phase 4 takes A plus `quoted_price_minor`. Phase 5 takes B and C together, with D's line item.** The founder's words: *"You're right, I was wrong. B and C are one feature and splitting them means writing charge lines into a table nothing reads."* |
| 2 | **Ad-hoc pricing control** | **The doctor prices the line; it carries `needs_review`; the invoice proceeds and settles.** Admin gets a review queue. His reason: *"pushing the price to reception moves the guess to someone who wasn't in the room."* |
| 3 | **D7 and the charge balance** | **A view, not a generated column** — and `SCHEMA-DECISIONS.md` D7 is **amended** to say the principle is *database-computed*, not specifically `GENERATED`, with the reason recorded so nobody restores the column later. Done: D7 now carries an `Amended 2026-09-03` section |
| 4 | **Discount ceiling** | **Reception up to a tenant-configured ceiling; owner and admin above it.** Default ceiling **10% or 50 EGP, whichever is lower**. The reason is mandatory **as a `CHECK` constraint, not a DTO rule** |
| 5 | **Abandoned pre-payment** | **Clinic credit by default, refundable on request, never forfeit** — and **to be confirmed with the pilot doctor**, below |
| 6 | **Your-turn message** | **A per-clinic setting, default OFF** |
| 7 | **Retry policy** | **Per message type, not one global policy.** Recorded in `docs/PHASE-4.md` Q20, where Phase 6 will look for it |

### Ruling 4 has two consequences that are not obvious from the sentence — both confirmed by the founder 2026-09-03

He read both back and ruled them in: *"you're right that '10% or 50 EGP, whichever is lower' is two
settings and a LEAST, not one number. And the currency point is right: 5000 minor units in the
tenant's own currency, never a hardcoded EGP default."* So neither paragraph below is analysis
awaiting a decision; both are the decision.

**"10% or 50 EGP, whichever is lower" is two settings and a `LEAST`, not one number.** The design
above offered *an amount or a percentage*; the ruling is *both, taking the lower*. So the tenant
configuration carries two nullable values — a percentage and a minor-unit amount — and the effective
ceiling for a given charge is the lower of those that are set. That is a better rule than either
alone: the percentage keeps the ceiling proportionate on a large invoice, and the flat amount stops a
percentage of a very large invoice from becoming a discount nobody intended to authorise.

**"50 EGP" cannot be stored as EGP, and this is a real constraint rather than pedantry.** `CLAUDE.md`
forbids a column named or formatted as EGP; currency lives in `tenants.currency`. So the *default* is
5000 minor units, correct for an Egyptian tenant and meaningless for any other — and the moment a
non-EGP tenant exists, that default is wrong rather than merely unconverted. It is recorded as a
default applied at tenant creation in the tenant's own currency, not as a constant the discount check
reads.

### Ruling 5 is ruled and still goes to the pilot doctor

The founder ruled clinic credit and then said: *"But ask the pilot doctor. This is a business-practice
question and he'll answer it in one sentence."*

Both halves stand. The ruling is what gets built, so nothing is blocked; the question is a check on
whether the ruling matches what an Egyptian outpatient clinic actually does at the desk. His argument
for credit is that forfeit-by-default is *"the kind of rule that ends up being overridden manually
every time — which means it isn't the rule"*, and that credit is what actually happens: the patient
rebooks and it is applied.

**What that implies for the schema, and it should be settled before C is built:** clinic credit is a
patient-level balance that outlives the appointment it came from. It is not a property of the
abandoned appointment, because it is consumed by a different one. Whether that is a `patient_credits`
ledger or an unallocated `payments` row that later attaches to a charge is a design question this
document has not answered, and it belongs with C.

### Ruling 6, and what it protects

Default OFF, the clinic switches it on, and the pricing page states what it costs. The founder's
reason: a message that cannot bundle, is time-critical, and lands **+29% per visit on the thinnest
tier** is not something to switch on for everyone by default — *"a clinic with a waiting room where
everyone can hear their name called gains nothing from it."*

The consequence for `PRICING.md` is the point: **0.25 survives honestly as a blended average across
clinics**, which is what it always claimed to be. Had the message been always-on, 0.25 would have
been a figure the product itself contradicted.

### Ruling 7 — retry policy, per message type

| Message type | Policy | Why |
|---|---|---|
| **Your-turn** | **One retry within 60 seconds, then stop and surface to reception** | Late is worse than absent. A your-turn message arriving four minutes on is worse than none, because the patient has already been called or has already missed the turn |
| **Reminders and follow-ups** | **Retry hard** | Not time-critical |
| **Prescription and payment links** | **Retry hard** | Not time-critical |

Recorded in `docs/PHASE-4.md` Q20 so that Phase 6 builds a per-type policy rather than discovering
the distinction after building one global one.
---

## 7b. Carried into Phase 5 by ruling, and not part of this design

**A week or month calendar for reception — added 2026-09-03**, after the founder reversed his own
same-day deferral of it. His reason is the requirement: *"a patient calls asking 'when is my
appointment next week' and the day view makes that a hunt."*

It is recorded here rather than designed here, because nothing about it has been designed. What is
settled is only that it is Phase 5 scope and that the question it must answer is a **range** query —
"this patient's appointments over the next fortnight" — which is precisely what a day view cannot
answer at a cost the person on the telephone will wait for.

Two notes for whoever scopes it, both facts rather than opinions:

- **`ARCHITECTURE.md` §18 cut it, and that row is now struck** with the reversal recorded beside it.
  Its original reason — *"reception works one day at a time"* — is the belief that was overturned.
- **The slot engine is untouched by it.** `modules/appointments/domain/` already computes a day at a
  time from pure inputs, and a week view is a different arrangement of the same reads, not a new
  engine. Anything that pushes I/O into that directory to serve a calendar is the wrong design, per
  the purity rule in `CLAUDE.md`.

This does **not** reopen ruling 1's phasing. Phase 5 was already the largest phase in the project —
section 6.3 — and this makes it larger, which is an argument for scoping it honestly rather than an
argument against the ruling.

### 7b.i Scoped into Phase 5 on 2026-09-05, with costings

Five items, each costed before being placed. **Nothing here is designed** — the sizes are the
estimate the ruling was made on, and they are recorded so the next scoping session starts from a
number rather than a guess.

| Item | Size | What makes it that size |
|---|---|---|
| **Staff list and staff management** | **1–2 weeks** | Not the listing. `GET /memberships` shipped on 2026-09-05 and took half a day. The cost is **creating a user**, and the decisive fact is that *nothing in this API creates one* — `auth.controller.ts` has login, refresh, logout, switch-tenant and me, and every user in the product exists because the seed wrote it. Creation needs password-setting or invitations, mail delivery (which does not exist), token expiry, a first-login flow, and a ruling on whether staff self-serve |
| **Audit log viewer** | **~3 days** | The data is complete and unread: 5,543 rows, 15 entity types, 3 actions in the review database, and `auditLog.read` has been OWNER/ADMIN in the matrix since Phase 1 with no consumer. The work is making a JSON `previous_state`/`new_state` diff legible, not fetching it. The founder's reason for wanting it: *"the clinic owner has a right to see who changed what"* |
| **Clinic settings: licence expiry** | part of ~3–4 days | New. `tenants` has no column; there is a `settings` JSON that `ARCHITECTURE.md` §18 already treats as operator-edited |
| **Clinic settings: taxes** | part of the same | New, and needs a ruling of its own before it is built — a tax rate that reaches an invoice line is a money rule, not a preference |
| **Clinic settings: available specialties** | part of the same | `doctors.specialty` is free text today. A clinic-level list would constrain it, which is a schema question as much as a screen |

**Working hours are deliberately absent from that table.** Proposed and rejected on 2026-09-05, in
the founder's words: *"a clinic-level default that sits beside `schedule_templates` is a second
source of truth for the thing that decides bookings, and we've spent two weeks eliminating exactly
that shape."* `schedule_templates` is per-doctor, carries validity windows and breaks, and is what
the slot engine reads. If a clinic-level default is ever wanted it must **generate** doctor
templates rather than sit beside them.

### 7b.iv Step 2 of the permission-gating fix — RULED AND SCHEDULED, 2026-09-06

**Ruled into Phase 5 rather than argued again.** The founder: *"Step 2 — moving the gate from the
screen to the action — I'm deferring, not rejecting. It's the better fix and I want it, but it's
cross-cutting machinery landing in the middle of Phase 4, and Phase 5 is already the largest phase
in the project."* Recorded here with its reasoning intact so that nobody re-derives the argument or
re-opens the decision; what remains for Phase 5 is scheduling and design, not whether.

**The defect class.** A screen's knowledge of what it may do is written by hand in three places that
nothing compares: the nav item's capability, the button's `me.permissions[...]` check, and the
route's `@RequirePermission`. Both directions of disagreement are silent — a wrongly hidden section
produces no error at all, and a wrongly shown button produces one only when somebody clicks it. Four
screens had been patched one at a time before the pattern was addressed as a pattern: the transfer
panel, the complete button, the queue's action buttons, and on 2026-09-06 the owner's queue link
(hidden by a capability the owner had just lost) together with a queue fetch of a route the owner may
not read, which took the whole board down.

**Step 1 shipped on 2026-09-06** — `apps/api/scripts/route-capabilities.ts` and
`test/unit/route-capability-manifest.spec.ts`. It derives a route→capability manifest from the API's
controllers and asserts the client against it: every `authFetch` call must hit a route that exists,
every capability string in `apps/web` must be in the matrix, and every nav item must be gated on a
capability that a route behind that screen actually requires. `npm run routes` prints the table.

**What step 1 deliberately does not catch, and why step 2 exists.** It cannot see a screen
*fetching* something it may not read — the queue-board bug — because that is a property of a call,
and the capability is still attached to the screen. Nor can it see an action rendered with no gate
at all, because there is nothing to compare an absent check against. Both are questions about a
*call site*, and answering them means the capability has to live on the call:

- every mutating client function is declared as `mutation(capability, fn)`, so a call carries what
  it needs
- `<ActionButton action={checkIn}>` renders nothing when the session lacks that capability, so a
  screen cannot offer an action by forgetting to ask
- a load path skips the reads the caller may not make, rather than issuing them and handling a 403

**Cost when it lands: 1–2 days**, on top of step 1, and it touches every `*-api.ts` module and every
screen that renders an action — which is why it is not a Phase 4 change. The manifest from step 1 is
what makes it mechanical rather than a judgement call per call site: the capability each declaration
should carry is already computed.

### 7b.ii Deferred past Phase 5 on 2026-09-05

- **The clinic-facing renewal view** — "renew my subscription". Ruled **Phase 6, after billing is
  decided**, and explicitly *not* the super-admin console: that console serves us, this serves the
  clinic, and conflating them was the confusion the ruling resolved. ~3–4 days once there is an
  answer to who takes payment and how.
- **Data export** — "what do I take if I leave". Ruled **Phase 6**, ~1 week. See the open question
  below, which must be answered before it is scoped.

**"Where is my data" needs no build at all.** `docs/DEPLOY.md` already documents the nightly
`pg_dump` and the attachments tar, including the ordering rule between them. That half of the
question is a sales answer, not a feature.

### 7b.v OPEN ITEM — automated backups with a tested restore, before invoicing data reaches a clinic

Added 2026-09-06 by the founder, as a **prerequisite** rather than a task in the list above:
automated Postgres backups with a *tested restore* must be in place before invoicing data goes to a
real clinic.

**Why it attaches to this phase specifically.** Phase 5 is where money enters the database.
Appointments and even clinical notes can, at a push, be reconstructed from a paper day-book and a
doctor's memory; a ledger of what a patient was charged, what they paid, and what a clinic owes an
insurer cannot. It is also the data a clinic is legally obliged to keep and the data an owner will
ask about first. Losing a week of it is not a degraded service, it is a business that cannot invoice.

**"Tested restore" is the load-bearing half of the sentence**, and this project has already met the
failure: `docs/DEPLOY.md` records a restore drill that returned **zero patients while reporting
mostly-success**. A backup nobody has restored is a belief, not a backup — the same shape as a seed
command that reported success and seeded nothing, and a `--dry-run` that passed on exactly the
lockfile CI then rejected.

**What exists today, so the gap is precise rather than alarming.** `docs/DEPLOY.md` documents the
nightly `pg_dump`, the attachments tar, and the ordering rule between them, and a restore drill has
been run by hand at least once. What does not exist: anything that runs it on a schedule without a
person, anything that verifies the dump is loadable rather than merely present, and any alert when a
night is missed. Silence is what a broken backup sounds like.

**Not scoped or costed here.** It is recorded as the prerequisite it is, so that the first invoicing
milestone cannot quietly pass it. Scoping it needs a ruling on retention, on where the copies live —
a second machine is not a backup if it is the same machine — and on whether attachments and database
must be restorable to the same instant.

### 7b.iii OPEN QUESTION — does an export include clinical content?

Raised and left open by the founder on 2026-09-05: *"yes it needs a ruling on clinical content.
Note it as an open question rather than assuming."*

The question is not whether the clinic owns the data — they do. It is that **an export is the one
operation that hands `visits.readContent` material to somebody who does not hold that capability**,
because the person who clicks it is an owner or an admin, and both are `NONE` for it by ruling. An
export containing diagnoses would route around the §8 boundary through a file, and the boundary
would still look intact in every endpoint.

Three shapes, none chosen:

1. **Administrative only** — patients, appointments, payments, visit *metadata*. Consistent with §8
   with no new rule, and arguably not what a departing clinic means by "my data".
2. **Everything, doctor-triggered** — the export requires `visits.readContent`, so a doctor runs it.
   Keeps the boundary, and makes the owner ask a doctor for their own clinic's records.
3. **Everything, owner-triggered, audited** — the boundary is relaxed deliberately for this one
   operation, with a `READ_SENSITIVE`-style row per export. Honest about what is happening, and it
   is a new hole that has to be watched rather than one the type system closes.

Whoever scopes this should also decide whether attachment **files** are in scope, which changes it
from a database query into a packaging job.

---

## 8. Where the rest of this lives

- **`docs/PHASE-4.md` Q19** — payments can be recorded against an appointment at any time, and
  COMPLETE produces the charge that settles against them. Why `amount_due_minor` means nothing before
  an invoice exists, and why it must therefore leave `payments`.
- **`docs/PHASE-4.md` Q20** — `startConsultation` sends an outbound patient message. The queued-intent
  design, why the transition must not be blocked by a failed send, why the failure must reach
  reception rather than a log, why retry policy is per message type, and the confirmed but under-rated
  line in `PRICING.md`.
- **`docs/SCHEMA-DECISIONS.md`** — D7 (derived money) and D5 (append-only tables). Both are
  load-bearing here and neither is changed by this document.
- **`docs/ARCHITECTURE.md`** section 19 — the inventory seam this design deliberately leaves intact.
