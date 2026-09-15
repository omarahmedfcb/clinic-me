# Phase 2 — Scheduling and the Slot Engine

**Goal:** a clinic can describe when its doctors work, and the system can answer "when is this doctor free for this service" correctly, deterministically, and identically for a receptionist and for the WhatsApp agent. Appointments can be booked against those answers, and the database — not the application — is what makes double-booking impossible.

**Estimate:** 3–4 calendar weeks at 10–15 hrs/week.

**Gate (`ARCHITECTURE.md` §20):** slot engine suite exhaustive; double-booking verified under concurrency.

**Why this phase is scoped before a line is written:** `find_available_slots()` is the tool the entire WhatsApp product rests on (§12 rule 1 — "hallucinated availability is architecturally impossible"). That claim is only true if the engine's contract is decided before its callers exist. Written controller-first and adapted in Phase 7, it would be rewritten at the point where it is hardest to change.

---

## 1. Scope

### Clinic configuration
- Doctors: create, list, edit, deactivate
- Services: create, list, edit, deactivate — `duration_minutes`, `price_minor`, `buffer_minutes`
- Schedule templates per doctor: weekday, hours, validity window
- Schedule breaks within a template
- Schedule exceptions: `BLOCKED`, `HOLIDAY`, `EXTRA_AVAILABILITY`

### The slot engine — `modules/appointments/domain/`
- `generateSlots()` — pure, deterministic, zero I/O
- `describeDay()` — the same computation, rendered as free/busy for the reception day view
- `transition()` — the §9 appointment state machine, pure, exhaustive
- `occupancy.ts` — the single shared definition of "this time is taken"
- A slot token: opaque, signed, minted only by the engine's service layer

### Appointments
- Book, reschedule, cancel
- Overlap override (`allow_overlap`) with recorded authoriser and reason
- Every transition writes an `appointment_events` row

### Frontend
- Doctors and services management screens
- Schedule editor per doctor
- **Day view** — the reception-facing calendar for one day

---

## 2. Out of scope

Queue and check-in · walk-in registration · no-show marking and the nightly job · visit screen · prescriptions · payments · reports · public booking page · WhatsApp · the AI tool layer

**Two boundary calls that are judgement, not omission:**

**`transition()` is written in full, but only part of it is reachable.** The queue transitions (`ARRIVED`, `WAITING`, `IN_CONSULTATION`) belong to Phase 3, and `NO_SHOW` needs the nightly job. The function is nonetheless implemented and tested over the complete matrix, because it is pure and cheap, and a half-written state machine is worse than none — it looks total. Phase 2's endpoints expose only `CONFIRMED` and `CANCELLED`.

**Booking is in Phase 2, not Phase 3.** The phase gate requires double-booking verified under concurrency, which cannot be demonstrated without inserting real appointments. Booking, rescheduling and cancelling therefore ship here; everything that happens to an appointment *after the patient arrives* ships in Phase 3.

---

## 3. Settled decisions

Ruled by the founder, 2026-08-28, before the schema checkpoint. Numbering follows the scoping questions.

| # | Question | Ruling |
|---|---|---|
| **Q1** | Is timezone a parameter? | **Yes.** `CLAUDE.md` wins; §9's signature is incomplete and its prose is corrected in the same PR. Source is `tenants.timezone`, threaded through, **never defaulted** |
| **Q2** | What is `date`? | A **`YYYY-MM-DD` string**, timezone supplied separately. A `Date` carries an instant and the caller's convention, which nothing enforces |
| **Q5** | Weekday numbering | **JS `getDay()`: Sunday = 0.** Derived in the tenant's timezone. Pinned in a comment **and** a test, because the seed would otherwise pin it by accident |
| **Q12** | Exception precedence | **`BLOCKED` and `HOLIDAY` always win over `EXTRA_AVAILABILITY`** — stated as a rule, not inferred from step order. Step order gets refactored; rules don't |
| **Q13** | `HOLIDAY` vs `BLOCKED` | `ScheduleException.doctorId` becomes **nullable — null means all doctors in the tenant.** `HOLIDAY` stays distinct: clinic-wide versus one doctor. A holiday re-entered per doctor is a holiday someone works by accident |
| **Q15** | "Occupied" | **One exported predicate**, shared by the query and the engine, asserted against the constraint's SQL text in a test. Two definitions drift silently in both directions |
| **Q18** | `granularityMinutes` | **Server-resolved from tenant settings. The caller cannot override it.** A caller-chosen granularity of 1 enumerates a doctor's day minute by minute |
| **Q19** | Grid anchor | **Window start, not the hour.** A window starting 09:07 emits 09:07. Hour-anchoring silently discards the first fragment and interacts badly with DST |
| **Q22** | Minimum lead time | **Per-source, therefore an engine parameter, not a post-filter.** Reception booking a walk-in for now is legitimate; the agent doing it is not |
| **Q24** | Slot identity | **An opaque token minted by `find_available_slots()`.** This is what makes §12's claim structurally true rather than a statement about model behaviour. Designed now, consumer in Phase 7 |

Also approved: **`MembershipRole.AI_AGENT`** as a fifth enum value now, while it is free; and **`audit_logs.message_id`** as a real column rather than JSONB.

---

## 4. The remaining eighteen — ruled 2026-08-28

All eighteen approved as proposed, **with one overrule: Q8.** Its reasoning is kept below rather than replaced, because the overrule is the more instructive half.

**Q8b** — which day a post-midnight slot belongs to — was left open for checkpoint 2 and is now ruled: **by session**. See Q8 below.

### Time

**Q3 — DST.** Expand templates in **wall-clock local time**, then convert each boundary to an instant through the tenant timezone. Two explicit rules: a **nonexistent** local time produces no slot; an **ambiguous** local time produces two distinct instants and **both are emitted**, each carrying its UTC offset so they are distinguishable.

The reason to look this up rather than reason about it: under the rule Egypt reinstated in 2023, the transitions fall at **midnight**, not at 02:00. Measured against this machine's tz database rather than derived — `Intl.DateTimeFormat` with `timeZone: 'Africa/Cairo'`, printed either side of each transition:

| Instant (UTC) | Cairo local | |
|---|---|---|
| `2026-04-23T21:59Z` | 23:59 EET, 23 Apr | spring forward: local **00:00–01:00 on 24 April does not exist** |
| `2026-04-23T22:00Z` | 01:00 EEST, 24 Apr | |
| `2026-10-29T20:30Z` | 23:30 EEST, 29 Oct | fall back: local **23:00–24:00 on 29 October occurs twice** |
| `2026-10-29T21:30Z` | 23:30 EET, 29 Oct | |

Both transitions lie outside ordinary clinic hours, and a cross-midnight template is the only thing that can reach them. **Q8 permits exactly that, so these are live cases rather than defensive ones**, and by Q8's third condition the two tests are written *before* the cross-midnight feature, against an engine that cannot yet pass them. Phase 2's own calendar contains 29 October. The tests pin the four instants above.

**Q4 — Determinism versus the tz database.** **Accept the dependency and make it loud rather than pinning it.** The engine is deterministic *given its inputs and the IANA tz rules in effect* — stated in that form, because pinning a tzdb version means a real government change silently produces wrong appointment times, which is worse than a changed test fixture. Egypt has altered its DST rule twice in three years and has suspended it during Ramadan before. Two things follow: the Q3 tests assert real instants, so a tzdb update that moves Egypt's transitions fails the suite and a human looks; and a **boot-time assertion** that `Africa/Cairo` resolves to an offset differing from UTC in July, because a runtime without full ICU resolves unknown zones to UTC silently — precisely the failure shape this project keeps finding.

**Q21 — "In the past".** **Fold it into Q22.** With a per-source lead time, "drop slots in the past" stops being a separate rule: a slot is dropped when its **start** is at or before `now + leadMinutes`. Staff lead time is 0, so a slot starting exactly now is offered and one that started four minutes ago is not. One rule instead of two, and no second place for the boundary to be wrong.

**Q23 — Booking horizon.** A per-tenant `booking_horizon_days`, default 90, enforced **in the service, not the engine** — the engine stays date-agnostic and pure. A request beyond the horizon returns a distinguishable "outside horizon" result rather than an empty list, because the agent needs to say "we don't book that far ahead", which an empty array cannot express.

### Templates, breaks, exceptions

The recurring principle across Q6, Q10 and Q17: **the engine is tolerant of whatever the database contains; the write path is strict.** A pure function that throws on real production data makes a doctor's whole day un-bookable at 9am because of one bad row entered last month. Rejection belongs at the moment the row is written, where a human is present to fix it.

**Q6 — Overlapping templates.** Engine **unions** them. The write path **rejects** an overlapping template for the same doctor, weekday and validity window, with a message naming the conflicting row. Tests on both halves.

**Q7 — `valid_from` / `valid_to`.** **Both inclusive**, interpreted in the tenant's timezone. A human writing "valid to 30 September" means the 30th is a working day; half-open is defensible and is the convention people get wrong. Boundary tests on both ends.

**Q8 — Cross-midnight templates. RULED: supported, properly, in Phase 2.** My proposal was to reject them with a `CHECK (start_time < end_time)`. **Overruled 2026-08-28**, and the reasoning is recorded here because it is the more important half of the decision:

> The proposal optimised for the engine's simplicity over the clinic's reality. Evening clinics running past midnight are ordinary in Egypt, and a `CHECK` means the first clinic working 22:00–01:00 cannot describe its hours at all — and discovers that during onboarding, in front of the founder. A day's availability depending on the previous day's templates is complexity we can carry; a clinic whose real schedule the system refuses to represent is a lost customer.

Half-support remains worse than either, so the decision comes with three conditions:

1. **Supported in Phase 2, not deferred.** No `CHECK`, no follow-up ticket.
2. **The engine's contract states explicitly that generating a day requires the previous day's templates too** (§7).
3. **The Q3 DST tests are written first, before the feature.** A cross-midnight template is the only thing that can reach Egypt's midnight transitions, so 24 April and 29 October stop being defensive tests and become the specification. They are written against an engine that cannot yet pass them.

`start_time < end_time` is therefore not a valid constraint. `start_time <> end_time` still is, and is proposed in §6 in its place: a zero-length window is meaningless under either reading, and a template that neither starts nor ends is not a night shift.

**Q8b — which day a post-midnight slot belongs to. RULED: by session.** A slot at 01:30 from a Thursday 22:00–02:00 template is a **Thursday** slot, not a Friday one.

The alternative was to anchor by instant — a slot belongs to the calendar day its start falls in. What decides it is what each reading does to `BLOCKED`. Under session anchoring, a `BLOCKED` on Thursday cancels the whole Thursday night session including its post-midnight tail, which is plainly what the person entering that row meant. Under instant anchoring, closing a night clinic for one evening takes two rows on two dates, and the founder's ruling on that is the operative sentence: **they won't remember the second one.**

It is also how a clinic describes itself — "the Thursday night clinic" — and therefore how the day view must group.

**Q9 — Breaks can only hang off a template.** **Accept for Phase 2.** A doctor working an `EXTRA_AVAILABILITY` day expresses a lunch break as two exception rows (09:00–12:00 and 13:00–17:00) rather than one row with a break. It is expressible, only less tidy, and a nullable second FK on `schedule_breaks` is schema surface for an uncommon path. Recorded as known ergonomics debt, not as a gap nobody noticed.

**Q10 — Malformed breaks.** Engine **unions** overlapping breaks and **ignores** portions falling outside their template's window; subtraction is idempotent, so this is harmless. The write path rejects a break lying **entirely** outside its template, which is unambiguously a data-entry error.

**Q11 — Exception time nullability.** A database `CHECK`, not an application convention — the D5 argument: a comment is not a guarantee.

- `BLOCKED` / `HOLIDAY`: both times null (whole day) **or** both non-null (partial day)
- `EXTRA_AVAILABILITY`: **both non-null, always** — a null window is not "all day available", it is meaningless, because there is no working day to add to
- Where both are present: `start_time <> end_time`, not `<`. Q8 permits a window crossing midnight, and an exception has to be able to describe the session it is modifying

**Q14 — Does `EXTRA_AVAILABILITY` add or replace?** **Adds** (union) — and this composes with Q12 to give both behaviours without a mode flag. "I work only 18:00–21:00 today, not my usual hours" is a whole-day `BLOCKED` plus an `EXTRA_AVAILABILITY` window: the union adds the evening, Q12's precedence removes the rest. Two rows, no second concept.

**Q17 — Appointments crossing the day boundary.** Fetch by **range overlap** (`scheduled_start < rangeEnd AND scheduled_end > rangeStart`), never by start-of-day equality. Under Q8 the engine now creates such appointments routinely, so this stops being a defensive measure: the occupancy fetch spans **the previous local day 00:00 to the next local day 24:00**, a three-day-wide window. That is always sufficient because §6's `start_time <> end_time` bounds a template below 24 hours, and it is cheap because it is a range scan on the existing `(tenant_id, doctor_id, scheduled_start)` index. The service cannot compute a tighter range without doing the expansion the engine exists to do.

### Occupancy, duration, output

**What the conformance test proves, and what it does not.** It proves the TypeScript predicate and the SQL predicate **agree**. It does not prove the constraint is **correct** — and those are different claims.

The distinction is not theoretical. While proving the test by breaking it, the constraint was restored on `clinic_os_test` from a hand-written `ALTER` that dropped `tenant_id WITH =` from the exclusion key. That constraint is wrong: it blocks overlapping appointments for the same `doctor_id` **across tenants**, so one clinic's booking could refuse another clinic's — a cross-tenant leak expressed as an error rather than as data, and one the 404 convention could not hide. **The conformance test passed against it**, because it exercises the `WHERE` predicate and the key is not part of the predicate. What caught it was comparing `pg_get_constraintdef()` byte-for-byte against `clinic_os_dev`.

So the test's guarantee is narrow by construction, and the fix is to widen it rather than to remember the limit: the spec now also pins the full definition, key and all. The general shape is the one this project keeps meeting — a green run carried no information about the half nobody was looking at.

**Q16 — Overlap-authorised appointments.** ⚠️ They **occupy** time for the engine, even though the database ignores them for the exclusion constraint. This refines Q15 rather than contradicting it: there are two related predicates, and pretending they are one is what would drift.

```ts
// occupancy.ts — one file, two predicates, and the reason they differ
constraintOccupies(a)  // mirrors no_double_booking exactly; asserted against the live predicate
engineOccupies(a)      // constraintOccupies(a) || a.allowOverlap
```

The constraint answers *may this row be inserted*; the engine answers *should we offer this*. An override was a deliberate act by an admin with a recorded reason (D3) — re-offering that time to the WhatsApp agent would double-book by design. Both are exported from one file with the difference documented, and each has its own test.

**Q20 — Buffer between appointments.** Add `services.buffer_minutes INT NOT NULL DEFAULT 0` in this migration. The **occupied footprint** of an existing appointment becomes `[start, end + buffer]`; the **bookable slot** remains `[start, start + duration]`. Two consequences worth stating: the buffer belongs to the *preceding* appointment's service, not the one being booked, so the occupancy fetch must join each appointment's own service; and the buffer need not fit inside the template window — a 15-minute service at 16:45 in a window closing at 17:00 is bookable, the buffer merely separates it from a next patient who cannot exist. Default 0 means nothing changes until a clinic sets it.

**Q25 — Free slots only, or every slot with a reason?** **Two functions over one computation.** `generateSlots()` returns bookable slots; `describeDay()` returns the day's working windows with their occupied blocks, for the reception day view. Both are built from the same intermediate free/busy interval list, so they cannot disagree. Merging them would put render-only data in the agent's list and mint Q24 tokens for slots that are not bookable.

**Q26 — Multi-doctor.** The **engine is single-doctor**; the service loops and merges. Ordering is **by start instant, then by doctor id ascending** — deterministic, and explicitly **no load balancing** in V1. Distributing patients across doctors by workload is a policy decision with clinic politics inside it, and it is not one the slot engine should make silently.

**Q27 — Input ordering.** The engine **sorts every input array itself**, by an explicit total order, as its first step. Prisma returns rows in whatever order Postgres gives, which is stable in practice and guaranteed nowhere. A test feeds shuffled inputs — shuffled with an explicit seed, next to an explicit reference date — and asserts identical output.

**Q28 — Inactive doctors and services.** Filtered in the **service** at fetch time (`isActive: true`); the engine documents that it assumes active inputs and does not re-check. Additionally: an unknown or inactive doctor returns **`null`, not `[]`** — the same absence-is-a-value pattern as `getPatient()`. The controller maps null to 404; the agent says "that doctor isn't available" instead of "no slots". An empty array erases a distinction both callers need.

---

## 5. The slot token (Q24)

**Stateless, HMAC-signed, short-lived.** Payload: `{ tenantId, doctorId, serviceId, startInstant, endInstant, expiresAt, nonce }`, signed with `SLOT_TOKEN_SECRET`, TTL 10 minutes.

Booking takes the token and **uses the token's values, never the request's**. Verification rejects a bad signature, an expired token, and a token whose `tenantId` is not the caller's. A time that was never offered has no valid token, so §12 rule 1 stops being a claim about how the model behaves and becomes a property of the system.

**Stateless rather than a table**, deliberately: no rows, no cleanup job, and the TTL bounds the exposure. The trade is that a token cannot be revoked when the slot is taken in the meantime — which is acceptable *because the token was never the availability guarantee*. The `no_double_booking` constraint is. The token guarantees only "we offered this"; the constraint independently guarantees "this is still free". Two claims, two mechanisms, neither standing in for the other.

New environment variable → `.env.example`, `docs/SETUP.md` and `docs/DEPLOY.md` all updated in the same PR.

---

## 6. Schema changes — checkpoint 1

| Change | Source |
|---|---|
| `schedule_exceptions.doctor_id` → nullable; null = all doctors | Q13 (ruled) |
| `CHECK` on `schedule_exceptions`: time nullability by type, and `start_time <> end_time` | Q11 |
| `CHECK (start_time <> end_time)` on `schedule_templates` — **not** `<`, see Q8 | Q8 (ruled) |
| `services.buffer_minutes INT NOT NULL DEFAULT 0` | Q20 |
| `MembershipRole.AI_AGENT` | ruled |
| `audit_logs.message_id UUID NULL` → `messages(id)`, `ON DELETE RESTRICT` | ruled |
| Scheduling settings as **real columns on `tenants`** | Q18/Q22/Q23 (proposed — see below) |

**Scheduling settings are columns, not JSONB.** `tenants.settings` is `Json` and every seeded tenant carries `{}` — no shape has ever been defined. Putting granularity and lead times there would be exactly the loose-type-plus-runtime-guard shape this project has already rejected once. Proposed columns:

```
slot_granularity_minutes       INT NOT NULL DEFAULT 15
booking_lead_minutes_staff     INT NOT NULL DEFAULT 0
booking_lead_minutes_patient   INT NOT NULL DEFAULT 120
booking_horizon_days           INT NOT NULL DEFAULT 90
no_show_grace_minutes          INT NOT NULL DEFAULT 30
```

Two classes rather than five sources for lead time: the real distinction is **a human standing in the clinic** (`RECEPTION`, `DOCTOR`, `WALK_IN`) versus **a remote self-service channel** (`WHATSAPP`, `ONLINE`). Five columns tracking five enum values would be four opportunities for them to disagree about the same policy. `no_show_grace_minutes` is §9's clinic-configurable grace period, given a home now rather than invented in Phase 3.

`settings` stays, and nothing scheduling-related goes into it.

---

## 7. The engine's contract

```ts
generateSlots(input: {
  timezone: string;                 // Q1 — from tenants.timezone, never defaulted
  date: string;                     // Q2 — YYYY-MM-DD, read in `timezone`
  templates: ScheduleTemplateRow[];       // Q8 — MUST cover `date` AND the day before it
  breaks: ScheduleBreakRow[];
  exceptions: ScheduleExceptionRow[];     // Q8 — likewise both days
  existingAppointments: OccupancyRow[];   // Q20 — each carries its own service buffer
  service: { durationMinutes: number; bufferMinutes: number };
  granularityMinutes: number;       // Q18 — server-resolved
  leadMinutes: number;              // Q22 — per source
  now: Date;                        // never read from the clock
}): Slot[]
```

**Q8's second condition, as it turned out.** The contract originally said generating one day requires the previous day's templates, and Q8b then made that false — noticed while implementing, not while writing. Under session anchoring a session belongs to the day it *began* on, so a 22:00–02:00 Thursday clinic is returned whole when Thursday is queried and not at all when Friday is. The previous day's templates have nothing to contribute, and a service fetching two weekdays of them would have been doing it for no reason.

**Appointments are the exception and still need the wider net** (Q17): one booked in Wednesday night's tail occupies real time on Thursday's calendar date, so occupancy is fetched by range overlap across the surrounding days, never by `scheduled_start` falling on `date`.

**Order of operations**, correcting §9's prose in the same PR:

1. Resolve the weekday of `date` in `timezone` (Q5)
2. Expand templates valid on `date` into wall-clock windows **anchored to `date`**; a window whose `end_time <= start_time` runs past midnight into the next calendar day but still belongs to this session. Union overlaps (Q6, Q7, Q8)
3. Union in `EXTRA_AVAILABILITY` windows, same anchoring (Q14)
4. Subtract breaks (Q10)
5. Subtract `BLOCKED` and `HOLIDAY` — these win, and they apply to the session's **anchor** date (Q12, Q8b)
6. Keep only windows anchored to `date` (Q8b, ruled)
7. Convert the resulting free windows to instants through `timezone`, applying Q3's nonexistent/ambiguous rules (Q3)
8. Subtract occupied ranges under `engineOccupies`, **in instant space** (Q15, Q16, Q20)
9. From each window start, step by `granularityMinutes` (Q19); keep `[t, t + duration]` **only if it fits entirely inside that window**
10. Drop any slot starting at or before `now + leadMinutes` (Q21, Q22)

**Steps 7 and 8 are in this order deliberately, and were written the other way round first.** Subtracting occupancy before converting to instants is a bug: on the evening the clocks go back, an appointment at 23:30 EEST and another at 23:30 EET are an hour apart in real time and *identical* in wall clock, so a wall-clock subtraction removes both occurrences when only one is booked — silently deleting a bookable half hour on the one night of the year hardest to notice it. Occupancy is instants; it is subtracted as instants.

Step 9 is where §9 as written is wrong: slots have no length before the service is applied, and "chop into granularity-sized pieces, discard the short ones" gives different results for any duration that is not a multiple of the granularity.

Steps 2 and 8 are where the DST cases live, and they are deliberately far apart: expansion is pure wall-clock arithmetic that cannot fail, and every timezone hazard is concentrated in one conversion step that the Q3 tests target directly.

**Forbidden inside `domain/`:** any import from `src/prisma/`, any `@nestjs/*`, `node:fs`, `new Date(`, `Date.now(`, and the literal `Africa/Cairo`. Enforced by a source-scanning spec, and proven by breaking it (§10).

---

## 8. Endpoints

```
GET    /doctors
POST   /doctors
PATCH  /doctors/:id
GET    /services
POST   /services
PATCH  /services/:id

GET    /doctors/:id/schedule                       templates + breaks + exceptions
PUT    /doctors/:id/schedule/templates
POST   /doctors/:id/schedule/exceptions
DELETE /doctors/:id/schedule/exceptions/:exId

GET    /availability      ?doctorId&serviceId&date        → Slot[] with tokens
GET    /schedule/day      ?date[&doctorId]                → describeDay()

POST   /appointments                                       takes a slot token
PATCH  /appointments/:id/reschedule                        takes a slot token
PATCH  /appointments/:id/cancel                            requires a reason
GET    /appointments      ?date&doctorId
```

`GET /availability` and `POST /appointments` are the two that Phase 7 wraps as `find_available_slots()` and `create_appointment()`. Neither controller may contain logic the tool layer would not see.

---

## 9. Required tests

**Written first, before the cross-midnight feature** (Q8, condition 3)
- 2026-04-24, nonexistent local hour: a 22:00–02:00 template on 23 April yields **no** slot in 00:00–01:00, and the session resumes at 01:00 EEST
- 2026-10-29, ambiguous local hour: a 22:00–02:00 template on 29 October yields **two** distinct instants for each wall-clock time in 23:00–24:00, distinguishable by offset
- Both assert the UTC instants in §4/Q3, not local strings — a local string is exactly what cannot tell the two 23:30s apart

These are red until step 2 and step 8 of §7 exist. That is the point: they specify the feature rather than defending it afterwards.

**Slot engine — blocks the phase if red**
- Exhaustive table-driven cases over §7's ten steps
- **Cross-midnight**: a session spanning midnight produces a continuous run of slots; a `BLOCKED` on the anchor date removes the post-midnight tail too; an engine given only one day's templates produces a smaller result than one given two (the §7 contract, asserted rather than commented)
- Weekday convention: Sunday = 0, derived in the tenant timezone, for a tenant not in UTC
- Shuffled inputs produce identical output (Q27)
- Every boundary: slot ending exactly at window close, break touching a window edge, `valid_to` on both sides

**Purity — blocks the phase if red**
- Source scan of `domain/` for every forbidden import and literal in §7
- Every `domain/` spec passes under `npm run test:no-dotenv`

**Occupancy**
- `constraintOccupies` asserted against the `no_double_booking` predicate read from `pg_constraint`, not against a copy of the SQL pasted into the test
- The **whole** constraint definition asserted, exclusion key included — see below for why the predicate alone is not enough
- `engineOccupies` differs from it on exactly the `allow_overlap` case, and a test says so

**Concurrency — the phase gate**
- N parallel bookings of one slot: exactly one succeeds; the rest receive `23P01`, mapped to 409, never a 500

**Permissions and scoping**
- Cross-tenant 404 on every new endpoint
- **`own`-scoped routes are tested on the query, not the guard** — a DOCTOR editing another doctor's schedule gets 404. This is Phase 1's carried-forward item 2, and Phase 2 is the first phase with a real `own` resource
- `appointments.overrideSlotConflict` is `own` for DOCTOR, and the override records authoriser and reason (D3)

**Slot token**
- Forged signature, expired token, and a token minted for another tenant are all rejected
- Booking uses the token's values, not the request body's — verified by sending a body that disagrees

**State machine**
- Every cell of `AppointmentStatus × event`, including the illegal ones

---

## 10. Definition of Done

Phase 2 is complete when **all** of these are true. Not most.

- [x] Migration applied; every §6 change present, with each `CHECK` constraint proven by an insert that violates it — verified on a scratch database, then applied to dev and CI
- [x] `generateSlots()` contains no I/O, no clock read, and no timezone literal — proven by the source scan, and the scan proven by breaking it four ways (prisma import, `@nestjs` import, `new Date()`, `"Africa/Cairo"`): 26 passed → 1 failed each time, all reverted
- [x] Slot engine suite exhaustive, green, and runnable with no database and no `.env` — 406 unit tests via `npm run test:no-dotenv`
- [x] The two DST tests were **committed red, before the cross-midnight feature**, and the commit history shows it — `44461be` (7 failed) then `1c6f239` (green), with no existing assertion edited
- [x] A 22:00–02:00 template is representable, bookable, and correct across both 2026 Egyptian transitions — and away from them (`slot-engine-boundaries.spec.ts`)
- [x] A post-midnight slot belongs to the session that began it, not to the calendar day it falls in — asserted for both DST dates and for an ordinary week (Q8b)
- [x] Boot fails if `Africa/Cairo` resolves to UTC — `assertTimezoneDataAvailable()`, called before any port is bound. Two branches, because either alone is passable: a runtime resolving the zone to UTC, and one reporting the same offset in January and July. A container serving wrong times is worse than one that will not start
- [x] `constraintOccupies` verified against the live constraint predicate read from Postgres — `pg_get_constraintdef()` supplies the `WHERE` tail, **Postgres evaluates it** over every status × `allow_overlap` pair, and the truth table is compared with the TypeScript one. Proven by breaking both sides: dropping `NO_SHOW` from the TypeScript set failed 2 of 3, and rewriting the SQL to `status <> 'CANCELLED'` failed the same 2. **This establishes that the two predicates agree, not that the constraint is right** — the exclusion key is asserted by a separate check, added after a wrong constraint passed this one (§4/Q16)
- [x] Concurrency test: N parallel bookings, exactly one winner, losers get 409 — `booking-concurrency.integration.spec.ts`, 8 in flight. Losers are asserted to fail for the *right* reason (`SLOT_TAKEN`), and a second test books a different slot so a constraint that rejected everything could not pass. **This line said “stable over three consecutive runs”; that was true when measured and is not true in general — see §17, an open defect where booking *throws* instead of refusing, roughly one run in ten.** The tick stands for the property being tested, not for the suite being reliable.
- [x] A doctor cannot read or edit another doctor's schedule — 404, tested on the query. `schedules-own-scope.integration.spec.ts` asserts *indistinguishability*: a colleague's id and an id that never existed return identical responses. Proven by deleting the membership comparison — 11 passed → 2 failed → 11 passed. This closes PHASE-1's carried-forward item 2
- [x] Slot token: forged, expired and foreign-tenant tokens rejected; body values ignored in favour of the token's — `slot-token.spec.ts`, including an edited payload with the original signature, and a valid token presented for another tenant
- [x] `SLOT_TOKEN_SECRET` in `.env.example`, `docs/SETUP.md` and `docs/DEPLOY.md` — and in `ci.yml` and the `run-without-dotenv` CI-parity list, without which the integration suite passes locally and cannot load on CI
- [x] `ARCHITECTURE.md` §9's slot-engine signature and order of operations corrected in the same PR that implements them
- [x] Seed produces schedules, services and appointments for both tenants — **with different counts per tenant** (2/1 doctors, 4/3 services, 10/5 templates, 4/2 exceptions). Exceptions were added because both clinics had zero, which meant the engine's `BLOCKED` / `HOLIDAY` / `EXTRA_AVAILABILITY` handling and Q13's clinic-wide `doctor_id IS NULL` had never run against a real database
- [x] Every endpoint in §8 returns 404, not 403, for a cross-tenant id — enumerated rather than sampled, and list endpoints asserted not to leak either
- [ ] Founder reviews the schedule editor and the day view, one screen at a time
- [x] CI green on the branch before the PR opens — and on every commit since; PR #22 has never been opened or updated on a red branch

---

## 11. Checkpoints

Stop and wait for review at each:

1. **Schema** — the §6 migration, before any service code
2. **Slot engine** — `domain/` complete with its suite green, before any endpoint exists
3. **Endpoints** — including the concurrency gate
4. **Frontend** — schedule editor first, day view second, reviewed separately

**Checkpoint 2 reached 2026-08-28.** `domain/` is complete — `day-plan` (the shared computation), `generate-slots`, `describe-day`, `transition`, `occupancy`, `interval`, `zoned-time`, `types`. Eight files, largest 201 lines, importing nothing outside the directory. 406 unit tests and 130 integration tests green. No endpoint, controller, service or DTO exists yet, by design.

Checkpoint 2 is deliberately its own stop. The engine is the only part of this phase whose correctness is provable without the founder's eyes, and it is the part everything else inherits.

---

## 11b. Two findings from checkpoint 3

**`tenants` is scoped by neither layer of tenant isolation.** The scoping extension classifies
`Tenant` as `"none"` — it has no `tenant_id` column, because it *is* the tenant — and it carries no
RLS policy. So an unfiltered `tenant.findMany()` inside `withTenant()` returns **every clinic in
the database**: 173 rows, in the test database, from a call that looked correctly scoped because it
was inside the sanctioned wrapper.

The service now reads it with `findUnique({ where: { id: tenantId } })`, the id coming from the
validated JWT and nowhere else. What makes this worth recording is the failure mode avoided: taking
`[0]` from that list would have applied a stranger's slot granularity, lead times and no-show grace
period to this clinic — a cross-tenant read producing numbers that still look like numbers, which
no assertion about slot counts would ever have caught. It surfaced only because the code asserted
the row count instead of trusting it.

**The Prisma error shape for `23P01` is not what the documentation suggests.** Prisma 7 with the
`pg` adapter raises `PrismaClientKnownRequestError` with its own `code` of `P2039`, and buries the
Postgres code at `meta.driverAdapterError.cause.code`. The first implementation checked
`error.code` and `error.meta.code`, matched neither, and rethrew.

That one failed loudly, but only because a concurrency test existed. Nothing else in the suite
reaches that branch, so without the phase gate every loser of a booking race would have become a
500 in production while CI stayed green. The check now also matches the **constraint name**: `23P01`
only means "some exclusion constraint refused this row", and a future one — a room or a device —
reported to a patient as "that time was just taken" would be a confident lie.

---

## 11c. Checkpoint 3, and what enabling RLS on `tenants` pulled in

Adding the D22 policy made `audit-triggers.integration.spec.ts` fail, and that was the conformance
test doing its job. It derives its expectation structurally — *every table with RLS carries a
`<table>_audit` trigger* — so enabling RLS silently created an obligation, and the test noticed a
decision being made by omission.

The right answer was to audit the table rather than add an exception. `tenants` holds the clinic's
name, phone, address, status and, since this phase, its scheduling policy: changing
`no_show_grace_minutes` changes when patients are marked absent, and changing `status` suspends a
clinic. Those are the administrative acts §8 restricts to OWNER and ADMIN.

Two constraints shaped how: `audit_row_change()` reads `NEW.tenant_id`, which this table does not
have, so it needed its own function using `NEW.id`; and the trigger fires on **UPDATE only**,
because creating a clinic is structurally unbound and an actor-requiring trigger would make the
seed, the fixtures and any future provisioning script impossible.

It immediately caught a real unbound write — an existing test suspending a tenant through a bare
`prisma.tenant.update()` — which now binds an actor like every other tenant-scoped write.

The audit trigger count in that spec moved from 29 to 30. That number is the point of the test: it
is the thing that fails when someone adds a table and forgets the trigger list.

---

## 12. Flagged, not absorbed

1. **`AI_AGENT` as a `MembershipRole` needs a permission row.** `permissions.ts` is keyed by `MembershipRole`, so adding the enum value forces a decision on all twenty capabilities. §12 rule 2 says only "strictly narrower than a receptionist's" — the actual column is a Phase 7 conversation, but the enum lands here and the matrix will not compile without it.
2. **Reads are not audited — settled, not carried.** §12 rule 3 said "every tool call is written to `audit_logs`", and that was already false: D16's triggers fire on INSERT/UPDATE/DELETE, so `find_available_slots()` has never left a row. Ruled 2026-08-28: **availability lookups are not audited**, and §12 rule 3 is amended to "every tool call that writes". Auditing every availability query would produce more rows than the appointments themselves, for a read that discloses nothing a patient could not learn by phoning the clinic. The AI's **writes** must carry `message_id`, and that is the part worth having. The amendment is in `ARCHITECTURE.md` §12 — rule 3 is no longer aspirational.
3. **Phase 1's loose ends are inherited unchanged:** ESLint still blocked on TypeScript 7, Jest still not exiting cleanly after the integration suite, and the entire frontend still never rendered by WebKit — which the founder's iPhone-first expectation makes the largest of the three.

---

## 13. Handoff — state as of 2026-08-28

Written for a session starting cold. Read `CLAUDE.md` and §7 of this document first; everything below assumes them.

### What is merged on `develop`

| PR | What landed |
|---|---|
| #21 | Phase 2 scope, the §6 migration, `ARCHITECTURE.md` §9 corrections |
| #22 | The slot engine, the appointments service and endpoints, doctors/services/schedules endpoints, D22 and D23 |

`develop` is at `253fad7`. **424 unit + 150 integration tests**, green with `.env` stripped. CI green on every commit.

Backend Phase 2 is complete. The Definition of Done has **one** unticked item, and it is the founder's review of two screens.

### ⚠️ PR #20 is open, conflicting, and duplicates work

**`feature/doctors-services-schedules`**, opened 27 August by an earlier session, titled "Doctors, services and schedules — with own-level scoping in the query". It was CI-green when opened and is now `CONFLICTING` / `DIRTY`.

It solves the same problem as checkpoint 3 by a **different structure**, and the two cannot both land:

| | PR #20 | merged in #22 |
|---|---|---|
| Module layout | one `modules/scheduling/` | `modules/doctors/`, `modules/services/`, `modules/schedules/` |
| Own-scoping test | `schedules-own-scoping.integration.spec.ts` | `schedules-own-scope.integration.spec.ts` |
| SQL slot | claims `prisma/sql/13-service-type-consultation.sql` | `13-` is taken by `13-scheduling-and-ai-actor.sql` |

It also carries something #22 does **not**: a migration adding a `CONSULTATION` value to `ServiceType`. That change may still be wanted on its own.

**This is a decision for the founder, not a cleanup task.** Do not close or force-merge it. The options are to salvage the `ServiceType` change as a fresh migration (`16-`) and close #20, or to review both implementations and pick one deliberately. Whoever picks it up should read #20's diff before assuming #22 superseded it — the duplication happened because neither session knew about the other's branch.

### Where the calendar UI starts

Checkpoint 4. **Schedule editor first, day view second, reviewed separately** — the founder reviews one screen at a time, so do not build both and present them together.

Everything the frontend needs already exists and is tested. No backend work should be necessary; if a screen seems to need a new endpoint, that is a finding worth raising rather than quietly adding one.

**Screen 1 — the schedule editor**, per doctor.

```
GET    /doctors                                   list, for the picker
GET    /doctors/:doctorId/schedule                templates + breaks + exceptions
PUT    /doctors/:doctorId/schedule/templates      replaces the whole set
POST   /doctors/:doctorId/schedule/exceptions     body doctorId:null = clinic-wide
DELETE /doctors/:doctorId/schedule/exceptions/:exceptionId
```

Four things the UI has to get right, all of them consequences of decisions already made:

1. **Weekday is JS `getDay()`, Sunday = 0** (Q5). The Egyptian week starts Saturday, so the *display* order is Saturday-first while the *value* is unchanged. Do not renumber.
2. **`endTime` may be earlier than `startTime`** — that is a session crossing midnight (Q8), not a validation error. The editor must let a user enter 22:00–02:00 and should show it as spanning two days. Only `start == end` is refused.
3. **Templates are replaced as a set**, because overlap is a property of the set. The editor holds a working copy and PUTs all of it.
4. **A clinic-wide exception is `doctorId: null`** (Q13), and a DOCTOR-role user cannot create one — the API answers 404, so the UI should not offer the control to them.

**Screen 2 — the day view.**

```
GET /schedule/day?doctorId&date        working windows, busy blocks, free gaps
GET /availability?doctorId&serviceId&date   bookable slots, each with a token
POST /appointments                     takes slotToken + patientId
PATCH /appointments/:id/cancel         requires a reason
PATCH /appointments/:id/reschedule     takes a slotToken
PATCH /appointments/:id/confirm
```

`describeDay()` returns `working`, `busy` (with `appointmentId`, so blocks are clickable), `free`, and `fullyBooked` — that last one distinguishes "the doctor is fully booked" from "the doctor does not work today", which an empty list cannot.

Two rules the booking flow must not break:

- **Book with the token, never with a time.** `POST /appointments` has no field naming a start, a doctor or a service; they come from inside the token. Do not add one.
- **A 409 is normal.** Someone else took the slot between the offer and the booking. Refresh availability and let the user pick again — this is not an error dialog.

**Rendering times.** Every slot carries `utcOffsetMinutes`. On the evening the clocks go back, two slots share a wall-clock label an hour apart; without showing the offset (or a "second occurrence" marker) they look like a duplicate. This is rare — one evening a year, and only for a clinic working past 23:00 — but the data is there because the engine emits both.

**RTL and logical properties.** `test/unit/web-logical-properties.spec.ts` fails the build on any physical `left`/`right` in `apps/web`. That is deliberate; write `inline-start`/`inline-end`.

### One local-environment note

The dev database will not show the newly seeded schedule exceptions: the seed detects existing clinics and stops, and append-only audit rows make the tenants undeletable. Seeing them needs `docker compose down -v`, `npx prisma migrate deploy`, `npm run seed`. Verified on a throwaway database instead — 4 and 2, all three types, one clinic-wide.

### Inherited loose ends, unchanged

ESLint still blocked on TypeScript 7; Jest still does not exit cleanly after the integration suite; the frontend has still never been rendered by WebKit, which the iPhone-first expectation makes the largest of the three.

---

## 14. Calendar feed — design only, awaiting a ruling

**Not built.** This section answers the three questions asked before it may be.

The starting point is agreed: **not Google Calendar sync.** That is an OAuth integration with stored refresh tokens and two-way reconciliation, and more importantly it sends patient names to Google — under PDPL, health data reaching a third-party processor with no agreement in place. That is a legal question, not a feature, and it is not one engineering gets to answer.

A plain `.ics` **download** is also rejected, for a different reason: it is a snapshot. Cancel an appointment and the doctor's calendar stays wrong, silently, until they notice a patient who is not coming. A calendar that is confidently out of date is worse than no calendar.

So the proposal is a **subscription URL** — a secret link the doctor adds once, which their calendar re-fetches on its own schedule. No OAuth, no stored third-party tokens, and the data never leaves our infrastructure. What it costs is an unauthenticated URL that exposes a doctor's schedule, which is what the three questions below are about.

### 1. The token: what it is, how it is revoked, and what it is scoped to

**Per doctor, per device.** Not per doctor.

A single per-doctor URL cannot be revoked without breaking every calendar that doctor has added it to — phone, laptop, the tablet at reception. In practice that means it never gets revoked, which makes "revocable" a word in a document rather than a property of the system. One row per subscription, each with its own secret, each independently killable, and the doctor sees a list of them with a last-fetched time.

```
calendar_subscriptions
  id, tenant_id, doctor_id,
  token_hash,            -- Argon2id, never the token itself
  label,                 -- "iPhone", "Laptop" -- typed by the doctor when creating it
  created_by_user_id,
  last_fetched_at NULL, last_fetch_ip NULL,
  revoked_at NULL,
  created_at
```

The token is **32 random bytes, base64url**, generated server-side and shown **once**, at creation, exactly like the refresh-token family already in this codebase. Only a hash is stored — a leaked database backup must not yield working calendar URLs.

`last_fetched_at` and `last_fetch_ip` exist so a doctor can look at the list and recognise a subscription they do not remember creating. That is the only detection mechanism an unauthenticated URL can have.

Revocation is a row update, and a revoked token returns **404, not 403** — the same reasoning as everywhere else in this system: 403 confirms the URL was once real.

**Open question for the founder:** should a subscription expire on its own, say after a year, and require re-adding? It bounds the damage of a link leaked to someone who never uses it, at the cost of a doctor's calendar quietly emptying one day. I lean towards **no expiry, but a visible list**, because a calendar that stops working without explanation is the kind of thing that makes people abandon the system.

### 2. What the feed carries: busy blocks only

**Agreed, and worth stating why in the form the decision should be recorded.**

The feed carries `BUSY` blocks with a generic summary — "موعد" — plus start, end, and nothing else. No patient name, no phone number, no complaint, no service.

Three reasons, in order of weight:

1. **A leaked URL then exposes a work pattern, not a patient list.** That is the difference between an embarrassment and a PDPL notification event.
2. **The doctor already has the names in our app.** The calendar's job is to stop them double-booking themselves at their other clinic, and a busy block does that completely.
3. **Calendar providers cache and sync feeds to their own servers.** Whatever the feed contains ends up on Apple's or Google's infrastructure regardless of who fetches it — so the question is never "do we trust this doctor's phone", it is "what are we content to hand a third party permanently".

The one thing a busy-only feed loses is the doctor glancing at their phone to see *who* is next. That is a real loss, and the answer is that the app shows that, behind a login.

### 3. Rate limiting an unauthenticated, polled endpoint

Calendar clients poll on their own schedule and ignore anything they are not forced to respect. Apple Calendar refreshes as often as every five minutes; Google roughly every few hours and will not be told otherwise reliably.

Three layers, cheapest first:

- **`Cache-Control: private, max-age=900` and a strong `ETag`** over the feed body. A polite client then sends `If-None-Match` and gets a `304` costing one hash comparison and no query. This is the layer that does most of the work, and it costs nothing.
- **Per-token limit: 20 requests per hour**, returning `429` with `Retry-After`. Generous for any real client and far below what a scraper needs to be useful. Applied per token rather than per IP, because the token is the thing being protected and a doctor's phone changes IP constantly.
- **Per-IP limit across all tokens: 60 per hour**, which is what stops someone enumerating tokens. Guessing a 32-byte secret is not feasible, so this is defence against a *leaked list* rather than against brute force.

The existing `auth-throttle.ts` is per-identifier and per-IP already and is the right shape to extend rather than duplicate.

**One thing this design does not solve:** a leaked URL is usable until someone notices and revokes it. There is no way around that for an unauthenticated feed — it is the price of the doctor not having to log in from their calendar app. The mitigations are that it exposes only a work pattern, that each device is separately revocable, and that the list shows when each was last fetched.

### What would be built, if approved

One migration (the table), one endpoint pair (create/revoke, authenticated), one public endpoint (`GET /calendar/:token.ics`), and an RFC 5545 serialiser — roughly 120 lines, no dependency, since the format is line-folded text and the only subtlety is `DTSTART;TZID=` versus UTC.

**It stays unbuilt until the token model, the busy-only decision, and the limits above are ruled on.**

---

## 15. Why the weekly cards do not update until you save

They look like they should. Change the working hours or the weekly day off, and the seven cards at
the top of the schedule screen sit still until the save button is pressed. Every instinct says that
is a missing feature, and the next person to read this file will reach for live updating as an
obvious improvement.

**It is not an improvement. It is the one change that would break the guarantee this phase spent
its whole length protecting.**

The cards render `describeDay()` output fetched from `GET /schedule/range`. The inputs above them
write to local React state. Those are two different sources, and the server's is the authoritative
one — it is the same computation the booking flow cuts availability from, asserted equal day by day
by `schedule-range.integration.spec.ts`.

To make the cards move before a save, there are exactly three options:

1. **Add `pattern` to the fetch effect's dependencies.** This does nothing useful. The request
   returns server state, and the server knows nothing about unsaved changes — so the cards refetch
   and redraw identically. It costs a request per keystroke and changes no pixel.
2. **Compute the week in the browser** from the local template set. This works, and it is a
   **second implementation of availability**. The moment it exists, the calendar and the booking
   flow can disagree, with nothing on screen to say which is lying — the exact failure
   `describeDay()` and `planDay()` were factored to prevent, and which the range endpoint's
   conformance test exists to catch.
3. **Post the unsaved templates to the server for a preview computation.** Correct, and honest, and
   a new endpoint that accepts unsaved data purely to render a hint.

So the screen is built on the founder's proposal — explicit save, cards reflect what was saved —
and the reason is stronger than the simplicity that motivated it. **Option 2 is the tempting one
and it is the one that must not be taken.** If a future reader wants live cards, option 3 is the
only door; it is more work than it looks and buys a preview of something that is one click away.

The save path is already wired for this: `onSave()` calls `refresh()`, which replaces `baseline`
with a fresh array from the server, and the fetch effect depends on `baseline` — so a successful
save always refetches and the cards always move. They are never stale until a manual reload.

---

## 16. Notifications, with sound — design only, awaiting a ruling

**Not built.** Four questions, answered.

### 1. Where do notifications come from?

**Their own table. Not `audit_logs`.** The tempting answer is the wrong one, and it is worth saying why at length because `audit_logs` already records every mutation with an actor, a tenant and a timestamp.

1. **It is append-only by trigger (D5).** Read state is a mutation, so a `read_at` column there could never be written. Read state would need a second table keyed by audit-row id — at which point the second table exists anyway, in a worse shape.
2. **It is written by a trigger, not by application code.** The trigger knows a row changed; it does not know *why*. A reschedule and a cancellation are both `UPDATE` on `appointments`, so telling them apart means diffing `previous_state` against `new_state` — a second, weaker copy of the state machine `transition()` already owns.
3. **It carries clinical content.** Those JSONB columns are whole-row snapshots, so a visit's `diagnosis` is in there. Anything reading `audit_logs` to render a UI is one careless `select` away from putting a diagnosis in a reception notification — the exact thing CLAUDE.md separates by endpoint and DTO rather than by filtering.
4. **Retention differs.** Audit rows are kept because a regulator may ask. Notifications are ephemeral UI state that should be prunable. Coupling them means keeping notifications forever or making the audit trail deletable.

```
notifications
  id, tenant_id, kind, appointment_id NULL, patient_id NULL,
  actor_user_id, source, occurred_at, payload jsonb, created_at

notification_reads
  id, tenant_id, notification_id, membership_id, read_at
  UNIQUE (notification_id, membership_id)
```

Written by the appointments service **in the same transaction as the change**, so a booking that rolls back cannot leave a notification claiming it happened. `payload` holds only what the list renders and never clinical content.

**Read state is per membership, not per user.** A person can hold memberships in two clinics (`ARCHITECTURE.md` §4 — the seeded دينا does), so per-user read state would mark a notification read at one clinic by reading it at the other. A separate table rather than a column because one notification has many recipients — reception, admin and the doctor may all see one booking — and one column cannot hold three people's read state.

**Marking read is a write, and D16 audits writes.** So `notification_reads` needs an explicit audit exemption or opening the bell buries the audit trail in UI noise. I propose exempting it, on the same reasoning that exempts `audit_logs` itself: it records that someone *looked*, not that anything changed. That is a ruling I want rather than a thing I assume.

### 2. What counts as notifiable?

A **closed enum**, so adding a kind is a deliberate act rather than a side effect of a new write path:

| Kind | Fires when |
|---|---|
| `APPOINTMENT_BOOKED` | a new appointment, any source |
| `APPOINTMENT_CANCELLED` | the `CANCEL` transition — carries the reason §9 already requires |
| `APPOINTMENT_RESCHEDULED` | the `RESCHEDULED` event — carries the old and the new start |

Deliberately excluded: **queue movement** (reception is watching the queue board when it happens — a notification for something already on screen is noise by construction), **schedule and settings edits** (made by the person who would be notified), **anything clinical**, and **`NO_SHOW`** (produced by a nightly job, so it arrives in a batch when nobody is looking, and the day view shows it the next morning).

Visibility follows §8 rather than inventing a second rule: a notification is visible to a membership holding `appointments.write` in its tenant.

### 3. Sound, and the autoplay problem

**This is the question that makes sound different from a badge, and it has no clean answer — only an honest one.**

Browsers block audio until the page has been interacted with. A notification arriving before the receptionist's first click is silent, and it is silent *without telling anyone* — `play()` returns a rejected promise that most code ignores. So the first alert of the day is exactly the one at risk, which is the worst possible one to lose.

Three parts:

- **Never rely on sound alone.** The badge and the title-bar count are the real notification; sound is an accelerator. If audio is blocked, nothing is lost except speed. This is the part that makes the rest acceptable.
- **Unlock deliberately, at login.** The login button is a real user gesture, so `audio.play()` on a silent buffer at that moment satisfies the autoplay policy for the session. Reception signs in once at the start of the day, which is precisely when the unlock is needed and precisely when a gesture is guaranteed.
- **Detect the failure and say so.** `play()` returns a promise; when it rejects, show a one-line, dismissible banner — "الصوت متوقف — اضغط لتفعيله" — with a button that retries inside a click. **Never a silent failure.** A clinic that believes it will be alerted and is not is worse off than one that knows sound is off.

### 4. On by default, or off?

**Off by default.** Reception is a shared, quiet, public-facing room, and a system that starts making noise on a stranger's desk is a system they will resent before they trust it. The cost of off-by-default is a clinic that never discovers the feature — which the banner in §3 addresses by making the toggle visible on the day they first want it.

Persisted **per user, per device**, in `localStorage`. Not on the server: whether sound is appropriate depends on the room the browser is in, not on who the person is — the same receptionist wants sound at the front desk and silence on a laptop in a consulting room. A server-side preference would follow them into the wrong room.

### 5. Delivery: polling still holds

`ARCHITECTURE.md` §1 and the locked decisions in CLAUDE.md put realtime at **15-second polling, not SSE**, in V1. That still holds for notifications, and the reasoning is stronger here than for the queue board:

- The bell polls one cheap count endpoint. With an `ETag`, an unchanged count is a `304` and no query.
- SSE means a held-open connection per tab, through Caddy, with reconnection handling and a per-tenant fan-out — real infrastructure for a feature whose value is measured in seconds.
- **The latency a receptionist would accept is not the latency of the notification, it is the latency of the patient.** A WhatsApp booking that appears within fifteen seconds is indistinguishable from instant, because nobody is standing at the desk waiting for it. The one case that feels slow — a patient physically present while reception books — is not a notification case at all, since the receptionist is the one doing the booking.

So: **15-second poll of `GET /notifications/count`**, with the list fetched only when the bell is opened. If a clinic ever reports that fifteen seconds feels slow, that is a measurement worth having before spending SSE's complexity.

### What this needs before code

Four rulings: the notifiable set (particularly whether `NO_SHOW` belongs), the audit exemption for `notification_reads`, sound off by default, and 15-second polling. **Nothing is built until those are settled.**

---

## 17. RESOLVED — `bookAppointment` sometimes threw instead of returning `SLOT_TAKEN`

**Found 2026-08-29. Diagnosed and fixed 2026-09-06. It was never test flakiness.**

### Why this one matters more than its failure rate suggests

It sits on **the exact path a real clinic hits when two receptionists book at once.** Losing that
race is designed behaviour: the loser is supposed to get `SLOT_TAKEN`, which the controller maps to
409 and which reads as "that time was just taken, ask again". When `bookAppointment` throws
instead, the loser gets an unhandled error — **a 500, telling a receptionist the system is broken
when in fact the world merely moved on.**

That is the whole reason `SLOT_TAKEN` exists as a value rather than an exception, and this defect
defeats it intermittently. A clinic will meet it on a busy morning, which is precisely when nobody
can afford to wonder whether the system is down.

### What was known before it was diagnosed

- **It reproduces.** Roughly **one run in ten** locally, and once on CI —
  [run 33256221701](https://github.com/amirra7al-gif/clinic-os/actions/runs/33256221701), on a
  **docs-only branch**, against code that had passed the identical suite an hour earlier
  (run 33255504626). Nothing in that diff touches booking, which is what rules out a regression and
  establishes the failure as pre-existing and intermittent.
- **The shape.** `Promise.all` over N concurrent `bookAppointment` calls **rejects**, rather than
  resolving with one winner and N-1 refusals. So at least one call threw an error that
  `isDoubleBookingViolation()` did not recognise.
- **The cascade.** Two later tests in the same file depend on the row the first one creates, so a
  single throw fails three tests. The count in a red run is not three independent problems.
- **What it is not.** The ordinary `23P01` path is confirmed working: forcing the throw branch
  prints `PrismaClientKnownRequestError` / `P2039` with
  `meta.driverAdapterError.cause.code = "23P01"` and the constraint name, which
  `isDoubleBookingViolation()` matches correctly. **Whatever fires here is a different error
  shape** — a serialization failure, a deadlock, a pool or connection error under load are the
  candidates, none of them yet observed. **It was the deadlock**; see below.

### Why it went undiagnosed for a week, and what was done about that

The original failures carried **no error detail at all**: under `Promise.all`, jest reported only
the `await` on the line and nothing about what was thrown. Twenty-six further local runs produced
no reproduction and therefore no information.

So the test was changed to stop losing the evidence. `booking-concurrency.integration.spec.ts` now
uses `Promise.allSettled` and asserts on the rejections **as data** — name, code, message and meta
— so the next occurrence names its own cause instead of costing another afternoon. Verified by
deliberately forcing the throw path and confirming the assertion prints the full error including
the SQLSTATE, then reverting.

**The next red run on this spec is the fix's starting point.** Read its assertion output first; do
not re-run the suite until it goes green. *That is exactly how it was diagnosed, eight days later.*

### Diagnosed and fixed, 2026-09-06

**The cause is `40P01`, deadlock detected**, raised by the `no_double_booking` exclusion constraint.
The instrumentation above did its job: the next red run named it, on CI run 34020776505, on a branch
whose diff was scripts, a unit spec, `package.json` and two documentation files.

```
PrismaClientKnownRequestError P2039
  meta.driverAdapterError.cause.code = "40P01"   "deadlock detected"
  detail: "Process 257 waits for ShareLock on transaction 1715; blocked by process 258."
```

**Why an exclusion constraint can deadlock where a unique index does not.** A unique index gets
Postgres's speculative-insertion treatment; an exclusion constraint does not. A conflicting inserter
writes its index entry *first* and only then scans for conflicts, so two transactions can each see
the other's entry and each wait on the other's transaction id. Postgres detects the cycle and kills
one, arbitrarily.

**A reproducer was built before the fix**, on the founder's instruction: *"it's the only way to know
the fix works rather than that the symptom stopped appearing."* Two transactions take two different
slots in opposite order, with a barrier so both have inserted their first row before either attempts
its second. Deterministic — 5 for 5 before any fix existed, where the concurrency suite reproduced
about one run in ten. It lives in `booking-deadlock.integration.spec.ts`.

### The ruling on what to answer, 2026-09-06

**A `409 SLOT_TAKEN` would have been a lie.** A deadlock says nothing about the slot. The abort
establishes only that the victim's own writes are gone; whether the slot is gone depends on what the
*other* transaction did, and the error carries nothing about that. The founder's framing: *"the
loser lost a coin toss, not the slot."* Often true, never established — and D23 forbids exactly that
kind of confident claim.

**So the answer is a retry, and its purpose is not to make the booking succeed — it is to replace a
guess with an answer.** The second attempt either books the slot, or meets the committed conflict
and returns a `SLOT_TAKEN` that has actually been verified.

**Three attempts, jittered 40 ms and 80 ms (±50%), then a distinct refusal.** Each deadlock
resolution removes exactly one transaction from the cycle and the survivor settles within
milliseconds, so a retry has to outlast one resolution rather than a queue of them; real contention
for a single slot is two people, occasionally three, and the suite's eight is a stress figure. The
jitter is load-bearing: a fixed delay re-synchronises the transactions that just collided and
marches them into the same collision.

**The backoff is not what the wait costs, and the first draft of this section said otherwise.** It
claimed a worst case of "roughly 180 ms" by counting only the delays. `deadlock_timeout` is `1s` on
this cluster — measured, not assumed — and Postgres does not look for a cycle until a transaction
has been blocked that long, so **each deadlock costs about a second to detect** and three attempts
is a little over three seconds before a `CONTENDED` refusal. Corrected here rather than quietly
adjusted: the number is what the trade should be judged on, and a receptionist waiting two seconds
for a correct answer is better served than one waiting one second to be told the system is broken.
It is also why the count stays at three — each further attempt is another whole second, spent only
in the rare case where a retry deadlocks again.

**A consequence worth knowing before it surprises somebody.** The eight-way test in
`booking-concurrency.integration.spec.ts` now needs an explicit timeout: its assertions are
unchanged, but with detection costing a second per deadlock, jest's 5-second default is no longer a
sensible budget for a deliberate stress case. Lowering `deadlock_timeout` on the cluster would cut
the wait and costs CPU on every lock acquisition; that is a server-configuration decision and has
not been taken.

After three attempts the answer is **`CONTENDED`**, not `SLOT_TAKEN` — *"too many people are booking
this slot at once"* — also mapped to 409, because the caller's next move is identical and a 5xx would
say the server is broken, which is the false sentence this whole change removes.

### What must not be done — amended, not deleted

- **"Do not add a retry" was right for what was known then, and is now scoped rather than
  reversed.** The rule read: *"Retrying a booking that may already have succeeded is how a patient
  gets two appointments."* That remains true of a timeout, a dropped connection or a pool error —
  all of which leave the caller unable to say whether the transaction committed. **`40P01` is
  different in kind**: Postgres rolls the victim back *completely* before raising it, so there is no
  "may already have succeeded". `booking-deadlock.integration.spec.ts` asserts that directly — every
  row the victim wrote is gone, and none of the survivor's are. Retry `40P01`, and nothing else,
  through `retryOnDeadlock` in `src/prisma/deadlock-retry.ts`.
- **Do not widen `isDoubleBookingViolation()` to catch more error shapes.** Unchanged. `40P01` got
  its own narrow classifier rather than being folded into that one, for the reason the rule gives.
- **Do not apply the retry inside `withTenant`.** A blanket retry would silently re-run every
  transaction in the API, including ones whose side effects nobody has reasoned about. Whether an
  operation is safe to repeat is a judgement per operation, so it is applied at `bookAppointment` and
  `rescheduleAppointment` and nowhere else.
- **Do not mark the test skipped or retried to get CI green.** Unchanged, and it never was.

---

## 18. Status colours — ruled 2026-08-29

```
BOOKED           amber            not yet confirmed
CONFIRMED        green, lightest
ARRIVED          green, mid
WAITING          green, darkest
IN_CONSULTATION  light grey       in with the doctor right now
COMPLETED        no fill          outline and neutral text only
CANCELLED        red, struck through
NO_SHOW          red
```

**The three greens are placed on measured lightness, not chosen by eye.** L\* 93.0 / 68.9 / 44.9 —
an even 24 points per step — on the existing `--color-success` hue, added as `--color-green-soft`,
`-mid`, `-strong` and `-ink`. Three pale tints was the obvious first cut and they were not
separable at chip size, which is why the darkest step is a solid fill with white text rather than a
third wash. The founder asked to be told if the steps could not be distinguished rather than be
shipped three shades nobody can tell apart; widening the spacing is that answer.

**CANCELLED is struck through; NO_SHOW is not.** Both are red, so colour stopped separating them,
and reception has to: one patient told us, one vanished, and only the second is worth chasing. A
strike-through means *unmade*, which is what a cancellation is — a no-show is the opposite shape,
the slot stood and nobody came, so striking it out would say the wrong thing. It was also the
cheapest of the three candidates: an icon needs a legend and eats width a chip does not have, and a
second word needs translating and wraps. The strike-through costs no width and survives a greyscale
print, which the red does not.

**Two facts worth keeping next to each other.**

`CANCELLED` and `NO_SHOW` release the slot, so no busy block is ever built for them and the red pair
**cannot appear on a timeline at all** — the distinction only ever has to work in a list. That is
asserted in `slot-engine-boundaries.spec.ts` rather than left as a comment, because the fact is
decided in `occupancy.ts` and depended on by a component three directories away.

`ARRIVED`, `WAITING` and `IN_CONSULTATION` are **not reachable from the application today.** §2
puts the queue transitions in Phase 3 and Phase 2's endpoints expose only `CONFIRMED` and
`CANCELLED`. The colours are implemented and correct; producing those states needs the queue. They
were set directly on the review database to review the ramp.

**A correction this ruling forced.** `index.css` claimed every status colour survives a greyscale
print. That had never been measured and is false: the pale tier — `COMPLETED`, `BOOKED`,
`IN_CONSULTATION`, `CANCELLED`, `NO_SHOW` — sits between L\* 92.6 and 100, so on paper those are
one colour and the badge's text label is what separates them. The comment now says so.
