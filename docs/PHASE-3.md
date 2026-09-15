# Phase 3 — Reception and the queue

**Status: ruled 2026-08-29.** §4 records each decision and the reasoning it was made on. Three
questions are deliberately left open and are marked so.

Phase gate, from `ARCHITECTURE.md`: **a real receptionist reaches competence in under ten minutes.**
That is the only acceptance criterion here that is not a test, and it is the one that matters. Every
question in §4 is answered against it.

---

## 1. Scope

The screen a receptionist has open all day, and the state changes that move a patient through it.

- **Check-in and the queue** — `ARRIVED`, `WAITING`, `IN_CONSULTATION`, `COMPLETED`. These four are
  the three statuses that have no endpoints today plus the terminal one that closes them.
- **Walk-in registration** — a patient with no appointment, registered and queued in one flow.
- **No-show marking** — the manual action, the nightly job, and the grace period that already has a
  column (`tenants.no_show_grace_minutes`, default 30).
- **The today dashboard** — the landing screen for reception.
- **The patient detail screen** (`/patients/:id`) — identity, contact, visit history metadata,
  appointment history and outstanding balance. **Added 2026-09-01 by founder ruling.** His reason:
  *"a queue you can't click through from is a list, not a workflow"*, and reception hits that wall
  on day one. Tight by ruling: **no editing, no clinical content, no attachments.** Scope and the
  two boundary requirements are Q18.
- **Patient transfers** — moving a patient's care from one doctor to another, and what the
  receiving doctor may then read. **Added 2026-09-01 by founder ruling**, after this document was
  written: *"transfers ARE in Phase 3 ... the document was written before the requirement existed,
  and it's the document that's out of date, not the requirement."* The two amendments he attached
  are recorded as Q16 and Q17. The rest of the design is **not** recorded anywhere and is the
  blocking question in §9.

## 2. Out of scope

Visit screen · prescriptions · payments · reports · public booking page · WhatsApp · the AI tool
layer.

**Two boundary calls that are judgement, not omission:**

**`COMPLETE` ships here even though the visit screen does not.** Completing is a queue action — it
is how a patient leaves the queue — and without it the queue only fills. The visit *record* that
Phase 4 writes is a different object; `appointments 1:0..1 visits` already allows an appointment
with no visit row. What ships here is the transition, not the clinical content.

**The dashboard ships without money.** `ARCHITECTURE.md` specifies three figures — today's patients,
today's revenue, outstanding balance — and two of the three need payments, which the founder has put
in Phase 4. See Q10: the honest options are a dashboard with one number, or a dashboard with
non-financial numbers of its own.

**Amended 2026-09-01: "payments" out of scope means *recording* them, not *reading* a balance.**
Q18 puts a patient's outstanding balance on the detail screen, read from the `remaining_minor`
generated column. Recording, adjusting, discounting and refunding all remain Phase 4. This is
narrower than it sounds — one derived figure on one screen — but it does undercut half of Q10's
stated reason for a dashboard without money, which is flagged in §9 rather than silently
reinterpreted.

---

## 3. What is already true

Worth stating plainly, because it makes this phase much smaller than it looks and because two of
these were built in Phase 2 specifically so this phase would not have to.

| | |
|---|---|
| **The state machine** | `domain/transition.ts` implements all seven events over the complete matrix, including `MARK_WAITING`, `START_CONSULTATION`, `COMPLETE` and `MARK_NO_SHOW`, with the grace period inside it. It is pure, total, and tested. Phase 2 exposed only `CONFIRM` and `CANCEL`. **This phase adds endpoints, not logic.** |
| **The queue timestamps** | `arrived_at`, `waiting_started_at`, `consultation_started_at`, `consultation_ended_at` all exist on `appointments`. |
| **The grace period** | `tenants.no_show_grace_minutes INT DEFAULT 30`. |
| **The walk-in source** | `AppointmentSource.WALK_IN` exists. `ARCHITECTURE.md`: "a walk-in still creates an appointment row, so every visit has an appointment. This keeps the queue model uniform." |
| **History** | `appointment_events` is append-only (D5) and already records `from_status`/`to_status`/`actor_user_id`. Every queue action writes one. |
| **The non-human actor** | `system_actor_id()` exists as a real seeded row that cannot log in. The nightly job has an actor without inventing one. |
| **Status colours** | Ruled 2026-08-29, `PHASE-2.md` §18. `ARRIVED`, `WAITING` and `IN_CONSULTATION` are already coloured and already unreachable — this phase is what makes them reachable. |
| **Permissions** | `appointments.write` is FULL for OWNER, ADMIN, DOCTOR and RECEPTIONIST, which matches `ARCHITECTURE.md`'s "Check-in / queue actions ✓ ✓ ✓ ✓". Q13 asks whether queue actions should share that permission or get their own. |

**One contradiction, now fixed.** `ARCHITECTURE.md`'s locked-decisions table said "Server-Sent
Events — Queue board only needs server→client push", while `CLAUDE.md` locks polling and that same
document's own Reception row says "Polling every 15s, not SSE". Two of the three agreed, so the
table was the stale one — **and it is the one people read first**, which is exactly what made it
worth correcting rather than working around. Corrected in the same commit as this ruling, with a
note in the table saying when it changed and why.

---

## 4. Questions and rulings

Twenty-six. Twenty-four are ruled; Q3 is deliberately left open for the pilot doctor and Q19
waits on a decision. §9 lists what remains genuinely uncertain inside the ruled ones.

### Q1. What refreshes the queue, and how often? — **RULED: 5s visible, paused when hidden**

**Ruled by the founder, 2026-08-29.** Five seconds while `document.visibilityState === "visible"`,
the timer stopped entirely when hidden, and one immediate refetch on becoming visible again.

The deciding argument was what staleness *costs* on each screen, not what polling costs the server:
a stale notification bell lags, which is annoying; a stale queue makes two people call the same
patient. The queue is also the screen with the highest chance of two people acting at once, because
it is the one everybody has open all day.

Pausing on hidden matters at least as much as the interval. A backgrounded tab left overnight would
otherwise poll 5,760 times to learn nothing.

The interval is a named constant next to the notification one, with both spelled out, so the
difference reads as a decision rather than a typo.

**Not SSE**, and the reason is recorded rather than left implicit: `CLAUDE.md` locks polling for V1,
SSE through the deployed reverse proxy is unproven, and this phase's gate is a receptionist's first
ten minutes rather than latency. If 5s ever proves insufficient, that is a measurement worth having
before spending SSE's complexity.

### Q2. Two clients holding different ideas of the queue — **RULED: compare-and-set**

**Ruled by the founder, 2026-08-29.** Compare-and-set on the row, a refusal in human words, and a
refresh after every mutation.

It is worth keeping the distinction that produced this, because it is what rules out the obvious
fix. The booking race is a **conflict over one resource**: two clients want one slot, exactly one
may win, and `no_double_booking` arbitrates. The queue race is **two clients editing different
rows**: reception checks in patient A while the doctor completes patient B, both writes *should*
succeed, and only the view diverges. A queue-level version would therefore manufacture conflicts
between actions that do not conflict, and reception would be told to reload while doing nothing
wrong.

The real risk is the **stale action taken from the stale view**, so:

1. **`expectedStatus` on every queue mutation.** If the row has moved on, refuse with
   `QUEUE_MOVED_ON` and return the current status. A compare-and-set on one row, not a lock.
2. **The refusal is written for a receptionist**: "Dr Hisham already started this patient" — the
   actor and the new state, read from the `appointment_events` row — not "ILLEGAL_TRANSITION from
   IN_CONSULTATION".
3. **Refresh after every mutation**, so a stale window is bounded by one request rather than by one
   poll interval.

**The case the state machine structurally cannot catch**, and the reason compare-and-set is not
merely nicer error handling: `ARRIVED → WAITING` applied twice by two clients is *legal both times*.
`transition()` sees a legal edge on each call and approves both. Without a compare-and-set the
second silently overwrites the first one's `waiting_started_at`, and the queue's ordering — which
Q3 may well base on those timestamps — quietly changes with nothing anywhere recording that it did.

### Q3. What orders the queue? — **OPEN. For the pilot doctor.**

**Deliberately unresolved**, on the founder's ruling of 2026-08-29: this is a question to answer by
watching a real reception desk, not by reasoning.

The two candidates and their costs are recorded so the observation has something to test:

- **Arrival time** (`arrived_at` ascending, walk-ins uniform with everyone else). Matches the
  physical fact of a waiting room. A patient who has sat for forty minutes watching later arrivals
  go in will not accept "your appointment was later". **Cost:** a punctual patient can be seen after
  a late one who happened to arrive first.
- **Scheduled time** (`scheduled_start` ascending, walk-ins by arrival among their peers). Fair by
  the appointment book, and rewards punctuality. **Cost:** unfair by the waiting room, which is the
  room the argument happens in.

**What to build meanwhile:** the ordering is a single named function over the queue rows, with no
caller depending on which rule it implements. Switching it after the pilot must be one edit and a
changed test, not a redesign. It ships defaulting to **arrival time**, which is reversible; the
point of the flag is that nobody should mistake the default for a finding.

**What to watch for at the pilot:** whether reception ever re-orders by hand, and what they say when
a punctual patient is called after a late one.

### Q4. Does a walk-in occupy a slot? — **RULED: yes, as an authorised overlap**

A walk-in arrives at 11:20 with nothing free until 12:00. Booking them into 12:00 tells a patient
standing in front of you to come back in forty minutes; a null `scheduled_start` is impossible,
since the column is `NOT NULL` and the day view, slot engine and exclusion constraint all assume it.

So: the appointment is created **at the check-in instant with `allow_overlap = true`**,
`scheduled_end` = that plus the service duration, `overlap_reason` naming it as a walk-in and
`overlap_authorised_by_user_id` recording who let them in. This reuses machinery built and proven in
Phase 2 rather than inventing a parallel path, and `engineOccupies` already treats an authorised
overlap as taken.

**Consequence accepted explicitly:** every walk-in is an authorised overlap, so overlaps stop being
rare. If overlap is ever surfaced as an exception report, walk-ins will dominate it and must be
excluded by source — recorded here so that report is not written in surprise.

### Q5. What is the minimum to register a walk-in? — **RULED: name and phone**

Name and phone; everything else optional and editable afterwards. Phone stays required because it is
the deduplication key and the WhatsApp channel depends on it later. `ARCHITECTURE.md` already rules
the other fields nullable — "a walk-in registration will not have a date of birth, and a required
field means staff invent one" (founder, 21 Aug 2026). The flow searches existing patients first and
offers *create new* only after a search, matching the Phase 2 patient search.

**The patient with no phone** — a child, an elderly parent brought in by family — is a real case and
must not be made unrepresentable. It needs no schema change: `patients.phone_e164` is **not unique**,
so the accompanying person's number is recorded and two patients share it legitimately.

**The consequence that must be handled rather than discovered:** searching by phone can return
several patients, so the search UI must present a list and never assume a single match. Recorded in
§7 as a test.

### Q6. Is `ARRIVED → WAITING` a separate action? — **RULED: one button, two writes**

Check-in performs `ARRIVE` then `MARK_WAITING` in the same transaction, writing both timestamps and
both `appointment_events` rows. Two buttons for one human event fails a gate measured in ten minutes
to competence.

The distinction survives where it matters — `arrived_at` and `waiting_started_at` are separate
columns and remain separately queryable — and `ARRIVED` stays a real state that the machine can
express, for the case where a clinic later wants a distinct arrival desk.

### Q7. Should `IN_CONSULTATION` be exclusive per doctor? — **RULED: no. Surface it, do not refuse.**

**This reverses the draft's proposal.** The draft argued for refusing `START_CONSULTATION` when the
doctor already has one in progress. That is a constraint that makes a real clinic situation
unrepresentable — a doctor stepping out to do a quick dressing change while a consultation is open
is ordinary, not an abuse — and this project's standing rule is not to design those away for the
implementation's convenience.

So a second concurrent consultation is **allowed and made visible**: the queue shows both, plainly,
for the doctor whose name is on them. Reception can see it and fix it, which is what they would do
anyway.

The failure this was meant to prevent — reception starting the wrong patient from a stale screen —
is already covered by Q2's compare-and-set, which is the correct place for it: that is a staleness
problem, not a clinical one.

### Q8. Is the no-show job automatic, or does it propose? — **RULED: it proposes. Never auto-terminal.**

**Ruled by the founder, 2026-08-29, and this is deliberate — it is recorded at length because
someone will later propose automating it as an efficiency.**

The nightly job marks nothing. It produces a list of candidates — appointments past their grace
period that were never checked in — and **a human confirms each one**. Only `MARK_NO_SHOW` from a
person writes the terminal status.

**Why automating it is wrong, in the founder's own case:** the doctor is running ninety minutes
late, the patient is sitting in the waiting room, and the grace period elapsed an hour ago measured
from `scheduled_start`. An automatic `NO_SHOW` there marks a patient absent **who is physically
present**, and because `NO_SHOW` is terminal *and* releases the slot — `constraintOccupies` treats
it as free — their time can then be given to somebody else, with no transition back.

"That is not an edge case in an Egyptian clinic, it is Tuesday." The failure is also invisible in
testing, because test data never sits in a waiting room.

**To whoever proposes automating this later:** the efficiency you are buying is a receptionist
clicking a button. The thing you are risking is telling a patient in front of you that the system
has recorded them as absent. Those are not comparable. If the grace reference from Q9 is ever made
good enough that this feels safe, it is still not safe, because the reference cannot know that
someone is in the room.

### Q9. What is the grace period measured from? — **RULED: readiness, not schedule**

`max(scheduled_start, that doctor's last consultation_ended_at) + grace`. A patient is a candidate
for absence only once the clinic was **actually ready for them**, not once the appointment book says
so.

The caller computes the reference instant and passes it in, keeping `domain/` pure.

**Correction, 2026-08-30 — this ruling was wrong about the code.** It originally claimed the change
"changes nothing about `transition()`'s shape", on the grounds that `now`, `scheduledStart` and
`noShowGraceMinutes` were already parameters. Building it disproved that: `TransitionContext` gains
an optional **`graceReference`**, and the NO_SHOW branch measures grace from it, falling back to
`scheduledStart` when it is absent.

The alternative — having the queue pass the readiness instant *in* as `scheduledStart` — would
indeed have needed no code change, and was rejected. It would leave a parameter named
`scheduledStart` holding something that is not the scheduled start, so every later reader of
`transition()` would be misled by a field name, and the refusal message would say "scheduled start
plus 30 minutes" about an instant that was neither. A named optional field costs one line and tells
the truth; the refusal text now names which reference it used.

**The change is backward-compatible**: `graceReference` is optional and defaults to
`scheduledStart`, so every pre-existing caller behaves exactly as before, which the unchanged
appointment tests demonstrate.

Recorded here rather than absorbed because `§7`'s Definition of Done requires it: *"`transition()`
unchanged … any change to the state machine is a finding to report, not a routine edit."* This is
that report. The state machine's **matrix** is untouched — no edge was added, removed or
re-targeted; what changed is where one existing guard reads its reference instant from.

Under Q8 this governs which candidates appear on a list a human reviews rather than who gets marked
automatically, so the stakes are lower — but a list full of patients who are visibly present is a
list reception stops reading, which is its own failure.

### Q10. What is on the today dashboard? — **RULED: the numbers this phase can actually answer**

Booked today · checked in · still waiting · completed · current longest wait.

All five are derivable from the queue this phase is already building, and they are the numbers a
receptionist is asked for by name — "how many left?", "how long has he been waiting?". The financial
figures join them in Phase 4 rather than the screen waiting for a phase to be finished.

`ARCHITECTURE.md` names three figures, two of which need payments. It is corrected rather than
quietly contradicted.

### Q11. Is the queue per doctor or per clinic? — **RULED: one screen, grouped by doctor**

All-doctors is the default view, grouped by doctor within it. Reception works the room, not a
doctor. A doctor's own screen filters to themselves, reusing the `own` scoping already proven in
`schedules-own-scope.integration.spec.ts` — including that a colleague's id is **indistinguishable**
from an id that never existed.

### Q12. What does "today" mean for a cross-midnight session? — **RULED: the session's day**

**Stated as a rule, not left to fall out of the implementation: the queue and the day view answer
"which day is this appointment on" with the same code.**

Phase 2 ruled that a session beginning Thursday 22:00 and ending 02:00 belongs to Thursday. The
queue must agree, or a patient seen at 00:30 vanishes from the screen they are standing in front of.
That means reusing `describeDay()`'s notion of the day rather than `date_trunc('day',
scheduled_start)`, which is the tempting and wrong shortcut.

### Q13. Do queue actions need their own permission? — **RULED: reuse `appointments.write`. REVISED 2026-09-03 for COMPLETE only.**

No new permission. `appointments.write` is FULL for all four human roles, which matches
`ARCHITECTURE.md`'s "Check-in / queue actions ✓ ✓ ✓ ✓". Adding `queue.act` with an identical matrix
would be a distinction with no difference and one more row for the permission conformance test to
keep true. If a clinic ever wants a receptionist who books but cannot check in, that is the moment
to split it — not before.

#### Revised 2026-09-03: `COMPLETE` is the doctor's, and only `COMPLETE`

**The original ruling stands for what it decided.** It said the moment to split would be a clinic
wanting a receptionist who books but cannot check in — and that is still not why this split
happened, so this is a revision on a ground Q13 did not consider rather than a correction of it.
Saying so matters: read as a mistake, it teaches that Q13 was careless, and it was not.

**What surfaced.** The queue offered reception أنهِ الكشف and the API answered **200**. Both layers
agreed, and the screen was faithfully reflecting the matrix — so this was case (b), a matrix
decision to change deliberately, not a UI defect to patch. Q20 is why that distinction was worth
establishing before touching anything: a UI change resembling a permission fix is worse than none,
because it removes the symptom that would have prompted the real fix.

**The founder's reason, and the sharper version of it.** Completing a visit is a clinical assertion
— it says the doctor finished and recorded their notes. Reception ending it can close a visit while
the doctor still has an unsaved draft open. And under `PHASE-4.md` Q6, ruled the day before, it does
more than close a queue row: `COMPLETE` is what **finalises the record**, after which the doctor
adding a forgotten sentence must file a `visit_revisions` row *with a reason*. So a receptionist
tidying the board could force a doctor into an amendment to finish a sentence they were mid-way
through typing. That argument only exists because Phase 4 was ruled first.

**What changed.**

| | |
|---|---|
| Check-in, start, no-show | `appointments.queueActions` — FULL for all four human roles, unchanged in effect |
| `IN_CONSULTATION → COMPLETED` | **`appointments.completeVisit` — `DOCTOR` only**, including not OWNER or ADMIN: the assertion is about who saw the patient, and an owner who is not the treating clinician is in reception's position |
| Queue reads (`/queue/today`, `/no-shows/pending`) | still `appointments.write` — reading the board is not acting on it |

**A dead capability died in the process.** `appointments.queueActions` already existed in the matrix
and was consumed by **no route at all** — Q24 found it and said *"either wire it or delete it;
leaving it is how a future reader concludes queue actions are separately gated when they are not."*
Wiring it removed its entry from the no-consumer registry, which the registry's own test enforces in
both directions.

`nextMove()` in the queue screen now takes the capability, so the board stops offering an action the
API refuses — read from the permission summary rather than `role === "DOCTOR"`, because a role test
in the frontend is a second copy of the §8 matrix that drifts the first time the matrix moves.

`ARCHITECTURE.md` §8 was split in the same change. Leaving it saying "Check-in / queue actions
✓ ✓ ✓ ✓" would have left the document people read first contradicting the code.

**Proven by breaking it:** restoring `appointments.completeVisit` to FULL for everyone turns the new
test red with `Expected: 403, Received: 200`. Restored, 16/16.

#### The finding underneath it: the queue's actions were computed from status alone

Worth separating from the ruling, because it is a different kind of defect and the more transferable
one.

`nextMove()` was `status → action` — a pure function of the row's state, **with no role or
capability input of any kind**, since the day the queue screen was built. Every action was offered
to every role. The API refused correctly throughout, so nothing leaked and no patient record moved
that should not have; but the screen was offering actions it had no basis to offer.

**A correction to the first framing of this, made rather than transcribed.** It is tempting to say
the UI had no permission awareness at all. It is not true, and writing it down would send the next
reader to add checks that already exist. Checked on 2026-09-03, the frontend consults
`me.permissions` in four places: the sidebar (`navigation.ts`, filtered by capability per item), the
notification bell (`AppShell.tsx`, gated on `appointments.write`), the schedule editor's clinic-wide
controls (`SchedulesPage.tsx`, `doctorSchedules.manage === "full"`), and the exception list, whose
own comment explains that this is a display decision and the server enforces. Permission awareness
existed at the **navigation** layer and was absent at the **action** layer.

**And the reason it went unnoticed for the whole of Phase 3 is the part worth keeping.** Until this
ruling, *every queue action was `FULL` for all four human roles*. A capability input would have been
dead code — there was no role for which the answer differed. So the missing dimension was not an
oversight that happened to survive review; it was **invisible, because nothing could distinguish a
function that consults permissions from one that does not when every caller holds every
permission.**

That is the same shape as two other findings in this project, and naming the family is the point:

- Q25 — `appointments.write` being `FULL` for everyone is what hid the day-view scoping hole. The
  matrix said there was nothing to enforce, so nothing enforced it.
- D7's Definition-of-Done line — a behavioural test cannot distinguish reading `remaining_minor`
  from recomputing it, because a `STORED` generated column can never disagree with its own
  expression.

**Uniformity conceals a missing distinction.** Wherever every input currently produces the same
answer, code that ignores the input is indistinguishable from code that honours it — and it becomes
wrong silently, on the day the answers start to differ, which is exactly the day someone changes a
matrix. The defence is not more vigilance: it is to notice when a rule is uniform and treat that
uniformity as unproven rather than as evidence.

### Q14. Does the nightly job need BullMQ? — **RULED: deferred with reason, not skipped**

**Ruled by the founder, 2026-08-29.** Because Q8 makes the job *propose* rather than act, it is a
read that produces a list. A read needs no scheduler, no worker, and no broker: `GET
/no-shows/pending` answers it on demand, and the dashboard shows the count.

**BullMQ and Redis remain locked decisions and are deferred, not dropped.** They arrive with
WhatsApp, which genuinely needs what a job queue provides — durability across restarts, retries with
backoff, and delivery of work that must not be lost. Nothing in Phase 3 has that shape.

Recorded this way so the absence reads as a decision. A later reader finding "Jobs | BullMQ + Redis"
in `CLAUDE.md` and no BullMQ in the tree should find this paragraph and not conclude it was
forgotten.

### Q15. Can a completed appointment be re-opened? — **RULED: no, not in Phase 3**

`COMPLETED` is terminal and `transition()` refuses every event out of it. `ARCHITECTURE.md` says
re-opening is "an admin action that writes a `visit_revisions` row" — but `visits` is Phase 4, so
that row has nothing to attach to yet.

The correction for a wrongly-completed patient is an `appointment_events` row of type `NOTE_ADDED`
recording the mistake, and the patient is re-queued as a walk-in. Ugly and honest, and it does not
invent a mechanism that Phase 4 will immediately replace.

---

### Q16. Where does the pending appointment go on transfer? — **RULED: it stays put**

Founder's amendment, 2026-09-01: **the pending appointment stays in the original doctor's queue.**

A transfer changes who looks after the patient going forward; it does not silently reshuffle today's
board. Reception has already told the patient a time and a doctor, and a queue that rearranges
itself underneath the desk is exactly the failure the queue screen exists to prevent. The receiving
doctor picks the patient up from the next appointment onward.

This has a consequence worth stating: for as long as that appointment is open, **the originating
doctor is still the treating doctor for it**, which is what makes the Q17 access window necessary
rather than merely convenient.

### Q17. How long does the receiving doctor's access last? — **RULED: episode-scoped, with a window**

Founder's amendment, 2026-09-01: **transfer access is episode-scoped rather than permanent, with a
stated window.**

Permanent access would mean one transfer, once, grants a doctor standing read of another doctor's
clinical record for that patient forever — which is a quiet repeal of the strongest rule in
`CLAUDE.md` ("clinical content is doctor-only, enforced by separate endpoints and separate DTOs").
Scoping it to the episode keeps the grant proportionate to the reason it was given.

**What is ruled here is the shape, not the values.** Three things this amendment names are not yet
defined anywhere in the project, and none of them can be chosen silently — see §9:

- **What an episode *is*.** There is no `episodes` table and no episode concept in the schema. The
  nearest existing thing is `treatment_plans`, which already carries `patient_id`, `doctor_id`, a
  status and a start — a plausible anchor, but a guess until ruled. `visits` is a single encounter
  and is too narrow.
- **The window.** "A stated window" states that there is one, not what it is. Days from the
  transfer? Until the episode's status closes? Both, whichever comes first?
- **What the access actually grants.** Read of the originating doctor's `visits` clinical columns is
  the obvious reading, and it is the one that touches `CLAUDE.md`'s doctor-only rule head on.

Two acceptance criteria are already fixed regardless of how those are answered, and are in §7: a
pending request is visible to both doctors *and* reception, and the expiry is proven by a test that
watches access be lost rather than gained.

### Q18. What is on the patient detail screen, and what must never be? — **RULED: tight, and the §8 boundary is the point**

Founder's ruling, 2026-09-01. **On it:** identity, contact, visit history *metadata*, appointment
history, outstanding balance. **Not on it:** editing, clinical content, attachments.

This is the first screen on which the §8 clinical visibility split becomes *visible* to a user, and
he named two things that must be right because of it.

**1. Reception sees visit dates, doctor, service and status — never diagnosis, never prescription
items.** `ARCHITECTURE.md` §8 already settles the mechanism: endpoint separation, not field
filtering, because "one careless `select: *` or a forgotten serializer and the whole record goes
over the wire". The endpoints exist and the matrix already enforces it —
`GET /patients/:id/visits` is `visits.readIndex` (FULL for all four staff roles, metadata only),
while `clinical-summary` and `clinical-history` are `visits.readContent`, which is **NONE for
OWNER, ADMIN and RECEPTIONIST and FULL only for DOCTOR**. He asked for the proof by name: **a test
that a reception token cannot retrieve clinical content through this route.** That is the
deliverable, not the decorator.

~~What does *not* exist is the proof.~~ **Struck 2026-09-03, and struck rather than deleted because
it was already false when it was written on 2026-09-01** — this is exactly the kind of sentence that
sends a session to rebuild something finished, and correcting it silently would reset the clock on
that failure. `clinical-access.integration.spec.ts` case 3, *"is refused both levels at the route,
by the permission matrix"*, predates it; so does `patients-http.integration.spec.ts:155`, which
already asserted metadata-only visit history under a `RECEPTIONIST` token. What was genuinely
missing was a proof covering the **new** Q18 routes — now in
`patient-detail.integration.spec.ts`, with twelve reception-facing endpoints swept by
`clinical-leak-guard.integration.spec.ts`.

**2. Outstanding balance comes from `remaining_minor`, the generated column — never recomputed in
the service.** This is D7 applied rather than restated: `remaining_minor` is
`GENERATED ALWAYS AS (amount_due_minor - amount_paid_minor) STORED`, and D7's reasoning is that
application-computed derived money drifts, silently, financially, and is "discovered by a customer".
A service that recomputes the same subtraction is precisely the drift the column exists to prevent,
and it would look correct in review.

Most of the backend is already built: `GET /patients/:id` (`patients.write`) and
`GET /patients/:id/visits` (`visits.readIndex`) both shipped in Phase 1. The genuinely new server
work is the outstanding balance and the appointment history; the rest of the checkpoint is a screen.

### Q19. Does the patient detail screen show transfer state? — **OPEN. Founder's question, my answer below.**

His question, 2026-09-01: *"A patient mid-transfer is a real state reception will be looking at, and
if the detail page doesn't show it, they'll wonder why the queue and the profile disagree."*

**Recommended: yes, and it follows from a criterion he has already set.** §7 requires that a pending
transfer be visible from the originating doctor's screen, the receiving doctor's screen **and
reception's**. The patient detail screen is a reception surface, and it is the one place that claims
to answer "what is going on with this patient" in full. A profile that omits an active transfer is
not neutral — it is a screen that quietly disagrees with the queue, which is worse than a screen
that never claimed to know.

What it should show is bounded by Q17 and therefore not yet decidable: at most that a transfer is
pending or active, between which two doctors, and when the access window closes. **Not** anything
the transfer grants access *to* — that would put clinical content on a reception screen through the
side door, which is exactly what Q18's first requirement forbids.

Left OPEN rather than ruled because it depends on the transfer design that §9 says is still missing.
**The ordering he chose already resolves the dependency**: transfers are checkpoint 8 and patient
detail is checkpoint 9, so transfers land first and this screen can show the state from its first
commit rather than gaining it in a later patch.

### Q20. A named failure shape: ownership checked on write, open on read — **RULED: name it, and test the read verb**

Founder's instruction, 2026-09-01, after the server-side scoping landed. The shape is worth a name
because it is not a bug in one endpoint; it is a bias in how ownership gets tested.

**The sequence, named honestly.** PR #29 removed the doctor selector from the day view and the
schedule editor. The screens then looked correct while the reads behind them stayed open — a doctor
who edited a query parameter still got a colleague's data, 200. The founder's ruling on that shape:
**a UI change that resembles a permission fix is worse than no change, because it stops anyone
looking.** No-change leaves the symptom visible and someone eventually pulls the thread; a hidden
control removes the symptom and leaves the hole, and the next person to arrive sees a screen that
behaves properly.

**Correction, 2026-09-01 — the first version of this note was wrong, and it was wrong in the way
this project keeps punishing.** It said the suite hid the hole because *every ownership test asserted
a mutation and no read was ever tested*. That was written from a plausible-sounding framing without
checking it, and the repository disproves it in one file:
`schedules-own-scope.integration.spec.ts:146`, **"cannot read a colleague's schedule, and cannot tell
it exists"** — a read-side ownership test, present before any of this work, whose own docstring calls
itself *"the heart of it: the guard allowed this request; the scoping is in the query."* The read
verb was tested. Leaving the original claim standing would have taught every future reader a lesson
that is not true, in a document they cannot check against a session transcript.

**What actually hid it: the gap was module-shaped, and the permission matrix drew the module
boundary.** `doctorSchedules.manage` is `DOCTOR: OWN` in `common/permissions.ts`, so the schedules
module was written knowing it had a scope to enforce — it got `resolveWritableDoctor()`, and it got
tests on **both** verbs. `appointments.write` is `DOCTOR: FULL`, so the day view, the week grid, the
queue and the no-show list were written as though no scope existed. They had no ownership tests
because they had no ownership enforcement, and they had no ownership enforcement because **the matrix
said there was nothing to enforce.**

**The root cause is one capability doing two jobs.** `appointments.write` means both *may act on the
queue* — where `DOCTOR: FULL` is correct and deliberate, matching `ARCHITECTURE.md`'s "check-in /
queue actions ✓ ✓ ✓ ✓" — and *may read any doctor's day*, where it is wrong. The `FULL` that is right
for the first silently authorised the second, and no reviewer reading either the matrix or the
endpoints would see a contradiction, because there is only one word there.

So the transferable lesson is not "test the read verb". It is: **where a capability governs more
than one kind of act, its level is only correct for one of them.** A capability whose name is a verb
(`write`) but which also gates reads is the shape to look for. The fix that would have prevented all
of this is a separate capability for reading another doctor's day — which is now the open question in
§9, because changing the matrix is the founder's call.

**Two corrections to the record, because the pattern is right and one instance was not:**

- `GET /doctors/:doctorId/schedule` was **already scoped and already tested**, before any of this
  work — `getDoctorSchedule()` calls `resolveWritableDoctor()` (`schedules.service.ts:120`) and
  `schedules-own-scope.integration.spec.ts:146` asserts the read refusal. The read-side case added to
  `own-doctor-scoping.integration.spec.ts` is therefore a **duplicate**, kept only because it
  exercises the route through the combined controller set. It closed no gap, and this note previously
  claimed it did.
- The endpoint that actually was open is **`GET /no-shows/pending`**, and it was missed by the first
  audit for an instructive reason: **it takes no `doctorId` at all.** An audit framed as "every
  endpoint that accepts a `doctorId`" structurally cannot see an endpoint that accepts none and
  returns every doctor's patients by name. The founder's wider instruction — audit every `GET` that
  takes an id, and assume the pattern until proven otherwise — is what found it.

The rule that follows, and it is general: **an `own`-scoped resource ships with a test per verb, and
the read is the one to write first**, because it is the verb whose absence looks like nothing.

### Q21. Transfers — the design. **RULED 2026-09-01**, with one item corrected by the founder

This began as a proposal written by Claude and marked NOT RULED, because the base design Q16 and Q17
amend did not exist anywhere in the repository. The founder approved it on 2026-09-01 and **changed
one thing, for the better** — see item 2. The heading is now a ruling; the history is kept because
the difference between "reconstructed and approved" and "specified from the start" matters to anyone
weighing how firm each line is.

**1. What an episode is → the transfer record itself, not `treatment_plans`.**
A `patient_transfers` row carries the scope: `patient_id`, `from_doctor_id`, `to_doctor_id`,
`status`, `initiated_by_membership_id`, `decided_at`, `access_expires_at`. Reason: not every
transfer follows a treatment plan — a one-off referral between colleagues is the common case in a
small clinic — so anchoring to `treatment_plans` would make the ordinary transfer unrepresentable.
"Episode-scoped" then means *scoped to this transfer*, which is narrower than a clinical episode and
cannot outlive it.

**2. The window → 30 days, and expiry is COMPUTED AT READ TIME, never stored. Founder's correction.**

The proposal here was the opposite — a stored `access_expires_at` — and it was wrong. **This
correction is his, not Claude's**, recorded that way because the reasoning is what a future reader
needs and mis-crediting it would obscure where it came from:

> *"a column updated by a job that doesn't exist yet would have meant access never expiring, and
> nothing would have told us. Computing it at read time means the guarantee holds from day one."*

A grant is active when the request is `ACCEPTED` **and** `now < decided_at + window`, evaluated on
every read. There is no `EXPIRED` status and no job that writes one. Full reasoning, and the
warning for whoever later proposes a cleanup job as an optimisation, is `SCHEMA-DECISIONS.md` **D24**
— which is where the transfer rationale lives. *(It was called D22 three times in conversation; D22
is `tenants` is scoped by neither layer.)*

Thirty days remains a guess, and is now the only unexamined number in the design.

**3. What the grant permits → read of that one patient's `visits` clinical content, authored by the
from-doctor, until expiry.** Nothing else. Not the whole patient list, not other patients of that
doctor. It is the first deliberate exception to the doctor-only rule and therefore belongs in
`SCHEMA-DECISIONS.md` as **D24**, not buried in a service. Every such read writes a
`READ_SENSITIVE` audit row, which `clinical.access.ts` already does for a doctor reading another
doctor's patient.

**4. What moves, given Q16 → the care relationship, not the calendar.** The pending appointment stays
in the original doctor's queue (his ruling). Future appointments are **not** silently retargeted;
reception books the next one with the receiving doctor. A transfer changes who may read and who is
answerable going forward, and nothing about a row already on a screen.

**5. Who initiates and revokes.** Initiate: `RECEPTIONIST`, `ADMIN`, `OWNER`, and either doctor —
reception runs the desk and is usually the one told. Revoke: `ADMIN`, `OWNER`, and the from-doctor,
who is the party whose record is being opened. Needs a new capability rather than reuse; that is a
matrix change and `CLAUDE.md` requires it be asked about, which is what this section is doing.

**6. Undo → a status change to `REVOKED`, never a delete.** Medical records are never hard-deleted,
so revocation is a row and the history stays readable.

Both of §7's transfer acceptance criteria are compatible with this and neither depends on it: a
pending request is visible to both doctors and reception, and the expiry is proven by a test that
watches access be *lost*.

### Q22. Prove the hole before you build the wall - **RULED 2026-09-01**

The founder asked for a note naming a third instance of "ownership enforced on writes, missing on
reads - schedules, then templates, now visits". **Checked, and that is not what happened.** This is
the second time the framing has been asserted and the second time the repository disagrees, so it is
recorded as a correction rather than a third repetition:

| Read | Guard | Open? |
|---|---|---|
| `GET /patients/:id/visits` | `visits.readIndex`, all four staff roles | **Metadata only** - `listVisitHistory()` selects date, doctor, service, status, follow-up. No diagnosis, examination, plan or notes. Q18 *requires* reception to have exactly this |
| `GET /appointments/:id/clinical-summary` | `visits.readContent`, DOCTOR only | Open to any doctor **by deliberate ruling** - a safety summary behind a gate is one a busy doctor does not read - and every cross-doctor read writes `READ_SENSITIVE` |
| `GET /appointments/:id/clinical-history` | `visits.readContent`, DOCTOR only | **Walled**: `mayReadFullHistory = own patient && present`. A colleague's patient is refused |
| `GET /appointments/:id/detail` | `appointments.write` | Non-clinical: contact details reception needs |
| `GET /doctors/:doctorId/schedule` | `doctorSchedules.manage` = `OWN` | Scoped **and** tested, since before this work |

Clinical content was never open. The wall existed.

**But the conclusion was right, by a different mechanism, and it is the more interesting one.** The
transfer grant as specified in Q21 - "read of the patient's `visits` content authored by the
from-doctor" - granted **nothing**. Level 2 was already gated on presence, and the query behind it
is `visit.findMany({ where: { patientId } })`, *every* visit whoever wrote it. So a receiving doctor
with the patient in front of them already read the previous doctor's notes with no transfer; and
without the patient in front of them the grant was refused anyway. A door in a frame with no hinges.

**That is why the expiry test could not be written, and the founder was right that the failure was
the finding.** Expiry of a permission that grants nothing is unobservable: the test passes whatever
the implementation does, because there is no state in which the answer differs. An unfalsifiable
security test is worse than none - it is the vacuous guard this project keeps finding, wearing a
security label.

**The fix was to change what the grant relaxes: presence, not authorship.** A live grant now opens
Level 2 *without* the patient being present, which is the actual clinical need - reading the file of
a patient you are taking on, before they arrive. It cannot be manufactured (it takes a request
someone else raised and this doctor accepted), it is bounded by the computed window, and it is
audited. Expiry became observable, so the test the founder asked for exists and **fails when either
half is broken**: removing the grant door fails the two "inside the window" assertions, ignoring the
window fails the three "past the window" ones.

**The rule: before building a guard, prove the thing it guards is currently reachable without it.**
If the unguarded access cannot be made to happen, the guard grants nothing and its test cannot fail
whatever you write. This generalises the standing "prove a guard by breaking what it guards" rule
backwards by one step - that rule assumes the hole exists, and here it did not.

The thread joining this to Q20 is that both times **a label stood in for a check**: there, `FULL` in
the permission matrix meant nobody looked for a scope; here, the phrase "episode-scoped access" in a
design document meant nobody asked what it was scoping.

### Q23. The writes audit, and what a silent fix proves - **RULED 2026-09-01**

**The headline the founder asked for, with the measured numbers rather than the remembered ones.**
The read-scoping fix changed behaviour on **four** endpoints - `/queue/today`, `/schedule/day`,
`/schedule/range`, `/no-shows/pending` - and **broke nothing**. Six pre-existing integration spec
files were touched and **not one assertion changed**: every edit was the caller literal gaining
`role` and `membershipId`, which the compiler demanded. 212 tests, zero behavioural failures, on a
change that altered who can read what on four endpoints.

That is the proof, and it is stronger than a count of open endpoints. **Nothing failed because
nothing was testing the behaviour that changed.** A suite can be large, green, and completely silent
about a property it never asserts; its size is evidence about the code it exercises and no evidence
at all about the code it does not.

*(The figure "six of eight" was recalled in conversation and is not the measured one - four
endpoints, six spec files. Recorded because a number in a document outlives the conversation that
produced it.)*

#### The writes audit, since the tests that covered writes were written by the same reasoning

| Write | Guard | Ownership? |
|---|---|---|
| `PUT /doctors/:doctorId/schedule/templates` | `doctorSchedules.manage` = `OWN` | **Enforced** via `resolveWritableDoctor()`, and tested |
| `POST /doctors/:doctorId/schedule/exceptions` | same | **Enforced**, and tested |
| `DELETE .../exceptions/:exceptionId` | same | **Enforced**, and tested |
| `POST /appointments` | `appointments.write` | **None** - and structurally cannot leak: no `doctorId` in the request, it comes from the signed slot token (Q24) |
| `PATCH /appointments/:id/reschedule` \| `/cancel` \| `/confirm` | `appointments.write` | **None.** `findFirst({ where: { id } })`, tenant only |
| `PATCH /queue/:id/check-in` \| `/start` \| `/complete` \| `/no-show` | `appointments.write` | **None.** Tenant only |
| `POST /patients`, `PATCH /patients/:id` | `patients.write` | **None.** Tenant only, and correct - a patient belongs to the clinic, not a doctor |
| `POST /doctors`, `PATCH /doctors/:id`, services | `users.manage` / `services.manage` | **None needed** - `NONE` for DOCTOR, so there is no `own` case |

**So: writes are unscoped everywhere except schedules — and for reception that is deliberate and
ruled.** Q13 reuses `appointments.write` for queue actions and §3 records that it is FULL for all
four roles, matching `ARCHITECTURE.md`'s "Check-in / queue actions ✓ ✓ ✓ ✓". Reception must check in
any patient for any doctor; that is the job.

**But the same capability also lets a DOCTOR cancel, reschedule, complete or no-show a colleague's
appointment, and nobody ever decided that.** It is the Q20 finding again, now on the write side: one
capability doing two jobs, where the `FULL` that is right for reception silently authorises
doctor-on-colleague writes that were never discussed. There is no test asserting either behaviour,
because there is no rule to test. **This is a ruling the founder owes, not a defect to fix quietly** -
`ARCHITECTURE.md` may well intend it, since a covering doctor completing a colleague's consultation
is a real clinic act.

#### The reports endpoint is not "clean by accident" - it does not exist

The founder asked for an ownership test on the reports endpoint because it was correct for a reason
that was not ownership enforcement. Checked: **there is no reports endpoint at all.**
`ARCHITECTURE.md` §18 cuts the reports screen from the pilot, and `reports.financial` is a
capability in the matrix that no route, service or DTO reads. So is
`appointments.overrideSlotConflict`. **Two capabilities declare `DOCTOR: OWN` and are enforced by
nothing.**

His instinct was exactly right and applies with more force than he knew: an `own` that nothing
consumes is a promise nobody keeps, and it is worse than an absent one, because the person who
eventually builds that endpoint will find `OWN` already in the matrix and reasonably conclude the
scoping is handled. That is the Q22 pattern - a label standing in for a check - pre-loaded for a
future author.

A test on a nonexistent endpoint was impossible, so the guard is one level up:
`common/own-capability-enforcement.ts` registers every `own` capability as either *enforced* (naming
the service and the spec that proves it) or *no-endpoint-yet* (naming what is owed), and
`own-capability-enforcement.spec.ts` fails when a capability gains an `own` level and is not
classified, and when a classification outlives the `own` it described. **Proven by breaking it:**
granting `patients.merge` a `DOCTOR: OWN` made it fail immediately, naming the unclassified
capability; reverted, 536 green. Building the reports screen now requires editing that registry,
which is the moment the scoping debt becomes visible.

### Q24. Audit `create` separately - **RULED 2026-09-01**, and the instance is in the future, not the past

**The advice is right and is now standing policy.** When auditing a module for ownership, check
`create` as its own question. It is the verb people assume the route guard covers, because a create
has no existing row to compare a caller against — so there is nothing for a reviewer's eye to catch,
and the check has to be derived from something else entirely (here: the appointment the record
attaches to). Update and delete both start by loading a row, and loading a row is where an ownership
check naturally gets written.

The stakes are what make it worth a standing rule rather than a note. **A bad read leaves a trace
you can investigate; a bad create leaves a diagnosis in a medical record that another doctor will
later act on** — with an audit trail naming the author correctly, so it looks entirely legitimate.

**But the asymmetry described - update and delete guarded, create open - does not exist in this
codebase, and it is worth recording why not, because the reason is worse.** Checked on 2026-09-01
across every controller:

- `patients` has a `POST` and **no `PATCH` and no `DELETE` at all**, so there is no guarded update to
  contrast with an open create.
- `doctors` and `services` each carry `POST` and `PATCH` with the *identical* decorator
  (`users.manage`, `services.manage` — both `NONE` for DOCTOR).
- `schedules` is the only module with a `DELETE`, and its `PUT`, `POST` and `DELETE` all narrow
  through `resolveWritableDoctor()`.

**And there is no visit or prescription write path of any kind.** `visits.write` and
`prescriptions.write` appear in the permission matrix and nowhere else — no route, no service, no
DTO; the clinical module is three `GET`s. So a doctor cannot author a visit on a colleague's patient
today, because a doctor cannot author a visit at all.

**The danger is real and it is ahead of us.** Those two capabilities are `DOCTOR: FULL`, and `FULL`
is the more misleading label to inherit than `own`: `own` reads as *"scoping owed"*, `FULL` reads as
*"no scoping needed"*. Whoever writes `POST /visits` will find the matrix already saying a doctor may
write visits, and nothing will prompt the question *"on whose appointment?"*.

**Why the check was not written now.** A guard on an endpoint that does not exist cannot be proven by
breaking it, and Q22 rules that you prove the hole is reachable before building the wall. Writing an
ownership check for `POST /visits` today would be that exact error, with the added cost that the next
author would inherit a check nobody has ever seen fail.

What is written instead is the guard that *can* be proven today.
`common/own-capability-enforcement.ts` now registers **every** capability no route consumes — not
only the `own` ones — with what is owed when one lands.
`test/unit/capability-has-a-consumer.spec.ts` fails in both directions: a capability with no
consumer and no entry, and an entry still claiming "not built" once a route uses it. **Proven by
breaking it:** pointing one route at `visits.write` turned two assertions red naming it, and the
registry entry the author then reads spells out the check — one ownership test at the appointment,
covering visit and prescription together, asserting a doctor creating a visit on a colleague's
appointment gets **404**.

The sweep also found a capability that is not merely unbuilt: **`appointments.queueActions` is
consumed by nothing.** Q13 ruled that queue actions reuse `appointments.write`, the queue shipped
that way, and this entry was left in the matrix reading as a live rule. Either wire it or delete it.

---

### Q25. The fourth occurrence, and what the four have in common — **RULED 2026-09-02**

Founder's instruction, on merging PR #34: say plainly what this was, and say what the four have in
common if the commonality can be seen.

**What it was, without softening.** `requestTransfer` shipped in PR #31 with no caller-identity
check at all, on the write that creates a clinical-access grant. `appointments.write` is
`DOCTOR: FULL`, so `PermissionGuard` admitted every doctor in the tenant, and the from-doctor was
read off the appointment and never compared to the caller. A doctor could raise a transfer on a
colleague's patient naming **themselves** as the destination, then accept it — the receiving doctor
is the one who decides — and hold a thirty-day grant over a patient they had never been involved
with, audited as legitimate. `SAME_DOCTOR` does not catch it: that compares `toDoctorId` against the
*appointment's* doctor, and the attacker is neither of them.

**Not a design gap.** D24 is written, Q16, Q17 and Q21 are ruled, and none of them is ambiguous
about who may hand a patient on. Nor was the tool missing: `callerDoctorId()` sat **twenty lines
above** the hole in the same file, and `decideTransfer` and `listTransfers` — the file's other two
public methods — both called it and both scope correctly. This was one method of three, and it was
the one that mattered most, on the endpoint that is this phase's single deliberate exception to the
doctor-only clinical rule. *(The founder's framing was "a whole module with zero caller-identity
checks"; the audit found two of three methods correct. That is worse rather than better as a signal,
and it is recorded accurately here because a number in a document outlives the conversation that
made it.)*

**CI passed, the tests passed, and the founder's review passed.** All three, and none of them was
being negligent. That fact is the subject of the rest of this section.

#### The four occurrences

Reconstructed from the repository rather than from recollection, in order:

| | Where | The gap | What was already true |
|---|---|---|---|
| **1** | PR #29 — day view and schedule editor | The doctor **picker** was removed from the UI; the reads behind it stayed open. A doctor editing a query parameter still got a colleague's day, 200 | Q20's ruling: a UI change that resembles a permission fix is worse than no change, because it removes the symptom that would have prompted the real one |
| **2** | PR #30 `13a9b45` — `/schedule/day`, `/schedule/range`, `/queue/today` | Took `doctorId` straight from the request under `appointments.write` = `DOCTOR: FULL`. The queue's was **optional**, so a doctor had only to *omit* a parameter, not forge one, to receive the whole clinic | `schedules.service.ts` had had `resolveWritableDoctor()` since Phase 2, with tests on **both** verbs |
| **3** | PR #30 `c84b0ed` — `GET /no-shows/pending` | Returned every doctor's patients, by name. Missed by the audit that had just fixed #2 | That audit was framed as *"every endpoint taking a `doctorId`"*, and this endpoint takes none |
| **4** | PR #31, fixed in PR #34 — `requestTransfer` | No caller-identity check on the grant-creating write | `callerDoctorId()` was in the same file, used by both sibling methods; `common/doctor-scope.ts` existed and was written to be the one home for this rule |

#### What the four have in common

**First, the boring one, already known and still unfixed: three of the four are `appointments.write`.**
§9 has flagged since 2026-09-01 that this is one capability doing two jobs — *may act on the queue*,
where `DOCTOR: FULL` is correct and deliberate, and *may read or write against a particular doctor's
patients*, where it is not. The `FULL` that is right for the first silently authorises the second,
and a reviewer reading either the matrix or the endpoint sees no contradiction, because there is
only one word there. The matrix change is the founder's call and remains owed.

**Second, the one worth the section.** Every remedy this project built after an occurrence was keyed
to *the symptom of that occurrence*, never to the invariant — so each one was structurally incapable
of seeing the next.

- After #1, the fix was to scope the reads. A behaviour change, not a guardrail.
- After #2, the fix was `common/doctor-scope.ts`, whose own docstring says it exists so that
  "adding a fourth reader is a call to this function rather than a fourth chance to forget."
  **But calling it is voluntary.** It is a helper, and a helper cannot fail when nobody calls it.
  `requestTransfer` was the fourth reader, and it forgot.
- After #3, the recorded lesson was to audit every `GET` that takes an id. `requestTransfer` is a
  `POST`, and it takes an `appointmentId`, not a `doctorId`.
- After Q23/Q24, the guardrail was `own-capability-enforcement.ts` — a real, breakable registry, and
  the best thing built so far. **But it keys on `own` in the permission matrix.**
  `appointments.write` is `FULL`, so transfers was never in its scope.

Each remedy drew its boundary around the last hole. Occurrence 4 sat outside all four boundaries at
once: not a `GET`, no `doctorId`, not an `own` capability, and the helper optional.

**That is why CI, the tests and the review all passed, and none of them was at fault.** A missing
check leaves no artefact. Every test in the suite asserts something the code *does*; nothing asserts
what it fails to do, and an unscoped query is byte-for-byte as plausible as a scoped one. The only
test that catches this shape is a hostile one written by someone who already suspects the specific
hole — which means the test can only ever trail the discovery and can never lead it. Review has the
same property: `requestTransfer` performed five correct checks, and five careful checks read as
care. **Competence in the surrounding code is what makes the omission invisible.**

#### The ruling

The founder's standing principle applies to this project's own remedies, and so far it has not been
applied to them: *"if code is the only thing standing between a mistake and the database, it's a
comment."* A helper you must remember to call is that comment. A registry keyed on `own` is that
comment for every capability that is `FULL`. **Four occurrences is enough evidence that remembering
does not work, and the shape will recur until a new endpoint has to opt *out* of caller-identity
scoping rather than remember to opt in.**

So the fix is a guardrail on the same pattern as `own-capability-enforcement.ts` — which is proven
to work, having been broken deliberately and watched to fail — but keyed on the **route**, not on
the capability's label. Every controller route that takes a resource id must be classified: either
*caller identity enforced*, naming the service function and the spec that proves it, or
*deliberately clinic-wide*, naming the ruling that says so. Derived by scanning the controllers, so
a route that appears with no entry fails the build. That is a check that can be proven by breaking
it: add a route, watch the suite go red, revert.

**Not built in this commit, because it is a new guardrail across every module and that is a scope
decision, not a note.** Recorded here so the next occurrence is not diagnosed a fifth time from
scratch.

**One open thread.** The founder referred to a *"PATCH `doctorId` gap"* as a separate, already-fixed
defect. No distinct commit for it was found in the repository; the nearest candidates are #2 and #3
above, and the `PATCH` write paths that Q23 audited were **flagged and not fixed** — §9 still records
that a `DOCTOR` may cancel, reschedule, complete or no-show a colleague's appointment, and that the
ruling is owed. If the PATCH gap was a fifth occurrence rather than his name for one of these, this
table is short by one.

---

### Q26. The clinical leak that was not there, and the guard that now exists anyway — **RULED 2026-09-02**

The founder reported, as the finding of the session: *"`GET /queue` returned diagnosis, examination
and treatment plan to reception… invisible because the UI didn't render it."*

**Checked before changing anything, and it is not the case.** Recorded as a correction rather than
a fix, because the reasoning he attached to it is right and outlives the report.

| Claim | What the repository has |
|---|---|
| `GET /queue` | **No such route.** The queue is `GET /queue/today`; the module's other routes are four `PATCH`es and `GET /no-shows/pending` |
| It returned clinical columns | `describeQueue` selects explicitly — `id, patientId, doctorId, serviceId, status, source`, three timestamps, and `patient: { select: { fullNameAr: true } }`. No clinical column, and no unscoped relation |
| A nested include bypassed the DTO | Every `include:` in `src/modules/` is scoped by a nested `select` or names a non-clinical relation. Verified one by one: `service → bufferMinutes`; `WITH_NAME → membership.user.fullName`; `breaks` (times and a label); notifications `reads → id`; transfers `INCLUDE` (patient name, doctor names, appointment status); insurance `COVERAGE_INCLUDE` |
| Clinical columns elsewhere | `diagnosis`, `examination`, `treatmentPlan`, `doctorNotes` and `medicalHistory` appear **nowhere** in `src/modules/` outside `clinical/`, except in four comments saying they must not. `listVisitHistory` is raw SQL with an explicit seven-column list. No `visit.find*` exists outside `clinical/` |

#### But the reasoning is right, and it survived being wrong

His formulation is worth keeping verbatim: **"A DTO boundary means nothing if a relation is included
wholesale beneath it."** `ARCHITECTURE.md` §8 says *separate endpoints, separate DTOs, never filter
fields out of one response*, and a hand-written response type genuinely says nothing about what
`include: { patient: true }` drags along underneath it. A reviewer reading the DTO would see no
problem. That the codebase is currently clean is a property of sixteen individually careful call
sites, which is Q25's finding restated: **an invariant held by care rather than by a check.**

So the audit was converted into a standing guard rather than a paragraph:
`clinical-leak-guard.integration.spec.ts` writes a visit carrying five distinctive sentinel strings,
proves a **doctor** reaches all five through `clinical-history` — or the file proves nothing — and
then sweeps **ten** reception-facing endpoints as raw response text. Raw text, not field-by-field:
a nested object passes a key check and fails this one, which is exactly the failure being guarded.

#### What breaking it taught, which the audit alone would have got wrong

The guard was proven by introducing the reported leak. **The first attempt did not fail**, and that
is the useful part.

Adding `visits: { select: { diagnosis, examination, treatmentPlan } }` beneath the queue's
`patient` include changed nothing observable: `describeQueue` maps rows into `QueueEntry` field by
field, so the extra columns were fetched from Postgres and then dropped on the floor. The sweep
went red only when the fetched row was **also spread into the response**.

That distinction matters for how this class is audited in future. A nested include is not itself a
leak — it is a leak *in waiting*, harmless until someone returns the row. So "audit the includes"
is the wrong audit: it flags safe code and, more importantly, would pass a service that selects
narrowly today and is refactored to `return row` tomorrow. **The right question is what reaches the
response, which only a behavioural sweep can answer** — and it answers it for every future endpoint,
not just today's.

The list of swept routes is the load-bearing part of that file and is named as such in it: an
endpoint nobody adds to the list is an endpoint nobody sweeps. That is the same shape as
`/no-shows/pending` escaping the ownership audit of PR #30 because that audit was framed around
endpoints taking a `doctorId`, and this one takes none.

**One vacuity trap caught in the writing, recorded because it nearly shipped green.** The sweep was
first written as `test.each(receptionFacing())`, whose table is built at *collection* time — before
`beforeAll` runs. The patient and appointment ids were still `undefined`, four URLs 400'd, and a
400 contains no clinical content either. The `expect(status).toBe(200)` that sits **before** the
sentinel check is what caught it, and is why it is written in that order.

---

## 5. Schema changes

**Transfers need schema; nothing else in this phase does.** The table below is unchanged and still
true of the queue work. Patient transfers were added to §1 on 2026-09-01, after it was written, and
they cannot be built without at least a transfer record — a grant has to be stored somewhere, with
who granted it, to whom, over what episode, and until when. **That schema is not designed yet**, and
designing it depends on the Q17 rulings that do not exist. It is not listed here as a migration
because writing one now would be inventing the answer.

The queue half:

| Would have needed schema | Ruling that avoids it |
|---|---|
| Walk-ins | Q4 — `WALK_IN` and the three overlap columns exist |
| No-show sweep marker | Q8 — the job proposes, so there is nothing to mark as swept |
| BullMQ tables | Q14 — deferred with reason |
| Compare-and-set | Q2 — `expectedStatus` is a request field checked inside the existing transaction |
| A queue permission | Q13 — reuses `appointments.write` |
| Queue ordering | Q3 — ordering is derived from timestamps that already exist |

**One thing to measure rather than assume.** The queue filters by tenant, doctor and status.
`appointments (tenant_id, doctor_id, scheduled_start)` covers the first two as a prefix and may
serve it. **Run `EXPLAIN` against seeded data before adding an index** — an index nobody measured is
cargo. If one is needed it is the only migration in this phase, and it gets the checkpoint.

---

## 6. Endpoints

Same two-caller rule as Phases 1 and 2: **the service is the interface, the controller is mapping
only.** Every one of these is called by an HTTP controller today and the AI tool layer later, so
refusals are values with machine-readable reasons, never framework exceptions.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/queue/today` | The whole screen in one request. Grouped by doctor (Q11); the day is the session's day (Q12) |
| `PATCH` | `/queue/:id/check-in` | `ARRIVE` + `MARK_WAITING`, one transaction (Q6) |
| `PATCH` | `/queue/:id/start` | `START_CONSULTATION`. No exclusivity check (Q7) |
| `PATCH` | `/queue/:id/complete` | `COMPLETE` |
| `PATCH` | `/queue/:id/no-show` | `MARK_NO_SHOW`. Grace enforced in `transition()`, reference instant per Q9 |
| `POST` | `/walk-ins` | Find-or-create patient, create appointment as an authorised overlap, check in — one transaction |
| `GET` | `/no-shows/pending` | The candidate list a human confirms (Q8) |
| `GET` | `/dashboard/today` | The five figures from Q10 |
| — | *transfer endpoints* | **Not designed.** Added to scope 2026-09-01; blocked on §9's open design questions. Whatever they are, the receiving doctor's clinical read is a **separate endpoint with its own DTO**, never a widened response on an existing one — `CLAUDE.md` admits no other way to do it |

**Every mutating endpoint takes `expectedStatus`** and refuses with `QUEUE_MOVED_ON` if the row has
moved (Q2). Every endpoint returns **404, not 403**, for a cross-tenant id.

---

## 7. Definition of Done

- [ ] Every queue transition reachable through the endpoints, and every one **refused** correctly —
      the full matrix exercised through HTTP, not only through `transition()`
- [x] `transition()`'s **matrix** unchanged — no edge added, removed or re-targeted. It is *not*
      literally untouched: `f2973c4` added an optional `graceReference` field so the no-show guard
      can measure from the Q9 readiness instant instead of `scheduledStart`. Reported at Q9 rather
      than absorbed, which is what this box actually requires. Every existing caller is unaffected,
      the field being optional and defaulting to `scheduledStart`
- [x] **Compare-and-set proven under concurrency** — `queue.integration.spec.ts:172` "under
      concurrency exactly one of N identical moves wins", and through HTTP at
      `queue-endpoints.integration.spec.ts:347`, which also tells a stale action apart from a
      genuinely illegal one. **The "stable over three consecutive runs" half is not evidenced** —
      no such run has been recorded since the merge
- [x] **`ARRIVED → WAITING` twice does not silently overwrite the first `waiting_started_at`** —
      `queue.integration.spec.ts:145`, asserting the second call leaves the first timestamp equal
- [ ] A walk-in creates patient + appointment + check-in **in one transaction**; a failure at any
      step leaves no orphan patient — proven by forcing a failure at each step
- [ ] Searching by a phone shared by two patients returns both, and the UI never assumes one (Q5)
- [x] No-show cannot be applied before the grace period, measured from the **Q9 readiness instant**
      — `queue.integration.spec.ts:278` at the boundary, and the reference itself in
      `queue-domain.spec.ts:155` "transition() honours the readiness reference"
- [x] **The no-show job marks nothing** — `queue.integration.spec.ts:256` "reading the list changes
      no status and writes no history"
- [x] A no-show releases its slot and that slot is immediately bookable —
      `queue.integration.spec.ts:291`
- [ ] Queue "today" agrees with the day view for a cross-midnight session — the same Thursday-night
      clinic, asserted in both places (Q12)
- [ ] Polling pauses on a hidden tab, **proven by counting requests** rather than by reading the
      code — searched on 2026-08-31 and **no such test exists**. `apps/web/src/lib/polling.ts`
      implements it; nothing counts requests to prove it
- [x] A doctor sees only their own queue — 404, and *indistinguishable* from a nonexistent id —
      **done 2026-09-01**, and widened past the queue because the same hole was in every reader.
      `common/doctor-scope.ts` states the rule once; `own-doctor-scoping.integration.spec.ts` proves
      it over HTTP with a real `DOCTOR` token against a real colleague's id, for `/queue/today`,
      `/schedule/day` and `/schedule/range`, including that a colleague's id and a nonexistent one
      are byte-identical. Proven by breaking it: with the scoping disabled, 5 of the 20 fail and the
      four "reception still sees everything" assertions keep passing, which is what shows they test
      the scoping rather than the plumbing. The original finding follows.

      ~~**checked on 2026-09-01 and actively false.**~~ There is no role narrowing anywhere in
      `src/modules/queue/`: no `permissionLevel`, no `membershipId`, no `"own"`. `GET /queue/today`
      requires `appointments.write`, which is `DOCTOR: FULL`, and takes `doctorId` as an *optional*
      query parameter — so a doctor who omits it receives every colleague's queue, and one who
      supplies a colleague's id receives that colleague's, 200. Unlike the day view and the schedule
      editor, the queue screen has no doctor picker to hide (Q11 groups all doctors on purpose for
      reception), so there is no UI half to this: the whole fix is server-side, and the pattern to
      copy is `resolveWritableDoctor()` in `schedules.service.ts:99`
- [x] Seed produces a reviewable queue for both tenants, **with different counts per tenant**,
      including a walk-in and a past-grace no-show candidate.

      ~~Checked and actively false as of 2026-08-31.~~ **Fixed 2026-09-03.** The cause was one line
      — `const isPast = scheduledEnd < referenceDate`: binary, past or future, with nothing
      representing the reference *moment*. So `ARRIVED`, `WAITING` and `IN_CONSULTATION` were never
      written by any seed, in any tenant, ever.

      A second cause was assumed and checked before being acted on: that the window would not cover
      today. It does — appointments span 2026-06-01 to 2026-09-13, and today already had seven rows,
      all `BOOKED`/`CONFIRMED` because today sits on the future side of a 25 August reference.
      Moving the window would have left the board just as dead.

      Three bands now, on the reference day only; other days keep the original two-band behaviour,
      since a live queue last Tuesday would be nonsense. The past-grace no-show candidate is
      **guaranteed rather than rolled for** — one doctor works mornings, so a 14% weight lands on
      zero often enough that the list would be reviewable on some seeds and empty on others, and a
      fixture that is *usually* present is worse than one that never is.

      Verified against a real database rather than in unit tests alone: `clinic_os_review` re-seeded
      with today as the reference, and `GET /queue/today` returns 11 entries — `WAITING 2,
      IN_CONSULTATION 1, ARRIVED 2, CONFIRMED 4, BOOKED 2` — with 5 rows carrying a real waited
      time, 1 overdue no-show candidate, 5 walk-ins, and different counts per tenant. Determinism
      preserved: `seed-queue-states.spec.ts` asserts the same reference yields the same statuses
- [x] Arabic and English complete — enforced by the completeness test. `web-locale.spec.ts:214`
      "English is complete, because the toggle is reachable from every screen"; green in the
      541-test unit run of 1 September 2026
- [x] Every new colour utility names a real token — enforced by `web-colour-tokens.spec.ts`, and
      the guard was proven rather than trusted: `bg-amber` → `bg-amberr` made it fail naming
      `DayViewPage.tsx:76`, reverted and it passes
- [ ] Every guard added in this phase proven by breaking what it guards, with the contrast recorded
- [ ] `ARCHITECTURE.md` corrected: the SSE line in the locked-decisions table, and the three
      dashboard figures — **half done.** The locked-decisions row is corrected (`ARCHITECTURE.md:69`,
      "Polling. Not SSE, not WebSocket"), but the architecture diagram at line 34 still reads
      `HTTPS / REST + SSE`. Two of three now agree and the diagram is the survivor of exactly the
      inconsistency that correction set out to remove
**Transfers** — added 2026-09-01 with the scope ruling. Both of these are the founder's, stated as
what he wants to see when transfers land, and both are written as the harder half deliberately.

- [x] **A pending transfer request is visible from all three vantage points** — the originating
      doctor's screen, the receiving doctor's screen, **and reception's**. Not just the receiving
      doctor's. His reasoning: reception initiated it, so reception needs to see it sitting there.
      The failure this prevents is a request that exists only in the inbox of the person who has not
      acted on it, which is indistinguishable from a request that was never made.

      **Evidenced 2026-09-02** by running it, not by reading it: `transfers.integration.spec.ts`,
      "reception, the original doctor, and the receiving doctor all see the same request", green in
      a 15/15 run. Its non-vacuity companion is in the same block — "a doctor who is party to
      nothing sees nothing" — without which every assertion would also pass against an endpoint that
      returned every row to everybody
- [x] **Episode-scoped access actually expires** — a test that proves a doctor **loses** access once
      the window closes, not only that they gain it when the transfer is made. His words: *"gaining
      access is the easy half."* This is the same shape as every other guard in this project: the
      grant working is visible, the expiry silently not working is not, and both produce a green
      run. Assert the 404 after expiry against the same endpoint that returned 200 before it, so
      the contrast is in one test
**Patient detail** — added 2026-09-01 with the scope ruling (Q18).

- [x] **A reception token cannot retrieve clinical content through this route** — the founder's own
      wording, and the deliverable is the test, not the decorator. Assert it against
      `clinical-summary` and `clinical-history` with a `RECEPTIONIST` token, and assert the positive
      too: the same token *does* get dates, doctor, service and status from
      `GET /patients/:id/visits`. Both halves, because a test that only proves refusal would still
      pass if the metadata endpoint were broken.

      **Done 2026-09-02**, `patient-detail.integration.spec.ts`. Reception gets **403 at the guard**
      on both clinical routes — refused before any handler runs, so it never reaches the code that
      reads a diagnosis, which is what CLAUDE.md means by separate endpoints rather than filtering
      fields out of one response. Three sentinel strings — a diagnosis, doctor notes, an examination
      — appear nowhere in the profile, the visit list, the insurance block, or the `PATCH` response.

      **The non-vacuity half was wrong in its first draft, and that is the part worth reading.**
      "Reception cannot retrieve clinical content" is trivially true of a database holding none, so
      the spec writes a real visit with a real diagnosis and first proves a **DOCTOR** token reaches
      it. That check originally read `clinical-summary`, which is the *safety* view and carries no
      diagnosis by design; it failed, correctly. Had it been pointed at the passing route instead,
      the entire block would have gone green while proving nothing at all. It now reads
      `clinical-history`, which requires the patient to be present — so the fixture appointment is
      `IN_CONSULTATION` rather than `COMPLETED`
- [x] **Outstanding balance reads `remaining_minor` and nothing recomputes it** — D7. Proven the way
      this project proves guards: change `amount_paid_minor` directly and confirm the screen's figure
      moves with the generated column. A service-side subtraction would pass every ordinary test and
      is exactly the drift D7 exists to prevent.

      **Done 2026-09-03, and the box is ticked against a *different* proof than the one this line
      asks for — because the one it asks for cannot fail.** `GET /patients/:id/balance` sums the
      generated column, and changing `amount_paid_minor` underneath it does move the figure
      (30000/10000 → 20000, then 5000, then 0). But the identical test passes with the service
      recomputing `sum(amount_due_minor - amount_paid_minor)`: all 21 integration tests stayed green
      through that break.

      That is a property of the thing, not a weak test. `remaining_minor` is
      `GENERATED ALWAYS … STORED`, so Postgres maintains it on every write and the column can never
      disagree with its own defining expression — no database state distinguishes the two
      implementations, so no behavioural test can. **This line's stated method is therefore
      unfalsifiable, and following it without checking would have produced a green tick over
      nothing.**

      The guard that does hold is static: `d7-derived-money.spec.ts` scans `src/` for the
      subtraction in either spelling, comments stripped, with one registry entry permitting
      `tenant-scoping.extension.ts` — which names the expression in the error it raises when
      application code tries to *write* the column, i.e. the code enforcing D7. Checked in both
      directions so the allow-list cannot outlive its reason. Proven by breaking it: recomputing in
      the service fails two tests, one naming the file
- [ ] **No editing, no clinical content, no attachments on the screen** — the tight scope is the
      ruling, not a first cut. **Unticked deliberately: the screen does not exist yet**, so there is
      nothing to have got right or wrong
- [x] **A rejected transfer notifies reception explicitly** — founder, 2026-09-01: *"a rejection
      that silently reverts is how a patient gets forgotten in a waiting room."* `LAPSED` — the
      appointment ended while the request was still open — notifies on the same path, for the same
      reason: a request that closes itself quietly is worse than one that stays visibly open
- [x] **Expiry proven at the endpoint that returns visit detail**, not merely at a list — founder's
      addition, and the sharper half of the requirement. A doctor whose window has lapsed must lose
      the *clinical content*, not just stop seeing the patient in a listing. Same grant, same
      patient, same endpoint: 200 before the window closes and 404 after, with only the clock moved
- [ ] **A patient physically present appears in exactly one queue at all times** — the invariant Q16
      exists to serve. Not zero, which is a patient nobody calls; not two, which is two
      receptionists each assuming the other has them
- [x] CI green on the branch before the PR opens — two runs passed on
      `fix/correct-q20-and-transfers-schema` before PR #31 was opened; merged 2026-09-01T16:31:48Z
- [ ] **The gate: a real receptionist reaches competence in under ten minutes.** Measured with a
      person who has not seen the system, not asserted

---

## 8. Checkpoints

The Phase 2 order, which worked: correctness proven by tests before anything reaches the founder's
eyes, so his hours go where only his eyes will do.

1. ~~This document, ruled~~ — **done 2026-08-29**
2. **Schema** — only if `EXPLAIN` shows an index is needed; the migration read before it runs
3. **Queue service + transitions + concurrency tests** — no HTTP, no UI → **checkpoint**
4. **Endpoints + tenant-isolation and permission tests** → **checkpoint**
5. **The queue screen** → **checkpoint** (founder's visual review)
6. **Walk-in registration** → **checkpoint**
7. **The today dashboard** → **checkpoint**
8. **Patient transfers** — design ruled first, then schema → service → endpoints → screen, each its
   own checkpoint. Added 2026-09-01. Its design is still open, and it touches clinical access, which
   `CLAUDE.md` requires be asked about before it is built
9. **The patient detail screen** → **checkpoint** (founder's visual review). Added 2026-09-01. He
   said "checkpoint 8" and, in the same message, that patient detail comes *after* the doctor
   selector and transfers. Both cannot hold, so it is numbered 9 to match the work order he stated,
   which was the more specific of the two. **Say so if the number was the part you meant.** The
   ordering has a real benefit either way: transfers landing first is what lets this screen show
   transfer state from its first commit (Q19) rather than gaining it in a later patch

Frontend one screen at a time, per the standing preference. Steps 5–7 are three separate reviews,
not one.

---

## 9. What remains genuinely uncertain

Stated because a flagged question costs five minutes.

- **Patient transfers are in scope and their design is not written down. This is now the largest
  open item in the phase, and it blocks every line of transfer code.** Two amendments are ruled
  (Q16, Q17) and they are amendments *to* a base design that exists in the founder's memory of an
  earlier conversation and nowhere in this repository — checked on 2026-09-01 across every document,
  the schema, the full source tree, every commit message and every branch. The pointer given was
  `SCHEMA-DECISIONS.md` D22, which is in fact *"`tenants` is scoped by neither layer"*; the decisions
  document ends at D23. Recorded this plainly rather than reconstructing a design from two
  amendments, because a reconstruction would read exactly like a ruling and nothing would keep it
  honest. What is needed before code:
    - **What an episode is**, and what row it hangs off. No episode concept exists;
      `treatment_plans` is the nearest candidate and `visits` is too narrow.
    - **The window** — a duration, a status change, or the earlier of the two.
    - **What the grant actually permits.** If it is read of another doctor's `visits` clinical
      columns, that is the first deliberate exception to the doctor-only rule and belongs in
      `SCHEMA-DECISIONS.md` as a numbered decision (D24), not in a service.
    - **What moves, given Q16.** With the pending appointment staying put, a transfer changes future
      care rather than today's board — so whether it retargets future appointments, only the care
      relationship, or something else, is unstated.
    - **Who may initiate and revoke one**, against `common/permissions.ts`. Transfers touch clinical
      access, and `CLAUDE.md` requires that be asked about before it is built, not after.
    - **Whether a transfer can be undone.** Medical records are never hard-deleted, so a revocation
      is a row, not a delete — which is a schema consequence, not an afterthought.

- **Q18 undercuts half of Q10's reasoning, and Q10 has not been rerun.** Q10 shipped a dashboard
  without today's revenue or outstanding balance because both need payments, which are Phase 4.
  Q18 now puts an outstanding balance on the patient detail screen, read from `remaining_minor`.
  If one patient's balance is answerable in Phase 3, the clinic-wide outstanding total probably is
  too — it is the same column summed. Today's *revenue* genuinely still needs payment records and
  stays out. Flagged rather than acted on: adding a figure to the dashboard is a scope change and
  Q10 was ruled deliberately, so it is his to reopen.

- **May a DOCTOR write to a colleague's appointment? Nobody has ruled, and today they can.** Q23's
  writes audit found queue moves and appointment status changes scoped by tenant only. For
  reception that is deliberate (Q13, and `ARCHITECTURE.md`'s "✓ ✓ ✓ ✓"), but the same
  `appointments.write` also lets a doctor cancel, reschedule, complete or no-show a colleague's
  appointment. That may well be intended — a covering doctor finishing a colleague's consultation is
  a real clinic act — but it has never been decided, and there is no test either way because there
  is no rule. **The founder's ruling is owed before the write side can be called audited.**

- **Restricting `GET /patients/:id/visits` would break Q18, and is not done.** The founder asked for
  it to be scoped to "own patients, or an active transfer grant, or 404". Applied literally that
  returns 404 to **reception** for every patient, and Q18 - his own ruling - puts visit-history
  metadata on reception's patient detail screen. Scoping it for `DOCTOR` alone would leave a doctor
  seeing *less* than a receptionist about their own clinic, while that doctor already receives the
  clinical *summary* for any appointment by deliberate ruling. Left unchanged pending his decision,
  because the two rulings genuinely conflict and picking one silently is how a screen gets built
  twice.

- **`appointments.write` is one capability doing two jobs, and that is what actually caused the
  read-side hole (Q20).** It means both *may act on the queue* — where `DOCTOR: FULL` is correct and
  matches `ARCHITECTURE.md` — and *may read any doctor's day*, where it is not. `doctor-scope.ts`
  now narrows the readers by role, which works but states the rule in a second place rather than in
  the matrix that everyone reads first. The durable fix is a separate capability, something like
  `appointments.readAnyDoctor` at `DOCTOR: NONE`, so the matrix says what is true and a future
  reader of `permissions.ts` cannot conclude a doctor may read every day. **A matrix change is the
  founder's call**, which is why this is a question and not a commit.

- **`GET /availability` is deliberately not `own`-scoped, and that is a ruling waiting to happen.**
  The three readers that return a colleague's *patients* are now pinned. Availability returns free
  time and nothing else, and pinning it would make a real situation unrepresentable: a doctor
  referring a patient to a colleague must see when that colleague is free, and `POST /appointments`
  takes no `doctorId` at all (Q24 puts it inside the signed slot token), so availability is the only
  place that lookup can happen. The line drawn is **free/busy is shared, who is in the chair is
  not.** Stated here because it is a security boundary chosen by judgement, and a boundary nobody
  ruled on is one nobody will recheck.

- **Q3, queue ordering, is open by ruling** and is the largest of the queue-side questions. It is a clinic-culture
  question and the answer comes from watching a reception desk. The ordering ships as one named
  function so that switching it is one edit and a changed test.
- **Q7 reverses the draft's own proposal**, which is a reason to look at it twice. I now argue
  *against* enforcing one-consultation-per-doctor, on the grounds that refusing it makes a real
  clinic situation unrepresentable. If real clinics never overlap, the refusal would have been a
  useful guard and this is the wrong call.
- **The same statuses had two colour implementations, and no guard could see it.** Found by the
  founder reading a screen on 1 September 2026, not by the suite. `STATUS_TONES` in
  `design-system/display.tsx` and `TIMELINE_TONES` in `features/day-view/DayViewPage.tsx` both map
  all eight `AppointmentStatus` values to Tailwind classes, deliberately differently — the badge's
  pale tints are invisible as wide bars over the free-slot background, which is a real reason for
  two maps and is documented at the second one.

  What has no defence is that they could disagree about *which colour a status is* and nothing
  would say so. `web-colour-tokens.spec.ts` asserts every colour utility names a token that exists.
  Both files passed it while `BOOKED` was a pale cream chip in one and a solid orange bar in the
  other, because `warning-soft` and `warning` are both real tokens. **A guard that checks tokens
  exist cannot check that two files agree** — it validates each map against the palette and never
  against the other map. The founder's wording, and it generalises past colour: every conformance
  check in this project so far compares one artefact to a source of truth, and none compares two
  artefacts that are supposed to say the same thing.

  Two things followed from it and are done: `BOOKED` has its own `--color-amber` instead of
  borrowing `--color-warning` (the shared token was *why* the two maps could diverge — neither was
  wrong about the token, they just took different halves of it), and the green ramp is re-spaced on
  deltaE rather than L*. The guard that would actually catch a recurrence — one asserting the two
  maps agree on the status *family* each colour belongs to — is not written yet, and is a known gap
  rather than a finished item.

- **Not every appointment rule is a state transition, and the ones that are not have no automatic
  home.** Found on 1 September 2026 while checking a different bug: the founder reported the detail
  panel offering cancel on a COMPLETED appointment, asked whether the API actually refused it, and
  the answer split. Cancel was already enforced — `changeAppointmentStatus()` consults
  `transition()`, which refuses terminal statuses before it reaches the edge table. **Reschedule was
  not enforced at all**, and had never been.

  The reason is structural rather than an oversight, which is why it is worth writing down. §9 rules
  that *reschedule is not a status*: it mutates `scheduled_start` and `scheduled_end`, increments
  `reschedule_count`, and appends an `appointment_events` row, deliberately **without** adding an
  edge to the state machine. That ruling is right — a reschedule genuinely is not a move between
  states. But it had a consequence nobody drew: `rescheduleAppointment()` never called
  `transition()`, and **being outside the state machine put it outside every guard the state machine
  provides.** It checked the slot token, found the appointment, and updated it unconditionally.

  What that allowed: a COMPLETED appointment moved to a future slot. `COMPLETED` is not in
  `RELEASING_STATUSES`, so it still occupies time — the finished visit would sit in next week's
  calendar blocking a real booking, with no status anywhere looking wrong. A `CANCELLED` one could
  be given a new time it would never show up for.

  **The general form, and the reason this is a note rather than just a commit.** The state machine
  is the obvious place to look for "which appointments may this happen to", so a rule that lives
  there is found by anyone who looks, and a rule that cannot live there is found by nobody. The
  transition table is not a complete index of the constraints on an appointment; it is a complete
  index of the *status changes*. Every other mutation — the times today, and whatever is added
  next: moving an appointment to a different doctor, changing its service, attaching it to a
  different patient after a merge — needs its rule stated explicitly and enforced explicitly,
  because there is no table it will fall into by default.

  The shape to watch for is a function that mutates an appointment and never mentions
  `transition()`. That absence reads as "this is not a status change", which is true, and as "so no
  status rule applies here", which does not follow.

  Done: `canReschedule()` and `legalSourcesFor()` now sit beside the edge table in
  `domain/transition.ts` — beside it deliberately, so the next person reading the state machine
  finds the rules that are not in it. `apps/web` mirrors both and
  `appointment-actions-conformance.spec.ts` compares the two in both directions across all eight
  statuses. Proven by breaking it: with the reschedule guard removed the suite went 2 failed / 2
  passed, and the two that still passed were the cancel cases — the contrast showing cancel was
  already covered and reschedule was not.

- **Q5's no-phone case is ruled but untested against reality.** Recording the accompanying person's
  number works schematically because phone is not unique, but whether reception finds two patients
  on one number confusing is a thing to watch, not a thing to reason about.
- **Q1's five seconds is a rationale, not a measurement.** Revisit with a real clinic on a real
  network.
- **The estimate.** `ARCHITECTURE.md` says 2–3 weeks. Given that the state machine, the four queue
  timestamps and the grace column already exist, and that §5 is now empty, this should be smaller.
  Said as an expectation, not a promise.

---

## 10. There is no status section here, deliberately

**This document does not record what is done, what is in flight, or what comes next. Read that from
`gh pr list` and `git log --oneline --graph`, which is the first thing `CLAUDE.md` asks of a session
anyway.**

A section titled "Where things stand" with a date on it is a snapshot, and a snapshot goes stale the
next time anything merges. The one that used to be here was written 2026-08-29 and was wrong by the
following morning: PR #28 landed checkpoints 3, 4 **and** 5 — the queue service, the endpoints with
their tenant-isolation and permission tests, and reception's live queue screen — while the section
still said `feature/queue-service` was "awaiting merge" and named checkpoint 4 as "next".

On 2026-08-31 a session was briefed from it and told to open a pull request that was already merged
and to build two checkpoints that already existed. Only the mandatory `gh pr list` / `git branch -r`
check caught it. The section carried its own warning — *"this paragraph is a snapshot and branches
outlive snapshots"* — and that did not save it, because **a document that admits it might be wrong
is still read as true.** Hedging text does not survive contact with a reader who wants an answer.

So the section is deleted rather than corrected or annotated. Correcting it only resets the clock on
the same failure; annotating it asks every future reader to do the branch check *and* read the prose,
when the branch check alone is sufficient and authoritative. Git already knows the answer and cannot
go stale. A second copy of that answer in prose has nothing keeping it honest.

The founder's ruling, 2026-08-31: *"I'd rather it stopped existing. Git already knows the answer and
cannot go stale."*

What belongs in a phase document is what git cannot tell you: the scope, the rulings and their
reasons, the Definition of Done, and the open questions in §9. Those are decisions, and decisions do
not go stale when a branch merges.
