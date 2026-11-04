# Clinic branches — design

A clinic becomes a container of one or more branches, and every operational record is stamped with
the branch it happened in. A single-branch clinic sees no change. Sections 1 and 2 are the schema and
the backfill as migrated by `20261027100000_branches`; sections 3–8 are the design the later steps
build. Status is read from `gh pr list` and `git log`, not from here.

## 0. What the code said before anything was designed

| # | Assumed | The code had | Consequence |
|---|---|---|---|
| F1 | Invoice numbering exists and needs splitting | `Invoice` is the vendor's subscription invoice. The patient-facing invoice is `VisitCharge`, and `InvoiceSheet.tsx` printed its UUID as "Invoice No." | Per-branch invoice numbers are new, not a split (ruling 4) |
| F2 | Receipts have a sequence | `tenants.next_receipt_number`, allocated by `allocate_receipt_number()` | The one real sequence to split |
| F3 | Shifts and stock get stamped | Neither table exists | §1.5 gives the rule future tables follow |
| F4 | Audit rows get stamped | `audit_logs` is append-only, as are `appointment_events`, `payment_adjustments`, `patient_credits`, `visit_revisions` | Old rows cannot be updated without disabling a guard (ruling 6) |
| F5 | Every exported financial report | No export exists; reports render on screen | The rule applies to the report header, and to any export when built |
| F6 | Branch picker only when multi-branch | The clinic switcher in `AppShell.tsx` renders only when there is another clinic | The pattern to copy |
| F7 | A doctor's schedule per branch | `PUT /doctors/:id/schedule/templates` replaces the doctor's whole set | Must become replace-within-one-branch (§4.4) |
| F8 | Branch scope enforced in the API | 25 service files use `$queryRaw`, which the tenant extension never sees | Every raw query needs an explicit filter; §4.3 adds a registry guard |
| F9 | One WhatsApp channel per clinic | `whatsapp_phone_number_id` is unique per tenant | Fine: the bot derives the branch from the slot (§4.2) |
| F10 | The letterhead shows the clinic | `print-blocks.tsx` prints `tenants.address` and phones | A second branch prints its own address (Q3) |

## Rulings (2026-10-27)

1. **One migration, one transaction.** The pilot has little data and deploys out of hours.
2. **Composite foreign keys** `(tenant_id, branch_id) → branches(tenant_id, id)` on every branch
   reference, so the database refuses a row pointing at another clinic's branch.
3. **Patients are not branch-stamped.** A patient belongs to the clinic and keeps one file everywhere.
4. **Invoice numbers:** charges are numbered per branch, replacing the printed UUID (Q1 option a).
5. **Receipts:** a per-branch sequence; the default branch keeps a null prefix and continues the
   clinic's counter, so printed numbers stay valid and the next one is the one that would have come next.
6. **Audit rows:** the append-only guard is never disabled (Q2). Old rows reading as the default branch
   was superseded 2026-10-29: they say `BEFORE_BRANCHES`, because nobody recorded their branch (§4.6).
7. **Membership scope** defaults: admin ALL, doctor SCHEDULED, reception SELECTED.
8. **Every ledger row stores its currency code**, with no screen and no setting.
9. **The down migration refuses** once a clinic has a second branch, or once any invoice number has
   been issued after the migration: a printed invoice number is a financial record handed to a
   patient, and dropping it is data loss, not a rollback.
10. **Interim branch fill** (§2.2) is marked interim, removed in step 4, and a test fails while it remains once write paths set the branch.
11. **A patient's credit is clinic-wide** and spendable in any branch (Q5, decided 2026-10-29).
    `patient_credits` stays unstamped, and the credit and refund routes are clinic-level.

## 1. Schema

### 1.1 `branches`

Name and English name; address and English address; phone and secondary phone (E.164); paired
latitude/longitude; free-text printed working hours; `receipt_prefix` and `invoice_prefix`;
`next_receipt_number` and `next_invoice_number`; `is_default`; `status` ACTIVE or SUSPENDED with a
required reason and date. A branch is never deleted, because financial records reference it.

Constraints: `UNIQUE (tenant_id, id)` (the composite-key target); one default per clinic; at most one
unprefixed branch per clinic for each sequence; prefixes unique within a clinic and never blank;
counters positive; suspension explained; coordinates paired.

RLS enabled and forced with a `tenant_isolation` policy on reads and writes, `SELECT, INSERT, UPDATE`
to `clinic_os_app`, and the `audit_row_change()` trigger — the `complaints` pattern, as on the other two
new tables. `tenant-rls-coverage.integration.spec.ts` asserts the RLS half for every scoped model.

### 1.2 Columns gaining `branch_id`

| Table | Column | Value | Integrity |
|---|---|---|---|
| `schedule_templates` | `branch_id NOT NULL` | Interim fill (§2.2); step 4: chosen by the scheduler | tenant-composite FK |
| `schedule_exceptions` | `branch_id NULL`, `scope` | Null only with `scope = EVERY_BRANCH` (§4.4) | tenant-composite FK; two CHECKs |
| `appointments` | `branch_id NOT NULL` | Interim fill; step 4: the template covering the slot | tenant-composite FK |
| `visits` | `branch_id NOT NULL` | Copied from the appointment by trigger | `(appointment_id, branch_id) → appointments(id, branch_id)` |
| `visit_charges` | `branch_id NOT NULL`, `invoice_number NOT NULL` | Copied from the visit; number allocated per branch | `(visit_id, branch_id) → visits`; `UNIQUE (branch_id, invoice_number)` |
| `payments` | `branch_id NOT NULL` | From the charge, else the visit, else the appointment; with none of the three a receipt is refused (stage 5) | composite FKs through `charge_id`, `visit_id`, `appointment_id`; `UNIQUE (branch_id, receipt_number)` replaces `(tenant_id, receipt_number)` |
| `audit_logs` | `branch_id NULL`, no FK, `scope` | Null only when `scope` is not ONE_BRANCH (§4.6) | Audit rows outlive what they describe; one CHECK |

`tenants.branches_enabled_at` records when the migration ran. Nothing reads it since §4.6; it is
retained, not dropped (ruled 2026-10-29), because multi-branch is a paid add-on (ruled 2026-10-26, `PRICING.md` §1) and
it may become the record of when a clinic started paying for it. `tenants.next_receipt_number` is kept, unused, for
the down migration.

Not stamped, deliberately: the patient and their clinical file (patients, allergies, clinical profile,
relations, insurance, attachments, prescriptions, credits); the children that derive through a parent
(`appointment_events`, `visit_revisions`, `visit_procedures`, `visit_investigations`,
`visit_charge_lines`, `payment_adjustments`, `schedule_breaks`); catalogues (services, materials,
insurers, doctors).

### 1.3 Membership scope

`memberships.branch_scope` is ALL, SELECTED or SCHEDULED, and `membership_branches` lists the branches
of a SELECTED membership. A trigger sets the scope from the role when it is not given, and again when
the role changes: OWNER, ADMIN and AI_AGENT get ALL, DOCTOR gets SCHEDULED (the branches holding one of
the doctor's templates not yet ended, computed per request in step 3), RECEPTIONIST gets SELECTED. A
SELECTED membership with no branch starts in the default branch. Scope never governs the clinical file.
Rejected: scope in the JWT — scope edits are routine, and a per-request lookup cannot go stale.

### 1.4 `branch_requests`

A clinic asking the vendor for a branch: kind CREATE, a jsonb proposal, status PENDING, APPROVED,
REJECTED or WITHDRAWN, who asked and who decided. CHECKs: decided exactly when not pending, a decision
date with a decider, a reason for a rejection, an approval naming the branch it created. The operator's
cross-clinic read function `platform_branch_requests()` comes with the routes that call it (step 6).

**New meaning, ruled 2026-10-30 (§9, ruling A; Q10):** the clinic admin now creates branches directly,
up to the limit the operator sets, so no branch is requested. The same table becomes **the request to
raise the limit**: a clinic at its `max_branches` asks from the screen instead of calling. The button is
step 8; the operator's queue of requests is step 6. The CREATE kind and the approval "naming the branch
it created" describe the old meaning, and change with that step.

6.2, as built (`20261031184500_branch_requests_raise_limit`): `kind`, `payload` and `created_branch_id`
are gone; a request carries `requested_limit` (at least 2) and a note, one may be pending per clinic,
and an approval names the `branch_limit_changes` row it made (CHECK). The clinic asks, lists and
withdraws at `/branch-requests` (`clinicSettings.manage`); the operator reads `platform_branch_requests()`
and decides at `/platform/branch-requests/:id/decision`. An approval never lowers a limit already
raised past the request; a rejection needs a reason, which the clinic sees.

### 1.5 The rule for tables not yet built

`src/prisma/branch-stamped-models.ts` classifies every model as stamped, derived from a stamped parent,
clinic-level, or not a clinic's at all, with `satisfies Record<Prisma.ModelName, …>`: a new model does
not compile until classified. Its spec checks the classification against the schema's fields, and
`branches.integration.spec.ts` checks every stamped table carries the tenant-composite FK.

## 2. Backfill migration

### 2.1 Order (`20261027100000_branches`, one file, one transaction)

1. Refuse to run as a role that cannot bypass RLS while clinics exist: the backfill and every assertion
   would otherwise pass on zero visible rows.
2. Bind the system actor. Create the enums and the three tables with RLS, grants and audit triggers;
   add `audit_logs.branch_id` and `tenants.branches_enabled_at`.
3. Insert one default branch per clinic, copied from the tenant, prefixes null, receipt counter equal to the tenant's.
4. Add the stamped columns nullable; backfill parents first (templates and appointments to the default
   branch, visits from appointments, charges from visits, payments from charge, visit or appointment);
   exceptions stay null. Assert no row is left without a branch.
5. Number existing charges per branch, oldest first, and set each branch's invoice counter above them.
6. Currency on the five ledger tables: updated from the clinic on the three ordinary ones; on the two
   append-only ones a constant column default that writes no row, allowed only after asserting the
   clinics owning rows there share one currency, then dropped.
7. `NOT NULL`, the composite FKs, the per-branch unique indexes (the replacement exists before the
   per-clinic receipt index goes), currency CHECKs.
8. Triggers: the interim fill, visit and charge stamping, invoice allocation, receipt allocation from
   the branch row, currency stamping, a default branch for every new clinic, membership scope.
9. `audit_row_change()` records the branch.
10. Assert: every clinic has exactly one branch, its default; each branch's receipt counter equals the
    clinic's old one and is above its highest receipt; each invoice counter is above its highest
    invoice; every SELECTED membership has a branch; every money row carries its clinic's currency.

Each backfill `UPDATE` writes an ordinary audit row attributed to the system actor. Rejected:
disabling the audit triggers for the backfill — D16 says it never happens.

### 2.2 The interim branch fill

Until write paths choose a branch (step 4), a new appointment, schedule template, or payment with no
charge, visit or appointment takes the clinic's only active branch. It refuses when the clinic has more
than one. As migrated by A2 it also refused any insert that named its own branch. Since step 4b
stage 1 (`20261029070000_branches_interim_accepts_named_branch`) a named branch is kept and the
fill acts only when none is given, so write paths can name theirs one at a time. **Removed in
stage 5** (§4.2); a row naming no branch is now refused.

### 2.3 The single-branch invariant

After the backfill every clinic has one branch with null prefixes and a continued counter, so the
receipt numbers already in patients' hands are unchanged and the next one is the one that would have
come next. New clinics get their default branch from a trigger on `tenants`, whichever path creates them.

### 2.4 Reversal

`down.sql` beside the migration, run with `npm run migrate:down -- 20261027100000_branches` in one
transaction. It refuses first, before changing anything, when a clinic has more than one branch or when
any charge was created after the migration was applied. Otherwise it copies each default branch's
receipt counter back to the clinic, restores `allocate_receipt_number()` and `audit_row_change()`
byte for byte (asserted by `branches-down-migration.spec.ts`), drops what the migration added except
`audit_logs.branch_id`, and deletes its own `_prisma_migrations` row so deploy re-applies it.
`branches-migration.integration.spec.ts` runs up, down and up again in a throwaway database.

## 3. Invoice and receipt sequences

- Two counters per branch, each bumped in a `BEFORE INSERT` trigger under the branch row's lock inside
  the writing transaction: a rollback takes the increment with it, so both stay gapless.
- Printed form `{prefix}-{number}` when a prefix is set, `{number}` when not, formatted in one function
  per side. The default branch's prefixes stay null, so a single-branch clinic prints as before.
- Creating a second branch requires prefixes for it; a prefix is immutable once used.
- Egyptian e-invoicing may need an issuer branch code: a nullable `eta_branch_code` when known.

## 4. Branch scope in the API

### 4.1 Request flow

Tenant isolation is untouched and remains the hard boundary. A `BranchScopeInterceptor` after the
membership freshness check resolves the allowed branches into a `branchContext`. The selected branch
arrives as `X-Branch-Id` (a uuid or `all`): outside the allowed set → 404; absent with one branch or a
one-branch scope → that branch; absent otherwise → all for reads, a named refusal for writes.
`withTenant` binds `app.current_branch_id` for the audit trigger; RLS does not read it. (Q7)

Rulings of 2026-10-28, as built in step 3:

- **The selected branch travels in `X-Branch-Id`, never in the token.** Q7 is closed.
- **A single-branch clinic resolves to its one branch, whatever the membership scope.** Nothing past the
  branch list is read for it.
- **SCHEDULED** means the branches holding one of the doctor's templates **not yet ended**, judged by
  today's date **in the clinic's time zone**, not UTC. Future-dated templates count (ruled
  2026-10-29): an admin writing next week's schedule must not leave the doctor on the default branch
  until Monday, then have the scope change by itself with nobody having acted. A doctor with none
  falls back to the default branch, never to a refusal: a new doctor who cannot work until a schedule
  is written would read as an outage.
- The **named refusal for a write with no single branch** comes with its first consumer, the top-up in
  step 4. A guard with no route to refuse cannot be proven by breaking it.
- `/auth/me` returns the allowed `branches` and `isMultiBranch`, a display hint like `permissions`.
- **No branch context means unattended, and only that** (ruled 2026-10-29). A job or the seed runs
  outside any request and acts for the whole clinic. An HTTP request with no membership (public
  routes, webhooks, sign-in) runs under an empty scope, so a branch check inside it refuses. The public
  webchat acts under its bot membership's own scope, resolved as for any request.
  `branch-context-coverage.integration.spec.ts` fails if a route acting for a clinic member lacks
  `AuthGuard`, or if the served routes and the registry disagree.

### 4.2 Writes take their branch from the data

Booking: the template covering the slot, signed into the slot token. A visit: its appointment. A charge:
its visit. A payment against a charge: the charge. A top-up: the selected branch, which must be single.
A template or exception: the body's `branchId`, within scope. The slot engine stays pure; the doctor-day
lock stays per doctor, which is what keeps one doctor out of two branches at once.

Step 4 is split (ruled 2026-10-29). **4a**, as built:

- The engine plans each branch separately. A slot carries its template's branch, and the doctor's
  appointments occupy him in every branch.
- The slot token signs the branch as an eighth field. Booking and rescheduling refuse a branch outside
  the caller's scope with 404, and an existing appointment outside it reads as not found. 4a checks
  the branch but does not yet write it on insert: the interim fill still does.
- **Old-shape tokens get a grace period.** A seven-field token, minted before 4a, still verifies with
  no branch. It resolves to the clinic's sole active branch, and in a multi-branch clinic it is
  refused (`INVALID_TOKEN`). A patient mid-conversation on WhatsApp at deploy is not failed. The shape
  was accepted only while the interim fill existed, and was retired with it in stage 5: it is now
  `INVALID_TOKEN`. There is no separate 4a deployment (ruled 2026-10-29): the phase ships
  as one rollout at its end, so stage 5 is not blocked on any earlier step reaching the server. The
  requirement is only that the rollout happens while the clinics are closed, so no token minted
  before it (they live ten minutes) is in flight.
- `BRANCH_REQUIRED` is the named refusal for a write with no branch. Its first consumer is extra
  availability with no branch in a multi-branch clinic; the top-up follows in 4b.

**There is no top-up.** The sentence above, and 4a's note that `BRANCH_REQUIRED` would next be used
by one, assumed a payment that names neither a charge nor an appointment. Ruling R-A ("money always
names what it is for") already refuses that, and `desk.ts` is the only writer of payments. So every
receipt's branch is derived by trigger from what it pays for, and the write path's duty is the scope
check, not choosing a branch. Found 2026-10-29 while building 4b stage 2.

4b stage 2, as built:
- Booking writes the token's branch.
- A payment against a charge or an appointment outside the caller's scope is 404, as another clinic's would be.
- `PUT …/schedule/templates?branchId=` replaces that branch's set only. Leaving it out is allowed
  with one branch and refused with two (`BRANCH_REQUIRED`). A set overlapping the doctor's templates
  in another branch is refused (`OVERLAPPING_TEMPLATE`) before anything is deleted.
- No route remains `awaiting-write-path`.

4b stage 3, as built: every scoped write that acts on a stored row checks that row's own branch
(`common/branch-refusal.ts`). Outside the caller's branches it answers with the handler's existing
not-found, so it reads exactly as a missing row, and records an audit row
(`BRANCH_SCOPE_REFUSED`, in the refused row's branch). A refused write changes nothing, so no
trigger would otherwise see it. Clinic-level routes get no such check.
`branch-existing-rows.integration.spec.ts` derives its set from the registry, so a new scoped
write route without a case fails it.

4b stage 5, as built (`20261029180500_branches_stage5_retire_interim`). The interim fill and the 4a
token grace period were retired in one step (ruled 2026-10-29). The phase reaches the clinics as one
rollout at its end, run while they are closed, so no pre-4a slot token is in flight.
- **The fill is gone.** Its two triggers, `interim_fill_sole_branch()`, `interim_sole_branch()`, and
  the sole-branch fallback in `allocate_receipt_number()` were all dropped. A row naming no branch is
  refused by NOT NULL. A receipt with no charge, visit, appointment or branch is refused by name,
  never numbered in a guessed branch. The down restores all of it, byte for byte against stage 1
  (`branches-down-migration.spec.ts`).
- **The grace period is gone.** That half is application code: only the eight-field slot token
  verifies, and the seven-field shape and an empty branch are `INVALID_TOKEN`, stale or fresh
  (`stale-slot-token.integration.spec.ts`). Reverting it means reverting the commit; the down
  migration restores only the database half.
- **`branch-null-free.integration.spec.ts`.** It failed on `develop` before this step: an
  appointment, a template and a receipt naming no branch were each accepted and given the sole
  branch. It passes after. It also asserts that every `branch_id` column is NOT NULL except the two
  whose null is an explicit value, each held by its CHECK:
  - `schedule_exceptions` (`schedule_exceptions_branch_matches_scope`, §4.4);
  - `audit_logs` (`audit_logs_branch_matches_scope`, §4.6). This second exemption was added
    because audit scope came after the first wording.
- **Nullable-branch sweep.** The exception delete's `stored !== null` was the legitimate
  EVERY_BRANCH case, which `refuseExceptionReach` rules on, so it now decides on `scope`. So does
  `refuseExceptionReach`, so a ONE_BRANCH row can never fall through to the every-branch rule. The
  engine's default branch for extra availability with none (4a) is gone: such a row opens nothing,
  and the §4.4 CHECK forbids it anyway.
- **The `strict-branch-fill` mode and CI job were removed, not made blocking.** With the fill gone,
  a branch-less write fails on the real schema in every run, and the main job's seed is held to the
  same rule. Of the 35 tests it failed on, 34 were the stage 3 fixture's single-branch and
  other-clinic rows, which now name their branch and stay. The 35th was the fill's own "refuses to
  guess", retired with it.
- No route is `awaiting-write-path`. `branch-scope.integration.spec.ts` asserts that unconditionally,
  along with the fill's absence.

A follow-up books into the visit's branch: it searches forward within `booking_horizon_days` for the first day the doctor works there, and with none it says so and names the branch. Another branch only when the caller names it (`followUpBranchId`); the API never relocates a patient (ruled 2026-10-29).

That null was overloaded: a row written before branches, or in a clinic with one branch, could not be told from a deliberate every-branch exception. Settled by the `scope` column (§4.4), which stage 5 needed first.

**4b** carries the rest: write paths setting the branch, the per-branch template replace, the
existing-row checks on scoped writes (ruled to belong to step 4, being writes), and the interim
fill's removal, as a staged sequence with proofs between stages.

### 4.3 Reads, and the guard

Operational reads filter by branch explicitly, raw SQL included. A `BRANCH_ENFORCEMENT` registry keyed
by route marks each one scoped or clinic-level, and a test fails when a route is missing. Rejected:
filtering in the tenant extension — it cannot see raw SQL, and would filter the clinical file.

The registry (`src/common/branch-enforcement.ts`) has four statuses:

| Status | Meaning |
|---|---|
| `scoped` | Operational data that lives in a branch; step 5 filters it to the allowed branches |
| `clinic-level` | Clinic-wide: the patient and the clinical file, catalogues, settings, staff |
| `awaiting-write-path` | Creates a branch-stamped row through the interim fill (§2.2); step 4 gives it its branch |
| `no-clinic` | No clinic membership behind the request: sign-in, the operator console, public links, webhooks |

`test/unit/branch-enforcement.spec.ts` fails on a route with no entry, an entry with no route, or a
clinical-file route marked anything but clinic-level. `branch-scope.integration.spec.ts` fails if any
`awaiting-write-path` entry exists: since stage 5 there is no interim fill for one to rely on.

Classified by ruling: notifications, `/visits/open` and transfers are clinic-level; the audit log is
scoped. The doctors offered as a transfer's target are filtered to the branch by default, with a
way to widen the list to the whole clinic. That screen is step 8, and the API keeps the list clinic-wide.

Ruled 2026-10-30, for step 5:
- A scoped read filters to the selected branch when `X-Branch-Id` names one, otherwise to every
  branch the caller holds. An unknown `X-Branch-Id` is 404 on reads, as on writes.
- A single-row read outside the caller's branches is **404 only, with no `BRANCH_SCOPE_REFUSED` row**.
  Write refusals are the signal; read misses happen by accident (an old link, a page open from
  another branch) and would bury it. Sensitive reads keep their own audit, unchanged.
- A doctor with `own` reports sees per-branch figures for themselves only.
- **Busy elsewhere.** In the day and week views, a doctor's appointment in a branch the reader does
  not cover still shows as busy (the doctor is in one place, and hiding it invites a double booking),
  but as **time only**: `{ start, end, elsewhere: true }`, with id, status and patient withheld.
  Existence shows, detail does not: the same rule as the 404s. The day screen follows in step 7.
- Every slot `/availability` and `/bot/slots` return under a branch context must be bookable under
  that same context. This is a 5b test, proven by breaking the availability filter: the bot saying a
  time is free and the booking then refusing it is step 5's most patient-facing failure.
- 5d, as built: the index is on `payments (tenant_id, branch_id, receipt_date)`, the column the
  report and overview actually filter by. `paid_at` was named first, and measured too.
- 5e, as built: `GET /reports/branches` runs the payments report once per branch in the read set,
  under a context that reads only that branch, so a row cannot disagree with the filtered report.
- 5f, as built: an event that qualifies shows whole. Qualifying is judged on the **whole transaction**,
  never only the entries matching the viewer's other filters (ruled 2026-10-31: a record-type filter
  must not hide an event that happened in the reader's branch). The filter options (actors, record
  types) come only from events the reader can see, so a scoped admin is not shown another branch's staff.
- 5g, as built: `test/integration/branch-read-cases.ts` names, per scoped GET, the spec that proves it
  and text that spec must contain; a unit guard derives the routes from the registry. A gap is allowed
  only in `AWAITING_RULING`, which is empty since `GET /audit-log/filters` was ruled (2026-10-31).
  - **Measured** on a year-sized seed: three clinics, two branches each, 100 receipts a day, 109,500
    rows. One branch's June took 4.72 ms and 732 pages with no new index (not a sequential scan, as
    first assumed: the planner narrows by an existing tenant-leading index, then filters). An index on
    `paid_at` barely helped: 2.45 ms, 721 pages. **The `receipt_date` index took 0.23 ms and 63 pages.**
  - The receipt-date guard, `branch-reports.integration.spec.ts`, fails if the index is missing.

### 4.4 Schedules

A template belongs to one branch; a doctor may hold templates in several, never overlapping.
`PUT …/schedule/templates?branchId=` replaces only that branch's set. Exceptions: doctor and branch both
null closes the clinic; branch alone closes that branch; doctor alone means away everywhere; both means
away in that branch.

Ruled 2026-10-29, built in 4a:
- An exception with no branch reaches every branch. In a multi-branch clinic, only a caller whose
  scope covers every active branch may write or delete one; anyone else gets `SCOPE_TOO_NARROW`.
- An exception naming a branch outside scope is 404.
- Extra availability must name its branch once the clinic has two (`BRANCH_REQUIRED`), because it
  says where the doctor will be. Rows written before branches, with no branch, land in the default branch.

Ruled 2026-10-29, `20261029155000_schedule_exception_scope`: an exception's reach is an explicit
`scope`, ONE_BRANCH or EVERY_BRANCH, decided in `exception-scope.ts`. Two CHECKs hold it: a null
branch only with EVERY_BRANCH, and extra availability always ONE_BRANCH.
- A named branch is ONE_BRANCH; naming one with EVERY_BRANCH is `INVALID_FIELD`.
- A doctor's absence defaults to EVERY_BRANCH, even in a single-branch clinic, so it stays right
  when a second branch opens. ONE_BRANCH is the override.
- A closure with no doctor has no default: with one branch it is that branch; with two the request
  must say (`BRANCH_REQUIRED`). The screen asks only once two branches exist.
- Backfill: a named branch is ONE_BRANCH; extra availability takes the default branch; every other
  null-branch row takes EVERY_BRANCH, failing safe, blocking rather than booking.
- When a branch is created, the clinic reviews **every** future-dated exception, not only the
  every-branch ones, because a one-branch exception may have been meant for the new branch too. The
  review is step 6's; since 2026-10-30 the clinic admin's own creation of a branch triggers it (§9).
  It is a **service the step 8 create route calls**, tested in step 6 by creating branches directly,
  and **not a database trigger**: the review is a human decision, not a database event (ruled 2026-10-31).
  6.6, as built (`20261101063500_branch_exception_review`): `openExceptionReview(tx, branchId, today)`
  runs in the creating transaction and writes one `branch_exception_reviews` row per exception dated
  today or later, any scope. The admin (`clinicSettings.manage`) decides each once at `PUT
  /branches/:branchId/exception-review/:reviewId`: KEEP, or COPY_TO_NEW_BRANCH. The copy goes through
  the schedules service's own rules (`addExceptionIn`) in the same transaction. An every-branch
  exception already covers the new branch, so it can only be kept.

### 4.5 What scope never touches

Patient search, the record, the clinical file, visit history, prescriptions, allergies and attachments
stay clinic-wide for whoever holds the capability today, listed as clinic-level in the registry.

### 4.6 Audit scope

Ruled 2026-10-29, `20261029163000_audit_scope`: an audit row's reach is an explicit `scope`, the same
pattern as exceptions (§4.4). One CHECK: a null branch if and only if the scope is not ONE_BRANCH.
- ONE_BRANCH: the row's own branch, and a `branches` row is its own (every receipt and invoice
  number allocation updates one); for appointment events, visit revisions, procedures, charge lines,
  payment adjustments and schedule breaks, the parent's; for any other table, the request's branch.
- UNSCOPED: genuinely no single branch: a clinic-level write with no branch selected, an every-branch
  exception, and the operator console's rows, which are the vendor's trail, not a branch's.
- BEFORE_BRANCHES: written before the column existed, with no branch recorded. Historical only: a
  trigger refuses it on insert. Existing rows were labelled by a column type change, not an UPDATE,
  so D5 held; a backfill to the default branch would have written a value nobody recorded. The
  boundary this sets is a rule: `SCHEMA-DECISIONS.md` D14a.
- The sensitive read (`clinical.access.ts`) takes its reach from the same bound branch as the trigger.

Every receipt and invoice allocation audits a `branches` row. That is high volume, since a clinic at
100 receipts a day writes tens of thousands a year, and it is deliberate. Those rows are the control on
the receipt-number sequence: a counter bumped by hand to skip numbers shows up here, and a gap in
receipt numbers is the first thing a tax inspector looks for. The volume is a problem for the audit
viewer to group or filter in steps 7–8, never a reason to stop recording them.

For steps 7–8, the viewer: UNSCOPED and BEFORE_BRANCHES rows show in **every** branch's audit view,
the latter marked as predating branches. Omitting the branch header must never be a way out of
branch-level auditing: fail visible, not invisible. This lands before step 6, whose first second
branch is what would open the gap.

The viewer shows a transaction as one event (`SCHEMA-DECISIONS.md` D47), and one event can mix
reaches. For example, an admin with no branch selected completes a visit: the visit row carries its
branch, and the patient update is UNSCOPED. So step 8's branch filter decides **per event**: an
event appears in branch X's view if any entry is ONE_BRANCH in X, or if any entry is UNSCOPED or
BEFORE_BRANCHES (ruled 2026-10-29). Fail visible, at the event level.

## 5. Screens

A row outside the caller's branches must not surface as a bare "not found": the client knows the scope, says the record belongs to another branch and offers to switch; the API's 404 stays unchanged (ruled 2026-10-29).

One hook, `useBranches()`, returns `{ branches, selected, setSelected, isMultiBranch }`; every branch
element renders only when multi-branch. The picker copies the clinic switcher. Day view, booking, queue,
desk and payments are scoped to the selected branch; sheets and the letterhead print the branch's
address, phones and prefixed number; reports gain a branch filter and «كل الفروع»; a comparison report
per branch; settings list branches, and the clinic admin creates, edits and deactivates them up to
the clinic's limit, the screen saying so at the limit and pointing to the operator (§9); staff forms
gain scope; schedules a branch select; the operator console sets each clinic's branch limit and
suspends. Operator reads of clinic data are audited `READ_SENSITIVE` in **both** trails (Q8, ruled
2026-10-31): the vendor's, naming the operator, and the clinic's own, where it reads as "read by the
platform" without naming the person. The clinic owner is entitled to know their file was opened.
6.5, as built (`20261101062000_platform_reader`): the clinic's row is written as a reserved, LOCKED
`users` row named "Platform" (`platform_reader_id()`, phone in the range Egypt never allocates,
guarded). Opening one clinic's file or contract writes both trails. **A cross-clinic list** (clinics,
the raise-limit queue, grace periods, message history) **writes the vendor's trail only**, one row per
view, since a row in every clinic's trail on each list view would bury what the clinic needs to see.
**Ruled 2026-11-01: lists stay vendor-trail only.** Q8 is about a named clinic's file being opened; a
list of fifty clinics opens no one's file.
`test/unit/platform-reads.spec.ts` names every `/platform` GET and fails when one's call is removed.

The schedule editor shows the doctor's hours in **every** branch, read-only and each labelled with its
branch, and allows edits only within the caller's scope (ruled 2026-10-30). This is the same
principle as the not-found rule above: hiding another branch's hours invites the overlap that the
write then refuses.

## 6. The single-branch no-change rule

Four layers, each able to fail a build: data (one default branch, null prefixes, continued counter);
API (no new required parameter, `X-Branch-Id` absent means the only branch); UI (a single-branch DOM
spec finds no branch string or picker); print (the receipt and invoice compared before and after).
Multi-branch means more than one ACTIVE branch. (Q9)

## 7. Risks

1. Raw SQL: branch scope is manual in 25 files; the registry guard, not review, stops a missed one.
2. Schedule replace-all: without the per-branch replace, a scoped receptionist deletes another branch's templates.
3. Address in two places (Q3): the tenant keeps legal identity; address, phones and hours move to branches.
4. The WhatsApp flow books through the slot token, whose format changes in step 4.
5. Lock order: invoice and receipt now lock the same branch row, inside one transaction.
6. Composite FKs need `UNIQUE (id, branch_id)` on appointments, visits and charges: index space on busy tables.

## 8. Build order

Each step is one pull request, merged before the next starts. Steps 1–6 are backend, proven by tests;
screens wait for the founder's eyes.

| # | Step | Proof |
|---|---|---|
| 1 | Split the four oversized screens, no behaviour change | Web suite unchanged, line counts |
| 2 | Schema and backfill (§1–2) | Up → down → up; in-migration assertions broken; cross-tenant FK refused; receipt sequence continues; RLS and audit on new tables; gapless per branch under concurrency |
| 3 | `BranchScopeInterceptor`, `branchContext`, `/auth/me`, `app.current_branch_id` | Unit tests; a guard failing on a removed entry |
| 4 | Write paths: slot token, booking, visit, charge, payment, per-branch schedule replace; the interim fill removed | Two branches: a scoped receptionist cannot book, pay or edit schedules in the other (404) |
| 5 | Read paths: every route in the registry, reports, `GET /reports/branches` | Integration per route; the registry complete |
| 6 | Operator side: `max_branches` per clinic and its history, the queue of requests to raise it (§1.4), suspension (including branches over a lowered limit, after the clinic's grace period), operator messages to clinic admins, read auditing; the review of every future-dated exception when the clinic admin creates a branch (§4.4); requires the audit scope (§4.6). See §9 | Spec fails when one GET's audit call is removed; a lowered limit suspends, never deletes |
| 6b | **Support access to a clinic account** (§9, ruling C): its own phase after step 6, not part of phase A. Security and the service contract together | Its own plan, reviewed before it starts |
| 7 | Screens: picker, day view, booking, queue, desk, sheets, letterhead | Single-branch DOM spec, print e2e, then review |
| 8 | Screens: settings, **branch CRUD up to `max_branches`** (moved here from step 6, ruling A), the request to raise the limit, choosing which branches to suspend when it drops, staff scope, schedules, reports, comparison; the clinic's external accounts and social links (ruling B); moving future bookings out of a branch to be suspended; the clinic admin's notice bar and inbox for operator messages (ruling D): the inbox shows the clinic's recent messages to **any current admin**, including one who joined after a message was sent; the per-admin copies only record who read what (ruled 2026-11-01) | Same, then review |
| 9 | Console screens, including operator messages | Review |

## 9. Who decides what: operator, clinic, and the clinic's own accounts (ruled 2026-10-30)

**A. The limit is the operator's; the branches are the clinic's.** This supersedes 2026-10-26's
"branches are added by the super admin".
1. The operator sets `max_branches` per clinic in the console and may change it at any time. Every
   change is recorded with who and when. Multi-branch remains a paid add-on, priced separately from
   the doctor-count package (`PRICING.md` §1).
2. The clinic admin creates, edits and deactivates branches up to that limit, in clinic settings. At
   the limit the screen says so and points to the operator.
3. If the limit is lowered below the clinic's branch count, the excess branches are **suspended,
   never deleted**: their data and history stay, and no new booking lands in them until the limit
   allows. Appointments, payments and visits are tied to them, so deletion is not an option.
   **The clinic admin chooses which** (Q11): a notice says how many the clinic has and how many are
   allowed ("you have 3, 2 are allowed — choose"), with a grace period. After it, the most recently
   created are suspended. **Booking continues in every branch during the grace period**: patients are
   not punished for a billing change. **The grace period is 30 days** (Q12, ruled 2026-10-31).
   **A branch with any future appointment is never suspended** (ruled 2026-10-31). The grace period is
   exactly the time the admin has to move those bookings (the move screen is step 8). If it ends with
   bookings still there, that branch's suspension is deferred and the operator is notified; nothing is
   cancelled automatically. A patient's appointment is never the casualty of a billing change.
   The limit's history is its own append-only table, `branch_limit_changes` (ruled 2026-10-31).
5. **A suspended branch's history stays in reads** (ruled 2026-10-30). The *read* set is the caller's
   active branches plus the suspended ones its scope covers; the *write* set is active only
   (`common/branch-read.ts`: `readSet()`, `writeBranches()`). Lists and reports show a suspended
   branch's rows dated before its suspension. Availability never offers its time, and no booking lands
   in it. A month's payments report missing a suspended branch's numbered receipts is a gap a tax
   inspector asks about, so 5d's report tests name it: a suspended branch's past receipts appear in the
   month's total. Labelling those rows as suspended belongs where a row names its branch: the 5d
   reports, and the step 7 screens.
4. Branch CRUD moves from step 6 to step 8 (clinic settings). Step 6 keeps `max_branches` and its
   history, suspension, and the review of future-dated exceptions (§4.4), now triggered by the clinic
   admin's action.
   6.1, as built (`20261031182000_branch_limit`): existing clinics start at their active branch count.
   A trigger refuses any branch becoming ACTIVE past the limit, under the clinic row's lock. Lowering
   the limit refuses nothing and suspends nothing; 6.3 does that. Set by `POST /platform/clinics/:tenantId/branch-limit`.
   Its backfill writes one UNSCOPED audit row per clinic, so the branches round-trip spec cannot reverse
   past it. **Ruled 2026-11-01: the migration stays as merged** and the test adapts; the rule against
   editing merged migrations exists for exactly this temptation.
   6.3, as built (`20261031192500_branch_limit_grace`): any limit change below the active count opens
   one 30-day `branch_limit_graces` row; a change back within the limit clears it. A second lowering
   during the grace keeps the first deadline. The admin reads `GET /branch-limit` and chooses at `PUT
   /branch-limit/choice`: exactly the excess, never the default branch. The daily pass (`npm run
   branches:enforce-limits`, `SERVER-SETUP.md` §9c) suspends the chosen branches, else the newest. A
   branch with any live future appointment is held, the grace becomes DEFERRED with the reason, and
   the operator reads it at `GET /platform/branch-limit-graces`; the next pass retries.

**B. The clinic owns its external accounts.** The operator enables a feature (the WhatsApp bot and
the like). The clinic admin, in clinic settings, connects the clinic's own accounts and grants the
system access. **The clinic's settings screen is the single source of truth for those credentials:
nothing else writes them, everything else reads them.** This settles the credential-ownership
conflict between:
- **the WhatsApp registration flow** in the operator console: the new-clinic form runs Meta's
  Embedded Signup, and `POST /platform/clinics/whatsapp` → `signUpClinic` writes the clinic's
  connection;
- **PR #144's clinic-settings screen**, where the clinic admin issues and revokes the bot credential.

**#204** (open, unmerged) adds a console route that attaches a clinic's WhatsApp connection
(`platform-clinic-whatsapp-attach`). It is the console route that must change to enable-only once
step 8 builds the settings side; it stays open until then (ruled 2026-10-31).

Under this ruling the operator route stops writing the connection: the operator enables the feature,
and the connection is made from clinic settings. Social links (Facebook, Instagram, Google) are plain
URLs the clinic admin records in settings, and the bot may use them in a "follow us" message (see
`ARCHITECTURE.md` §11 for the Meta constraint on that message). Step 8 builds the fields; the message
waits for its consent and template work.

**C. Support access to a clinic account** is a named, conditional exception to the operator's
zero-access default of 2026-09-14, which stands (`PILOT-READINESS.md`). Its own phase after step 6
(row 6b). The conditions are recorded there. **Corrected 2026-11-01:** clinical scope is approved
only by a doctor, for that doctor's own patients, never by an admin; sessions are read-only unless
allowed and never write clinical content. The plan and its rulings: `docs/SUPPORT-ACCESS.md`.

**D. Operator messages to clinics.** The operator can send a message to one clinic's admin or to all
clinics: text, optionally images through the existing attachments path, size-capped.
- Recipients are clinic **admins** only, never staff.
- Delivered inside the system (a notice bar and an inbox). **Never through WhatsApp**: that number is
  the clinic's and its patients'. "And by email where one exists" is **deferred** (ruled 2026-10-31):
  no sender exists, it needs a provider, and patient data stays in Egypt. Email is its own decision.
- Every message is recorded, append-only, with sender, recipients and time, and the operator can read
  the history.
- 6.4, as built (`20261031200000_operator_messages`): `operator_messages` is the vendor's record
  (platform-only RLS, audited into no tenant). In the same transaction, `deliver_operator_message()`
  writes one `operator_message_recipients` copy per ACTIVE OWNER or ADMIN of the target, or of every
  ACTIVE clinic. Read marks are `operator_message_reads` rows; all three tables are append-only. Text
  only, up to 4,000 characters: **images are not built yet** (open question below). Routes:
  `POST|GET /platform/messages`, and `GET /operator-messages`, `/unread`, `POST /:id/read` for admins.

Step 6 builds it; the console screen is step 9.

## Open questions

- **Q3** Address and phone live on the branch; does the tenant keep its own for the legal letterhead?
- **Q4** Branch working hours stay free text, as on the tenant?
- **Q6** ~~May the clinic admin edit an existing branch's address, phone and hours directly?~~ Answered
  2026-10-30 by §9 ruling A: the clinic admin creates, edits and deactivates branches up to the limit.
- **Q10** ~~Retire `branch_requests`, or keep it as the request to raise the limit?~~ Answered
  2026-10-30: it becomes the request to raise the limit (§1.4).
- **Q11** ~~Which branches are suspended when the limit drops below the count?~~ Answered 2026-10-30:
  the clinic admin chooses within a grace period, then the most recently created (§9 ruling A).
- **Q12** ~~How long is that grace period?~~ Answered 2026-10-31: 30 days (§9 ruling A).
- **Q8** ~~Should the clinic's own trail also show that the vendor read its file?~~ Answered 2026-10-31:
  yes, both trails; the clinic's says "read by the platform" without naming the person (§5).
- **Q9** A clinic whose second branch is suspended returns to the single-branch UI for operations?
- **Q13** ~~Do operator message images go through the attachments path?~~ Answered 2026-11-01: **no,
  their own small store.** The attachments path is built around a patient's file: its RLS, its
  retention, its PDPL classification. A maintenance notice's image is none of that. 6.4 stays text
  only until an image is actually needed; the store is built then, on its own terms.
