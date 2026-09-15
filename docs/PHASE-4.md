# Phase 4 — the visit screen, prescriptions, and attachments

**Scope and rulings. Nothing here records what is built** — status is read from `gh pr list` and
`git log`, never from this document.

Eighteen questions.

- **Twelve ruled by the founder**, marked with his words: Q1, Q2, Q3, Q6, Q8, Q9, Q10, Q14, Q15 and
  Q17 on 2026-09-02; Q11 (storage) and Q18 (visit detail) on 2026-09-03.
- **Five ruled by me** where the reasoning was clear, each saying plainly what I chose so it is
  cheap to overturn: Q4, Q5, Q7, Q12, Q13.
- **Two of his carry an implementation decision of mine inside them** — where the draft physically
  lives (Q2) and what act completes a visit (Q6). Q11 no longer does: the founder ruled the storage
  backend directly on 2026-09-03, overruling my MinIO recommendation.
- **One is a question back to him**: Q16, the iPhone.
- **Two carry a flagged uncertainty** inside an otherwise settled ruling: Q6 and Q15. Q11 no longer
  does — keeping files on the clinic's own machine retires the data-residency question for the pilot.

---

## 0. Before any of this: the review loop was broken, not the code

**Stated first because it invalidates a day of review, and because Phase 4 is the most screen-heavy
phase in the project.**

On 2026-09-02 the founder reviewed several screens against a build of `apps/web` compiled on
**30 August**. In the window between that build and its rebuild, **41 commits landed, 9 of them
touching `apps/web`** — the booking dialog, the transfer screens, the re-spaced status colours, the
mixed-direction sentence fix, the pinned doctor selector, and the error boundary. Every screen-level
observation made that morning was about code that had already changed.

**Nothing was wrong with the screens.** The feedback was accurate about what was on the glass and
irrelevant to what was in the repository, which is the worst possible combination: it costs the
reviewer's time, it costs a developer re-checking correct code, and it produces confident, specific,
wrong conclusions that both people believe.

That is why `dist/` being stale is not a minor inconvenience. **A stale build does not present as a
tooling failure — it presents as work that was never done.**

### It happened twice, on both sides, in one day

The second occurrence was the mirror image and is the more instructive one. After the frontend was
rebuilt, the queue crashed on the built app with
`TypeError: Cannot read properties of undefined (reading 'standing')`. The bundle was current; the
**API** was an hour old, compiled before the queue's `coverage` field existed, so every row arrived
without it. Same class of fault, opposite half of the stack.

So this is not "remember to rebuild the frontend". It is: **any artefact a review looks through can
be older than the code it is supposed to represent, and each one needs closing separately.**

### What is closed, and what was still open

| | |
|---|---|
| **Frontend** | **Closed.** **Superseded 2026-09-07 by `npm run preview` at the repository root**, which is now the only review build. At the time this was closed by making every `apps/web` serve-script build first. `docs/SETUP.md` had warned "use this, not `npm run preview`" since the second occurrence and the warning did not hold, because the command it warned about still worked — a convention rather than a guardrail |
| **API** | **Was still open, and is what broke today.** `npm start` is `node dist/main.js`, which runs whatever was last compiled. Now `npm run start:fresh` builds first, and `docs/SETUP.md`'s review-stack recipe uses it |
| **The review database** | **Not automatic, and worth knowing.** Nothing migrates `clinic_os_review`; the test suite migrates `clinic_os_test`. It was found two migrations behind and predating `patient_transfers` entirely, which would have made every transfer screen fail at the database while looking like a frontend bug |

### The rule for Phase 4

**Before any screen is put in front of the founder, both halves are rebuilt and the review database
is migrated.** Not remembered — the commands exist so that the fresh path is the only path, and
where a stale path still exists it should be removed rather than documented against.

And when a screen looks wrong, **the first question is whether the artefact is current**, not what
the code does. Three of this project's review cycles have been lost to answering that question
second.

---

## 1. What this phase is

The first phase in which **clinical content is created**. Everything before it moved patients around
a board; this one writes what happened to them.

| | |
|---|---|
| **The visit screen** | Complaint, history, examination, diagnosis, plan, notes, follow-up. Reached from the queue when a patient is `IN_CONSULTATION` |
| **Prescriptions** | Written by the doctor during the visit, and printed |
| **Attachments** | Lab results, scans, photographs, against a patient and optionally a visit |
| **Clinic-managed services** | Admin creates, prices and deactivates services, instead of them arriving seeded. Added 2026-09-03 by ruling 1 of `docs/PHASE-5-DESIGN.md` §7 |
| **The quoted price snapshot** | `appointments.quoted_price_minor`, written at booking. One column, and it is here because of what the row above does |
| **The patient book** | A paged list ordered by most recently seen, with the existing search on the same screen, rows opening the patient detail screen. Reception and admin. Added 2026-09-03 by founder ruling: *"reception answering a phone call about a balance should not have to open a booking dialog and abandon it"* |

**Payments stay out**, by ruling. Phase 3 already reads `remaining_minor` for display; recording,
adjusting, discounting and refunding are not here.

**Why two rows arrived in this phase after it was written.** Phase 5's design proposed services
management (its "A") for Phase 4 and the founder ruled it in on 2026-09-03. The price snapshot came
with it and is not optional: `appointments` stores `service_id` and **no price**, so the only record
of what an appointment costs is a live join to `services.price_minor` — a mutable row. That is
harmless only while nothing edits prices, and **clinic-managed services is precisely the feature that
starts editing them.** Ship the screen without the column and every past appointment's price silently
becomes whatever the service costs today, unrecoverably, because the old value was never written
anywhere. The two belong in the same phase for that reason and no other.

### The assumption the whole phase rests on

**The doctor has validated that he will type notes during the consultation and write prescriptions
himself.** That is load-bearing rather than a preference: if it is wrong, the screen is wrong rather
than awkward, and the product a doctor who dictates afterwards needs is a transcription queue, not a
consultation screen.

So the screen is designed for **someone typing while a patient sits opposite them**, which is a
constraint and not a mood. Concretely:

- attention is divided and the typing is interrupted constantly;
- the doctor will not click "save" — not from carelessness, but because the patient is mid-sentence
  and the doctor is looking at them;
- the session can end abruptly: a phone rings, a lid closes, wifi drops in a building with thick
  walls;
- **losing three minutes of typed examination notes is worse than losing the whole visit.** A lost
  visit is obvious and gets redone. Silently losing the last paragraph is not noticed until the
  record is read months later, when nobody can reconstruct it.

Q1 through Q7 are all consequences of that paragraph.

---

## 2. Out of scope

Payments · reports · the public booking page · WhatsApp · the AI tool layer · lab integrations ·
drug-interaction checking · note templates (Q3) · e-prescribing (Q9).

---

## 3. What is already true

Bigger than usual, and it changes the shape of the phase: **the schema exists and is already
protected.**

| | |
|---|---|
| **Tables** | `visits`, `visit_revisions`, `prescriptions`, `prescription_items`, `attachments`, `treatment_plans`, `treatment_plan_sessions` — all present |
| **RLS** | `ENABLE` **and** `FORCE` on every one. Verified 2026-09-02 |
| **Audit** | Every one carries its `_audit` trigger, including `attachments`, whose historical gap `19-patient-transfers.sql` warns about. Verified 2026-09-02 |
| **Append-only** | `visit_revisions` has the D5 `BEFORE UPDATE OR DELETE` trigger. A correction is a new row |
| **`VisitStatus`** | Already `DRAFT \| COMPLETED`, since Phase 1. **Nothing has ever written a `DRAFT` row** |
| **`prescription_items`** | Already `medication_name`, `dose`, `frequency`, `duration`, `instructions`, `sort_order` |
| **The read side** | `clinical-summary` and `clinical-history` exist and are `visits.readContent` — `NONE` for OWNER, ADMIN and RECEPTIONIST |
| **The access rule** | `clinical.access.ts` implements `own patient && PRESENT`; the transfer grant relaxes presence (D24) |
| **The leak sweep** | `clinical-leak-guard.integration.spec.ts` (Phase 3 Q26) sweeps ten reception-facing endpoints. Every endpoint added here must join it — see Q13 |

**The likely total schema change for this phase is two integer columns and one partial unique index**
(§5) — the revision counter on `visits`, and `appointments.quoted_price_minor` after the 2026-09-03
scope ruling. That is the opposite of what the phase title suggests and should change how it is
estimated: this is almost entirely write paths, guards and screens over a schema that already exists.

**And most of clinic-managed services already exists as backend.** Verified on 2026-09-03:
`apps/api/src/modules/services/` has `list`, `get`, `create` and `update`; `services.manage` is in
the permission matrix as OWNER and ADMIN full, DOCTOR and RECEPTIONIST none — which is exactly what
`PHASE-5-DESIGN.md` §2.1 ruled, already enforced; and `updateService` already documents deactivation
rather than deletion. What does not exist is **any screen** (`apps/web/src/features/` has no
`services` directory on any branch that has ever existed) and **any test** (no spec file in the
repository names services).

---

## 4. Questions and rulings

### Q1. How many screens is the visit? — **RULED by the founder: one.**

His words: *"ONE screen. A doctor who has to remember which tab holds the allergy while typing a
diagnosis is being asked to do the system's job. Progressive disclosure, everything reachable
without navigation."*

The reasoning generalises past this screen, so it is worth stating rather than just obeying: tabs
move working memory from the machine into the person, and this person is already holding a
consultation. Anything that is *context* — allergies, current medication, the last visit's diagnosis
— must be visible or one disclosure away, never behind a navigation that loses the typing.

Two consequences that follow and are not optional:

- **progressive disclosure must not unmount.** A collapsed section that discards its contents is a
  tab wearing different clothes. Collapsed means hidden, not destroyed;
- **the safety context is already available.** `clinical-summary` returns allergies, current
  medication, active treatment plans and recent visits in one call. This screen consumes it rather
  than assembling its own.

### Q2. Where does the draft live, and who can see it? — **RULED by the founder: autosaved, and private to its author.**

His words: *"Yes to autosave, but the draft is the doctor's private working copy until completed.
Reception must not see a half-written diagnosis on the queue, and neither should another doctor.
Draft is visible to its author only."*

**Where it lives — mine, and the schema already agrees.** The `visits` row itself, written from the
first keystroke, `status = 'DRAFT'`. `VisitStatus` has been `DRAFT | COMPLETED` since Phase 1 and
nothing has ever written a `DRAFT` row. The two alternatives I considered and rejected:

- **`localStorage`.** Survives a crash but not a closed laptop opened in another room, is invisible
  to the rest of the system, and puts clinical text in browser storage on a shared machine — a PDPL
  question nobody has asked. "My notes are gone" would have no remedy.
- **A separate `visit_drafts` table.** Duplicates every clinical column, and the day the two shapes
  disagree the bug is silent and clinical. Promotion to a real visit is a copy, and a copy is a
  place data goes missing.

Choosing either would also leave `DRAFT` in the schema with nothing producing it — the
`appointments.queueActions` shape Q24 found, a value that reads as a live rule and is enforced by
nothing.

**One appointment can therefore carry more than one draft — see Q15 — and that needs a constraint
the schema does not currently have.** `ARCHITECTURE.md` §4 describes `appointments 1:0..1 visits`,
but **checked on 2026-09-02, nothing in the database enforces it**: `visits` has a primary key and
two ordinary indexes, and no unique index on `appointment_id` at all. So the relationship is a
statement in a document rather than an invariant, which is the shape `CLAUDE.md` calls a comment.

The invariant that actually matters is not "one visit row per appointment" — it is **one *finished*
visit per appointment**. Drafts are working copies and several may exist; exactly one of them can
become the record. That is expressible directly:

```sql
CREATE UNIQUE INDEX visits_one_completed_per_appointment
  ON visits (tenant_id, appointment_id) WHERE status = 'COMPLETED';
```

The same partial-unique idiom as `patient_transfers_one_open_per_patient`, and it makes Q15's
"expires as an abandoned draft rather than attaching to the visit" true by construction: an
unfinished draft never becomes the visit because it never becomes `COMPLETED`, and the database
refuses a second one that tries.

**Author-only visibility is the load-bearing half, and it is a filter — which is this project's
most-repeated failure.** Every reader of `visits` must exclude other people's drafts:
`listVisitHistory`, `clinical-summary`'s `recentVisits`, the patient detail screen, the clinical
history endpoint, and anything Phase 5 adds. Six chances to forget, and forgetting shows a
half-written diagnosis to someone who must not see it.

So it is **not** a `WHERE status <> 'DRAFT'` copied into six queries. It is one function that every
reader calls, the way `doctor-scope.ts` owns the ownership rule — and per Q13's guard, a reader that
does not call it should fail the build rather than be caught in review.

### Q3. Are notes free text, or a template? — **RULED by the founder: free text. No templates in Phase 4.**

His words: *"Notes are free text. No templates in Phase 4. The doctor said he types; he did not say
he wants a form. Templates are a Phase 6+ conversation once we have seen what he actually types."*

Worth recording why this is the stronger position rather than the smaller one: a template built
before anyone has read a month of real notes encodes a guess about the specialty, and the failure
mode is not an unused feature — it is a doctor filling in fields to make the form happy and writing
the real note somewhere else. The data then looks structured and is worthless.

### Q4. What triggers a save, and what does the doctor see? — **RULED by me.**

**Two seconds after typing stops, and on blur of any field.** No save button as the primary path — a
button is a thing this doctor will not press, per §1. A manual "save now" may exist as a
reassurance affordance; it must never be the thing that makes saving happen.

**What they see matters more than the interval.** Three states, and the third is the one that gets
skipped:

- *saved* — quiet, with a timestamp;
- *saving* — brief;
- **failed** — loud, persistent, and it must not fade. A toast is wrong here for exactly the reason
  it was wrong for transfer rejections in Phase 3: the doctor is looking at the patient, and a
  notice nobody was looking at is the same as no notice.

**A failed save must stop claiming success.** If the network is down, the indicator says so and
keeps saying so, and the text stays in the field. The failure this prevents is a doctor seeing a
stale "saved 10:42" while three minutes of typing exists only in the DOM.

**Not blocking navigation.** I considered a `beforeunload` prompt and rejected it: browsers
increasingly ignore it, it fires on every ordinary navigation, and the recoverability in Q5 is a
better answer than a dialogue nobody reads.

### Q5. What survives a browser crash mid-sentence? — **RULED by me: everything older than about two seconds, and the guarantee is stated modestly on purpose.**

With Q2's server-side draft and Q4's autosave, the honest guarantee is **everything typed more than
roughly two seconds before the crash** — not "nothing is lost". An overstated guarantee is worse
than a modest one, because it is the reason people stop saving.

What it requires:

- the draft is on the server, so another device recovers it;
- reopening the visit **says** it is resuming a draft, with a timestamp, rather than silently
  filling the fields. A screen that quietly restores text is how a previous patient's notes end up
  in this one's record;
- the last-saved instant is stored and shown.

**Proven by a test that behaves like a crash, not like a logout**: type, kill the client with no
cleanup, reopen, assert the text. A resumable draft nobody has watched resume is not one.

### Q6. When is a visit finished, and what is an amendment? — **RULED by the founder for the amendment. The completion trigger is mine, and it is the one thing here I would most like sanity-checked.**

His words: *"A completed visit is editable only through the correction path we already designed: a
reason, a `visit_revisions` row, and the original preserved. Never a silent edit."*

That settles what happens *after*. `visit_revisions.reason` is already `NOT NULL`, so the schema has
carried this decision since Phase 1.

**What completes a visit — mine: the queue's existing `COMPLETE` action, not a second "sign"
button.** Reasoning: two separate acts can diverge, and a `COMPLETED` queue row sitting next to a
`DRAFT` visit is precisely the open-thing-no-workflow-closes shape that produced `LAPSED` transfers
in Phase 3. One act cannot disagree with itself.

**The consequence, stated plainly because it is the part worth checking with a real doctor:** a
doctor who completes the consultation and then remembers a sentence must file an amendment, with a
reason, to add it. That may be exactly right — it is what a clinical record is for — or it may be a
friction that produces sparse notes and a habit of not completing. **I cannot resolve that from
here; it is a question about how he actually works.** If it turns out wrong, the fix is a short
grace window after `COMPLETE` during which edits are still edits, which is a small change and does
not alter the schema.

**Resolved 2026-09-09, and it did turn out to need the window.** The founder's ruling: *"the doctor
who completed a visit may file an amendment for 24 hours after completion without the patient being
present. It is still an amendment — reason required, `visit_revisions` row written; only the presence
condition is relaxed, and only for the completing doctor. After 24h, Q18's rule applies unchanged."*
Recorded as `SCHEMA-DECISIONS.md` D35, with the guard he attached to it: a second doctor is still
refused inside the window.

### Q7. Can the same visit be edited from two places at once? — **RULED by me: compare-and-set, never last-write-wins, never a lock.**

With Q2's author-private drafts the realistic case is not two doctors — it is **one doctor on two
devices**, or one who left the visit open on the clinic desktop and reopened it on a phone. Silent
last-write-wins there deletes clinical text with no trace.

Every autosave carries the revision it was based on; a mismatch is refused with a message naming
what happened — the same compare-and-set the queue already uses (Phase 3 Q2). This is the one
integer column §5 mentions.

**Not a lock.** A lock left behind by a closed laptop is a visit nobody can write to, in front of a
patient.

### Q8. What is a prescription item? — **RULED by the founder: free text with autocomplete from this clinic's own history.**

His words: *"Medication is free text with autocomplete from what this clinic has prescribed before —
that gives the benefit without the regulatory surface."*

**No schema change.** `prescription_items` already carries `medication_name`, `dose`, `frequency`,
`duration`, `instructions` and `sort_order`. The autocomplete is a query over this tenant's existing
`medication_name` values — no dictionary, no external source, nothing to license, and no claim that
the list is complete or safe.

`sort_order` is worth noting as a requirement hiding in a column: prescription lines have a
deliberate order and the doctor can rearrange them.

### Q9. How does a prescription reach the patient? — **RULED by the founder: it prints.**

His words: *"Prescriptions print. No e-prescription, no signature, no drug database."*

So Phase 4 builds a print stylesheet and increments `printed_count`. **`prescription_access_tokens`
stays in the schema and stays unbuilt** — a patient-facing page with no login that displays clinical
content is a new security surface and would need its own ruling and its own Definition of Done. It
is not arriving as a side effect of "prescriptions".

### Q10. What may be attached, how big, and can it be deleted? — **RULED by the founder.**

His words: *"images and PDFs, up to 10MB, virus-scanned if that's cheap and flagged as a gap if it
isn't. Store outside the database. Deletion is archival, never destructive — same as everything else
clinical."*

- **Types:** images and PDFs only, enforced by sniffing the content, not by trusting the declared
  MIME type or the file extension — both are caller-supplied.
- **Size:** 10 MB, enforced server-side. The client also downscales photographs (Q12).
- **Deletion:** `attachments.archived_at` already exists. Archive sets it; nothing deletes rows and
  nothing deletes the stored object.

**On virus scanning: it is not cheap, so it is flagged as a gap rather than half-built.** ClamAV is
the realistic option and it means another container holding a signature database of roughly a
gigabyte in memory, plus a signature-update cadence that is itself an operational commitment, on a
server `DEPLOY.md` sizes at 2 vCPU / 4 GB. A scanner with stale signatures that nobody notices has
stopped updating is worse than none, because it is believed.

What is done instead, and it is cheap:

- content sniffing, so a `.pdf` that is really an executable is refused at upload;
- **downloads are always served `Content-Disposition: attachment`, never inline**, so nothing is
  rendered or executed in the browser context;
- the storage bucket is private and never a public URL (Q11).

**Recorded as an open gap**, in the founder's own framing, for a later ruling.

#### Amended 2026-09-05: what **reception** may see

Q10 settled what may be attached and Q11 settled where it lives, but neither said what reception is
told about a patient's documents. Ruled: **reception can see which attachments exist, not what they
contain.**

His words: *"They need the count and the category to do their job — 'the X-ray is already on file,
don't ask him to bring it again'. That's operational metadata, the same class as visit dates and
appointment status. But filename is content. A file called `أشعة_الركبة_اليمنى.pdf` discloses the
condition, and that's the §8 line."*

| | |
|---|---|
| Route | `GET /patients/:id/attachment-summary` — its own controller, so `AttachmentsController`'s "every route here is doctor-only" stays literally true |
| Capability | `visits.readIndex` — already `FULL` for `RECEPTIONIST`, and already serves the visit *index*. No permission-matrix change |
| Returns | `total`, and per item: `category`, `sizeBytes`, `createdAt` |
| Never returns | `fileName`, `mimeType`, `description`, `storageKey`, a preview, a content URL — **or an id**, because an id is a handle and the safest reception-facing list hands out nothing to try |
| Archived rows | Excluded. Reception is asking "must the patient bring it again", and an archived document is not on file for that purpose. The doctor's list still shows them, marked |

**This was a widening, not a narrowing.** Reception previously saw *nothing*: every attachment route
was `visits.write` or `visits.readContent`, both `RECEPTIONIST: NONE`, so reception was refused at
the guard. No filename was ever exposed to them. The ruling adds a reception-facing surface that did
not exist rather than trimming one that did.

**It joins the leak sweep, and doing so exposed a hole in the sweep itself.** Registering the
endpoint was not enough: every sentinel in `clinical-leak-guard.integration.spec.ts` was a `visits`
column, so the sweep passed with `fileName` deliberately selected into reception's payload. The
guard covered the route and was blind to the only thing that route could leak. There is now an
attachment-filename sentinel, and the deliberate leak turns the sweep red.

### Q11. Where do the files actually live? — **RULED by the founder 2026-09-03: the local filesystem, behind a `StorageProvider` interface. No S3, no bucket, no cloud account.**

His words: *"It's a dev and pilot deployment on one machine; the interface is what makes moving
cheap later. `ARCHITECTURE.md` §19 already names that seam."*

**This overrules my MinIO recommendation, and it is the better call for the pilot.** My argument was
that a filesystem volume breaks the moment there is a second API container — true, and irrelevant
until there is one. Against it, MinIO costs a container, a bucket, four environment variables and a
credential to rotate, on a deployment that is one machine. Buying the *interface* is cheap; buying
the operational dependency ahead of the problem is not.

So `attachments.storage_key` becomes a path under a configured root, one required environment
variable rather than four, and a `StorageProvider` with one implementation. **The seam is the
deliverable** — the day this moves to S3, the change is a new class and a config value, and nothing
above it knows.

**Two things that do not change with the backend, and both are the security half:**

- **Attachments are never served from a public URL, a static path, or a redirect to storage.** They
  are fetched through the API under `visits.readContent`, which puts a doctor-only file behind the
  same gate as the notes it belongs to. A filesystem root that Caddy could serve directly would be a
  hole with a URL in it.
- **The configured root sits outside the repository and outside any served directory**, and the
  download sets `Content-Disposition: attachment` (Q10).

**The flagged legal uncertainty is retired rather than answered.** Whether patient scans may lawfully
sit in a third-party bucket outside Egypt was an open question; keeping the files on the clinic's own
machine means it is not asked at all for the pilot. It returns the day somebody proposes S3, and the
`StorageProvider` seam is what keeps that a decision rather than a migration.

**Still adds a required environment variable, so `docs/SETUP.md` and `docs/DEPLOY.md` both change** —
and DEPLOY.md gains a backup consideration it does not have today, because attachments become state
on the host that `pg_dump` does not cover and the §7 restore drill would not catch.

### Q12. Can the doctor photograph a document with the phone? — **RULED by me: yes.**

`<input type="file" accept="image/*" capture="environment">` opens the camera directly on iOS and
Android with no native code, no permission dialogue of our own, and no PWA. Given the doctor is
iPhone-first this is likely the *most-used* attachment path rather than a nice-to-have.

A phone photo is 3–8 MB against a 10 MB cap, so the client **downscales before upload** — long edge
2000px, re-encoded — which keeps a document legible and takes a typical capture under 1 MB.

**This is the first feature that cannot be tested at all without a real iPhone**, which is Q16.

### Q13. How is §8's boundary proven — per endpoint or per phase? — **RULED by me: per endpoint, and by a guard that fails the build.**

The founder's framing: *"Phase 4 is where clinical content is actually created, so §8's boundary
moves from theoretical to load-bearing. Every endpoint you add is one reception must not reach."*

Phase 3 ended with a sweep (Q26) over ten reception-facing endpoints. That is a per-*phase* guard: a
list, and a list is only as good as whoever remembers to append to it. Q25's entire finding is that
remembering does not work.

**So the list becomes a build failure.** A spec scans the controllers for every route and requires
each to appear in exactly one of two registries — *doctor-only clinical* or *reception-facing and
swept* — failing when a route appears in neither. That is `own-capability-enforcement.ts`'s proven
shape (Q24), already broken deliberately and watched to fail, applied to a second invariant.

Per-endpoint proof then becomes mechanical: a new route cannot merge unclassified; classifying it
reception-facing enrols it in the sweep automatically; classifying it doctor-only owes a paired test
that a `RECEPTIONIST` token gets **403 at the guard**, not a filtered response.

**The trap to avoid, and Phase 3 Q26 documented it the hard way: auditing Prisma `include`s is the
wrong audit.** A nested clinical include is not itself a leak — during a deliberate break
`describeQueue` fetched three clinical columns and leaked nothing, because it maps rows field by
field. The leak appeared only when the row was *also spread into the response*. The question is
never what a query selects; it is what reaches the wire, and only a behavioural sweep answers that.

**The same guard covers Q2's draft filter**, which is the same shape: a reader that forgets is
caught by the build rather than by review.

### Q14. Does reception see that a visit is in progress? — **RULED by the founder: yes — the status, and nothing else.**

His words: *"reception sees that a visit is IN PROGRESS. Nothing about its content… the queue DTO
carries `visitStatus` — draft or completed — and nothing else. No complaint, no diagnosis, no field
from the draft."*

The operational case he gave, and it is the part I had missed when I first recommended against
this: **a patient whose visit is in progress must not be checked in again, and the queue has to be
able to say why someone is neither waiting nor finished.** That is a scheduling fact reception owns,
not a clinical one.

`QueueEntry` gains exactly one field:

```ts
/** DRAFT while the doctor is writing, COMPLETED once finished, null when no visit exists yet. */
visitStatus: "DRAFT" | "COMPLETED" | null;
```

It is the status of the visit belonging to **the appointment's own doctor** — well-defined because
Phase 3 Q16 ruled that a pending transfer leaves the appointment in the originating doctor's queue,
so `appointment.doctorId` does not move under this field. Another doctor's draft on the same
appointment (Q15) is not reception's business and is not what this reports.

#### The line this field sits on, stated because the next person to widen it needs to find it here

**Metadata is a fact *about* the record. Content is anything a clinician typed.** The boundary is
not "sensitive fields" or "fields reception shouldn't need" — both are judgement calls that drift.
It is authorship:

| | |
|---|---|
| **Metadata — reception may see** | that a visit exists; its status; when it started or finished; which doctor; which service; the follow-up *date* |
| **Content — reception must never see** | complaint, medical history, examination, diagnosis, treatment plan, doctor notes, prescription items, attachment contents — **and any excerpt, preview, summary, character count or truncation of them** |

The middle column is where this goes wrong. A "first 40 characters of the complaint" is content. A
"has notes" boolean is metadata. A "notes look empty" heuristic computed from the text is content
wearing a boolean's clothes, because it is derived from what the doctor typed.

**So the rule for `QueueEntry`, and for every reception-facing DTO: a field may be added only if its
value can be computed without reading a clinician-authored column.** `visitStatus` passes — it is a
status column the workflow sets. `complaintPreview` fails. If a proposed field needs a clinical
column to compute, it is content no matter how small the result is.

This is the exact boundary `clinical-leak-guard.integration.spec.ts` sweeps, and Q13's classification
guard is what stops a new endpoint escaping the sweep. **Neither of them can catch a field that is
deliberately added to an already-swept DTO** — the sweep checks for known sentinel *strings*, and a
character count of a diagnosis contains none of them. That gap is why this reasoning is written here
rather than left to the tests: the next person adding a field to this DTO has to pass a human, and
this paragraph is what they should meet.

### Q15. Who does a draft belong to, and what happens to one nobody finishes? — **RULED by the founder: the author, not the appointment.**

His words: *"the draft belongs to the AUTHOR, not to the appointment… Dr. B starts their own draft.
Dr. A's draft stays Dr. A's — visible to them, and if they never complete it, it expires as an
abandoned draft rather than attaching to the visit."*

**The two failures this prevents, in his framing, and they are different from each other.** If Dr. B
accepts a transfer and opens Dr. A's half-written diagnosis:

- **Dr. B may adopt reasoning they did not form.** A partial diagnosis is not a neutral starting
  point — it is an anchor, and the second clinician is now less likely to reach an independent
  conclusion. That is a clinical harm with no audit trail, because the record will look like one
  doctor's assessment.
- **Dr. A ends up named on a record they did not finish.** `visits.doctor_id` and every audit row
  would attribute to Dr. A text that Dr. B completed and signed, which is a legal problem regardless
  of whether the medicine was right.

So a transfer produces a **new draft owned by the receiving doctor**, and never a handover of the
first one. The originating doctor's draft stays theirs.

**The pending case needs no special handling, and that follows from a ruling that already exists.**
Phase 3 Q16: a pending transfer leaves the appointment in the originating doctor's queue. So while a
request is open, the patient is still Dr. A's and Dr. A writing notes is legitimate — nothing about
drafts changes until the transfer is *accepted*. That is worth stating because the tempting
implementation is to freeze the draft the moment a request is raised, which would stop a doctor
working on a patient who is still theirs.

**Abandonment is derived, not stored, and no job writes it.** A draft is abandoned when it is still
`DRAFT` and has not been touched for some window, computed on read against an instant the caller
passes in. This is D24's argument for the third time in this codebase — after transfer grants and
insurance windows — and for the same reason: a status column flipped by a nightly sweep looks
exactly like expiry, passes every test written against it, and leaves drafts live forever if the
sweep is never written or dies quietly.

**Abandoned does not mean deleted.** Clinical content is never hard-deleted (CLAUDE.md). The row
stays, its author can still see it, and it is simply never the visit — which the partial unique
index in Q2 guarantees, since only a `COMPLETED` row can be.

**A cancelled or no-showed appointment is the same case.** The draft survives and surfaces to its
author as unfinished. Silently discarding typed clinical text because a queue status changed would
be the worst available resolution, and it would be invisible, which is worse than wrong.

**Open sub-question, and it is small enough that I would guess if pushed but would rather not:** how
long is the abandonment window? A day is aggressive for a doctor who resumes after a ward round; a
week means the "unfinished visits" list is stale for a week. I would start at **48 hours** and make
it a parameter rather than a literal, so it is one config change and not a code change.

### Q18. Can a doctor open a past visit on its own? — **RULED by the founder 2026-09-03, and revised by him on 2026-09-05 after it was built.**

**The current ruling: `GET /appointments/:id/visit`, doctor-only, full clinical content including
revision history, and no authorship exception.** The 2026-09-03 text is kept below because the
reasoning it contains is still what motivates the feature; the two things that changed are marked.

His words: *"Clinical content reachable only through an appointment was a reasonable default when
nothing needed otherwise; a doctor opening a past visit needs otherwise."*

**What made it necessary.** `ClinicalSection.tsx` renders the doctor's history as two lists and
neither is interactive: `recentVisits` from `clinical-summary` as bare dates, and `clinical-history`
as blocks showing date, diagnosis and complaint, **capped at `.slice(0, 5)`**. So the doctor can see
that a visit happened and read one line of it, and can do nothing else — no examination, no plan, no
notes, no attachments. History that cannot be opened is a list of dates.

**Why it could not simply be made clickable.** There was nowhere to click *to*. Every clinical read
in the system is keyed by appointment — `GET /appointments/:id/clinical-summary` and
`/clinical-history` — and a visit had no address of its own. That was not an oversight: it fell out
of the queue being the only way anyone reached clinical content, and it held until a doctor needed
to look backwards rather than at the patient in front of them.

**The shape.**

| | |
|---|---|
| Route | ~~`GET /visits/:id`~~ → **`GET /appointments/:id/visit`** (revised 2026-09-05) |
| Capability | `visits.readContent` — `DOCTOR` only, unchanged. The same gate the appointment-keyed routes already use |
| Returns | One visit's full clinical content: complaint, medical history, examination, diagnosis, treatment plan, notes, follow-up — plus its attachments (Q10/Q11) **and its `visit_revisions`** (revised 2026-09-05) |
| Not found | 404 for another tenant's visit, indistinguishable from one that never existed |

**The access question this reopens, and it is the real work.** `clinical.access.ts` currently gates
level 2 on `own patient && PRESENT`, with a transfer grant relaxing presence (D24). A doctor opening
a visit from *history* is by definition not looking at a present patient — so `PRESENT` cannot be
the rule for this route, or it refuses exactly the case it was built for.

The honest reading is that presence was always a proxy for *"this patient is your business right
now"*, and for a past visit the better question is **"was this your visit"**. So the rule to build:
~~a doctor may open a visit they authored, unconditionally; a colleague's visit follows the existing
level-2 rule and its transfer grant.~~

**Revised 2026-09-05, and the revision is a reversal.** The authorship exception was built and the
founder rejected it:

> *"Adding an authored-by-me exception would let a doctor keep access to a patient they no longer
> treat, forever, on the strength of having once written a note. That's exactly the permanent-access
> accumulation I rejected when we designed episode-scoped grants. The rule stays: current ownership
> or an active grant. If a doctor needs to see something they wrote for a patient who has moved on,
> that's a request through the clinic, and it should leave a record."*

**The rule is therefore the unchanged Level 2 rule, with nothing added: own the appointment and have
the patient present, or hold an accepted, unexpired transfer grant.** Authorship grants nothing,
because it is a fact about the past that never expires.

**And the route is appointment-scoped, for the same family of reason:**

> *"Every clinical read in this project resolves ownership through the appointment, and a
> visit-scoped route means a second ownership path that has to stay in step with the first. We've
> already found this exact shape five times — a check that exists in one place and not in its
> sibling. One path, one rule. If a doctor has a transfer grant on the appointment, they see the
> visit; that composes for free."*

The visit-scoped version proved his point rather than refuting it: it carried its own presence
logic, and that logic was wrong on the first attempt — it asked whether the *visit's own*
appointment was present, which is a month-old `COMPLETED` row, so a colleague with the patient in
front of them was refused. A test caught it; nothing structural would have. The route now calls
`resolveAccess` and there is no second path to keep in step.

**A consequence worth stating, because it changed two other payloads:** an appointment-scoped route
needs an appointment id to address, and neither `clinical-summary`'s `recentVisits` nor
`clinical-history`'s `visits` carried one. Both now do.

**It must join the leak sweep.** A route returning full clinical content is precisely what
`clinical-leak-guard.integration.spec.ts` exists to police, and Q13's classification guard means it
cannot merge unclassified — it will be registered *doctor-only* and owe a paired test that a
`RECEPTIONIST` token gets **403 at the guard**.

**Ordering.** This lands with the attachments checkpoint rather than before it, because the payload
includes attachments and building it twice — once without them, once with — would mean two reviews
of one screen.

**Amended 2026-09-14 — R-B, and it reverses the read half above.** The founder's words: *"a doctor
may READ the full record of any patient who has a completed visit with them, from a new «مرضاي» tab
(their patients only, search within). Writing still requires presence or an accepted transfer. Other
doctors' patients: unchanged — transfer or presence only."*

This is not the authorship exception he rejected on 2026-09-05, and the difference is the whole of
it. That one keyed on having written a note, which is a fact about a document; this keys on a
**completed visit**, which is a fact about having treated the person — and it opens **reading only**,
so nothing accumulates that can change a record. `AccessContext` therefore carries two flags rather
than one: `mayReadFullHistory`, which the third door widens, and `mayWriteClinical`, which stays
exactly where this section left it.

**Guard: a doctor cannot list or read a patient they never treated.** Both halves are asserted —
a colleague's patient is absent from `GET /patients/mine` and refused by `GET /appointments/:id/visit`
— and a **booking is not treatment**, because reception creates bookings and a relationship anyone
at the desk can manufacture is the reason Level 2 was never gated on one.

### Q17. How many drafts can one doctor have open? — **RULED by the founder: as many as they have unfinished visits. The store is per draft, never a single slot.**

His words: *"a doctor with two half-written visits open is the ordinary case in a clinic, not an edge
case, and a single-slot store loses one of them silently."*

**The server side already satisfies this by construction** and it is worth saying why, so nobody
"fixes" it later: a draft is a `visits` row keyed by appointment and author (Q2), so N unfinished
visits are N rows and there is nowhere for a second one to collide with a first. The partial unique
index added in Q2 constrains only `COMPLETED` rows, deliberately — several drafts, one finished
visit.

**The client side is where a single slot would appear**, and it would be an easy thing to write
without noticing: one "current draft" object in a store, one autosave timer, one "unsaved changes"
flag. Every one of those is a single slot, and each loses the other draft silently — which is the
failure mode that matters, because nothing errors and the doctor discovers it later or never.

So the requirement, stated as a requirement rather than left implied:

- draft state is **keyed by visit id**, never held as "the open draft";
- autosave is **per draft**, so two drafts in flight save independently and one failing does not
  block or discard the other;
- the save indicator (Q4) reports on **the draft being looked at**, not a global status — a shared
  indicator would show "saved" while a different draft's save was failing.

The realistic path here is not two browser tabs. It is a doctor interrupted mid-visit, seeing an
urgent patient, and coming back — which is an ordinary morning, and the reason this is not filed as
an edge case.

### Q16. What would it take to test one screen on a real iPhone? — **His question. Answered here; his decision.**

Checked on 2026-09-02, not assumed.

**Direct answer to the framing "if it really is `--host` plus a URL": for the login screen and the
component gallery, yes — genuinely. For anything behind a login, no, and the reason is one line of
our own code rather than anything about Safari.**

**What already works, and it is more than expected.** The dev server proxies `/api` server-side, so
the phone only ever talks to Vite on 5173 and the API stays on `localhost:3000` needing no exposure.
And the app uses **no secure-context-only browser API** — no `crypto.subtle`, no service worker, no
`navigator.clipboard`, no geolocation, and there is no PWA manifest to fail. Those are the usual
reasons "it works on desktop but not on the phone", and not one of them applies here.

**The three steps.**

1. `npm run dev -- --host`. `vite.config.ts` sets `server: { port: 5173 }` with no `host`, so it
   binds loopback only; `--host` binds all interfaces and prints the LAN URL.
2. **A Windows Firewall inbound rule for 5173** on the private profile. Without it the phone times
   out with no error logged anywhere, which reads exactly like a mistyped IP address.
3. Phone and machine on the same network, client isolation off — most home routers are fine, most
   guest networks are not.

**And the part that is not obvious.** `auth.controller.ts:65` sets the refresh cookie
`httpOnly; Secure; SameSite=Strict`, and **`secure: true` is hardcoded, not conditional on
environment**. Safari will not store a `Secure` cookie delivered over plain `http://192.168.x.x`.
So over the LAN:

- login **appears to succeed** — the access token returns in the response body and lives in memory;
- the app works for **fifteen minutes**, the access token's TTL;
- the first page reload calls `/api/auth/refresh` with no cookie, receives 401, and logs the
  reviewer out.

That presents as *"Safari doesn't keep me logged in"* — a browser bug — when it is a cookie flag.

**So the split, which is what his decision turns on:**

- **Layout, RTL and typography: available today, three steps, no ruling needed.** The login screen
  and the component gallery need no session, and between them they exercise the 34 CSS
  logical-property utilities and the Arabic rendering that have never met WebKit.
- **Anything behind a login needs one more decision**, and I would not pick between these because
  one touches auth:
  - **a locally-trusted dev certificate** (`mkcert` plus `server.https` in Vite) — leaves
    `secure: true` untouched, which is the safer property; costs installing a CA on the iPhone once;
  - **making `secure` conditional on an environment variable** — one line, and a change to how auth
    cookies are issued, which CLAUDE.md says to ask about. A flag that can be off is a flag that can
    be off in production, so it would have to fail closed and be asserted by a test.

**My recommendation stands: do the three steps and look at the login screen and gallery before the
visit screen is written**, which is what he said he would do if it were cheap. It is the cheapest
possible version of a check that has been open across three phases, and every screen this phase adds
compounds it.

---

### Q19. Money can arrive before the invoice exists. What does an unsettled appointment mean? — **RULED by the founder 2026-09-03: clinic credit by default, refundable on request, never forfeit.**

Raised by the founder on 2026-09-03, out of how the clinic actually runs: patients reach the clinic
through the WhatsApp bot or by walking in, an initial consultation is opened either way, and
**payment may happen before or after the visit**. A patient who pays at the desk on the way in has
created money that exists before any invoice does.

That collides directly with "the invoice is generated at COMPLETE". His resolution, and it is the
right one: the model is not invoice-then-payment. **Payments are recorded against an appointment at
any time, and COMPLETE produces the charge, which settles against whatever was already paid.**

**Does the schema support that ordering? Partly — and one thing must move.**

`payments.appointment_id` and `payments.visit_id` are separate and both nullable, so a payment can
already be attached to an appointment that has no visit. The ordering is expressible today.

What does not survive: `payments.service_price_minor` and `payments.amount_due_minor` are both
`NOT NULL`. A pre-payment has no due amount, because the thing that would decide it has not
happened. Filling them at booking by copying `services.price_minor` *is* the invoice-at-booking
model wearing different column names, and it silently reintroduces everything Q20's charge design
exists to avoid.

**So `amount_due_minor` means nothing before COMPLETE, and that is the argument for it not living on
`payments` at all.** The balance is not zero and not negative — it is undefined. A desk screen must
say *"paid 300, not yet invoiced"* and must never render *"remaining −300"*. Under the charge design
`payments` keeps only what a receipt knows: patient, appointment, amount, method, status, who took
it, when. Price, discount and due move to the charge.

**Note on the founder's wording.** He asked what `patient_due_minor` means. There is no such column,
on `payments` or anywhere else — checked across the schema on 2026-09-03. The name is worth
recording because it is close to something real: `schema.prisma:673` rules that
`insurance_policies` carries **no money** and that coverage belongs to *"the payer split on
`payments`"* — a split that was designed, written down, and never given columns. Q20 is where it
gets them.

**The sub-question pre-payment forces — money is taken and the patient never arrives — is ruled.**
There is a payment against an appointment that will never produce a charge. **Clinic credit by
default, refundable on request, never forfeit.**

His argument, and it is the reason rather than the preference: *"A clinic that keeps money for a
visit that didn't happen will be arguing about it at the desk, and forfeit-by-default is the kind of
rule that ends up being overridden manually every time — which means it isn't the rule. Credit is
what actually happens: the patient rebooks and it's applied."*

That is a general test worth keeping: **a default that will be manually overridden every time is not
a default, it is a data-entry tax with a policy written on it.**

**Still to be checked with the pilot doctor**, at his instruction — *"this is a business-practice
question and he'll answer it in one sentence."* The ruling is what gets built and nothing waits on
the answer; the question is whether the ruling matches what an Egyptian outpatient clinic actually
does at the desk. If it comes back differently, the change is a default, not a migration.

**What the ruling implies for the charge schema, and it must be settled before Phase 5's C is
built:** clinic credit is a **patient-level** balance that outlives the appointment that produced it,
because it is consumed by a different appointment entirely. So it cannot be modelled as a property of
the abandoned appointment. Whether it is a `patient_credits` ledger or an unallocated payment row
that later attaches to a charge is an open design question, and it belongs with C rather than here.

### Q20. `startConsultation` sends a WhatsApp message. What does it do before WhatsApp exists? — **RULED by the founder 2026-09-03: queue the intent; the message is a per-clinic setting, default OFF; and retry policy is per message type.**

Also raised on 2026-09-03: when the doctor presses **START CONSULTATION**, the patient receives a
WhatsApp message telling them to go in.

This is unlike everything built so far. Every notification in the system today is in-app and aimed
at staff. This one leaves the building, and it means `startConsultation` has a side effect beyond a
status change — in a state machine that was signed off in Phase 3.

**Consequence 1 — the queue now depends on Phase 6. Recommendation: queue an intent, do not do
nothing.**

Doing nothing until WhatsApp lands means that on the day it does, someone reopens a Phase 3
transition, adds a side effect to a state machine two phases old, and re-verifies it — with no
record anywhere of what the message was supposed to say or when it was supposed to fire. Queuing
costs one insert now and makes Phase 6 a *consumer* rather than an editor, which is exactly the seam
`ARCHITECTURE.md` §19 already specifies: *"future modules subscribe rather than reaching into other
modules' tables."*

The shape: an append-only, tenant-scoped `outbound_message_intents` row written **inside the same
transaction as the status change**, status `PENDING`. Phase 6 drains it. Until Phase 6 there is no
drainer, so rows accumulate `PENDING` — harmless, and worth more than they cost: they measure the
real outbound volume of a live clinic before a single message is paid for, which is the number
`PRICING.md` is currently guessing at (see below).

**Consequence 2 — a send can fail and the consultation still started. Recommendation: the intent is
transactional, the send is not.**

The intent write shares the transaction so it cannot be lost; the send is a job outside it. A failed
send therefore cannot block or roll back a transition that has already happened in the room. That is
the ordinary outbox pattern and it is the correct one here.

**The failure must reach reception, not a log.** The intent carries `status`
(`PENDING` / `SENT` / `FAILED`), `attempts`, `last_error`, `failed_at`, and the queue row shows a
small indicator when this patient's your-turn message failed. The reason is operational, not
cosmetic: the response to a failed your-turn message is a human walking out and calling the name. A
failure only visible in a log is worse than no message at all, because the desk believes the patient
was told.

**Retry policy — RULED 2026-09-03, per message type, so that Phase 6 does not build one global
policy and then discover the distinction.**

| Message type | Policy | Why |
|---|---|---|
| **Your-turn** | **One retry within 60 seconds, then stop and surface to reception** | *"Late is worse than absent."* A your-turn message arriving four minutes on is worse than none: the patient has already been called, or has already missed the turn |
| **Appointment reminders** | **Retry hard** | Not time-critical |
| **Follow-up recalls** | **Retry hard** | Not time-critical |
| **Prescription links** | **Retry hard** | Not time-critical |
| **Payment links** | **Retry hard** | Not time-critical |

The shape this implies: retry policy is a property looked up **by message type** when an intent is
drained, not a constant in the drainer and not a per-tenant setting. Phase 6 owns the drainer; this
table is what it must implement.

**Message budget — it is already counted, but at the wrong rate.**

Confirmed against `docs/PRICING.md`: the per-visit table lists **`Queue / your-turn notification |
0.25`**. It is a row of the existing four-plus-two model, not a fifth type appearing from nowhere.
So the founder's question is answered: **already counted.**

But 0.25 means one visit in four. If `startConsultation` always sends, the rate is **1.00**, and the
message cannot bundle — it is time-critical and fires mid-visit, so it cannot ride along with the
reminder or the prescription-plus-payment message. `PRICING.md`'s standing rule (*"every new
outbound message type must justify why it cannot ride along with an existing one"*) is satisfied,
but at full price:

| | Unbundled | Bundled |
|---|---|---|
| PRICING.md as written | 4.55 | 2.55 |
| With your-turn at 1.00 | 5.30 | **3.30** |

That is **+29% per visit on the bundled figure**, and it lands on the case `PRICING.md` already
names as thinnest — the single-doctor clinic at 37% margin. The 1,000-message base allowance covers
roughly 390 visits at 2.55 and roughly 303 at 3.30.

**The ruling was never "is it counted" but "is it always" — and it is: RULED 2026-09-03, a per-clinic
setting, default OFF.** The clinic switches it on, and the pricing page states what it costs.

His reason: a message that **cannot bundle**, is **time-critical**, and lands **+29% per visit on the
tier `PRICING.md` already names as thinnest** is not something to switch on for everyone by default —
*"a clinic with a waiting room where everyone can hear their name called gains nothing from it."*

So **`PRICING.md`'s 0.25 stands, and stands honestly**: it was always described as a blended average
across clinics, and an opt-in setting is exactly what makes a blended average the right figure. Had
the message been always-on, 0.25 would have been a number the product itself contradicted.

**Two consequences to carry into Phase 6, both of which follow from "default OFF" rather than from
the message itself:**

- **The intent is written only when the setting is on.** A `PENDING` row for a clinic that has the
  feature switched off is not a queued message, it is a message the clinic declined; draining it
  later would send something nobody asked for.
- **Therefore the volume measurement narrows, and this is a real cost of the ruling.** The queued
  intents were argued above as a way to measure a live clinic's true outbound volume before paying
  for a single message. With default OFF, that measurement now comes only from clinics that opted
  in — which is a biased sample, since a clinic that opts in is one that expects to use it. The
  number is still worth having; it is no longer a projection of the whole book.


---

## 4b. Rulings from the visit-screen review, 2026-09-08

Thirteen, from the founder's first look at the built visit screen. One line each, with the reason,
because the reason is the half that survives when the requirement is re-read.

**Q21. The visit screen carries a fixed patient header** — name, age, sex, phone, insurance, a red
allergy alert, visit count and last visit date. *The doctor was working on an anonymous record.*

**Q22. The clinical profile holds past medical and surgical history, chronic conditions, chronic
medications, family and hereditary history, risk factors, height, and links to allergies — and it is
APPEND-ONLY, author and timestamp per entry.** Any doctor may add; nobody edits or deletes. *D5's
spirit: a clinical record that can be silently rewritten is not a record.* Shown expanded on a
patient's first visit, collapsed above the visit afterwards with "last updated by".

**Q23. Per-visit `medicalHistory` becomes "history of present illness".** Past history lives in the
profile only. *One field was carrying two different questions, and the durable one was being retyped
every visit.*

**Q24. New per-visit fields: investigations requested, follow-up, and a structured prescription.**
Investigations are free text plus structured lines; follow-up is an interval or a date and **creates
the next appointment on completion**; the prescription is lines of drug/dose/frequency/duration/note
plus a free-text note. *These are what the visit produces; without them the screen records thinking
and no output.*

**Q25. A procedures section on the visit** — reception's recorded consultation plus doctor-added
services from the clinic's list, with quantity and a price snapshot. *Extends
`PHASE-5-DESIGN.md`'s "the invoice is built at COMPLETE from recorded procedures" rather than
inventing a parallel model; that document already rules the invoice is generated at completion.*

**Q26. An "إنهاء الزيارة" button at the bottom completes the visit (Q6) and returns the patient to
reception.** *The completion trigger Q6 chose was the queue's action; this gives it a home on the
screen where the work actually finished.*

**Q27. The stock button is present, disabled, labelled "قريبًا", with a tooltip and no handler.**
**A deliberate exception to the no-dead-buttons rule**, ruled by the founder. *`AppShell` renders
`aria-disabled` "coming soon" nav items for the same reason — a visible gap is information, where a
missing one is indistinguishable from a bug. It is an exception because it is a button rather than a
nav item, and a guard asserts it stays disabled.*

**Q28. Clinic identity and doctor print fields are pulled forward from Phase 5** — clinic name, logo,
address, phones; and per doctor a printed name and title, syndicate number, signature image and stamp
image. *Printing needs them, and Q9 rules that a prescription prints.*

**Q29. Printing stays browser print (Q9); a PDF is the browser's "save as PDF".** Three documents in
Egyptian visit-paper layout on clinic letterhead: prescription, medical report / visit summary, and
investigations request. *No PDF service, no new dependency — the ruling Q9 already made, now with the
document list attached.*

**Q30. Family linking on intake and on patient detail**: rows of a patient search plus a relationship
from husband/wife/son/daughter/father/mother, **bidirectional**. *D28's household is a shared phone;
this is kinship, which is a different fact — a son may have his own number and still be a son.*

**Q31. Date of birth is typed `dd/mm/yyyy` with a computed age beside it, past years only, and the
national ID fills it.** *A date picker is slow for a birthday forty years ago, and the age beside it
is how a receptionist notices they typed the wrong decade.*

**Q32. Booking a newly-registered patient must select them automatically — it does not.** *A bug
introduced in PR 7a: the code searched by patient id, and search matches name, phone and national ID,
so a UUID matched nothing and the selection was silently null.*

**Q33. After Phase 4's visit cycle closes, Phase 5 (invoicing and payments) starts, then an inventory
module as a new phase with a design document first, and only then Phase 4's remaining items** — the
attachments UI and the iPhone check. *The visit cycle has to be usable end to end before anything
else earns time.*

## 4c. Rulings from the run of 2026-09-09

Three, taken while PRs 4 through 8 were merging. Q6's is a resolution of an existing flag rather than
a new question; Q34 and Q35 are new.

**Q6 (resolved). The doctor who completed a visit may amend it for 24 hours without the patient being
present.** Still an amendment — reason required, `visit_revisions` row written; only the presence
condition is relaxed, and only for the completing doctor. After 24h Q18 applies unchanged.
`SCHEMA-DECISIONS.md` D35. *Guard the founder attached: a second doctor is refused inside the window.*

**Q34. A consultation can be PAUSED** — the patient stepped out for imaging or a lab — with an
optional reason. The draft stays open and private; PAUSED counts as present for the same doctor; the
queue shows it distinctly to reception; "resume" returns it to IN_CONSULTATION. It goes through the
appointment state machine with its own `legalFrom`. D36. *Guards: reception can neither pause nor
resume; a paused draft is still refused to a second doctor.*

**Q40. Starting, pausing, resuming and completing a consultation are the appointment's own
doctor's.** Reception keeps check-in, transfer and no-show. Enforced at the route (`visits.write`,
DOCTOR-only) **and** in `moveOwn`, which refuses a colleague. *Which patient a doctor starts seeing
is not a desk fact; who is here, who has gone and who is being handed on are.* Guard: reception's
start is 403 and the row does not move.

**Q41. The «مريض جديد» button is always beside the search**, not only after an empty result. *A
receptionist with a walk-in in front of them already knows the patient is new; searching for someone
they know is absent, in order to be shown the button, is a step that existed only because the button
lived inside the empty state.* The search still comes first, which is what keeps duplicates down.

**Q42. Patient detail is editable by permission.** Reception edits personal, contact, insurance and
family; the «ملف ناقص» badge clears when the record is complete, because it is derived. Guard:
**reception cannot write any clinical field through this path** — a clinical name on the patient PATCH
is refused by the whitelist rather than silently dropped.

**Q31 amended 2026-09-09: date of birth is three selects** — day, month, year, the year list running
back from the current one — with the age still computed beside them, and the national ID filling all
three. *A select cannot produce 31/02, and the typed `dd/mm/yyyy` could.*

**Q37. Clinic settings gains tax registration number, commercial register number, email, WhatsApp
number, printed working hours and a tagline.** All nullable and all free text; **the letterhead prints
what is filled and omits what is not**. *Working hours are text and not a schedule: a letterhead
carries a phrase, which no set of columns reproduces without inventing a second calendar beside
`schedule_templates`.* `SCHEMA-DECISIONS.md` D39.

**Q38. The «بيانات الطبيب المطبوعة» screen is removed.** Its fields — printed name, title, syndicate
number, signature, stamp — move onto the doctor's own record in the Doctors screen, and a doctor
edits their own from the account menu as «بياناتي». *A doctor's printed identity is a property of the
doctor; a second screen listing doctors to edit one field of was a second place to look for the same
record. A person's own details are not a section of the clinic, so they do not belong in the sidebar
beside Services and Doctors.* D40.

**Q39. No stored enum value reaches a screen untranslated.** *Patient detail showed `MALE` and
`ACTIVE` in the middle of an Arabic record.* Guarded by a sweep whose field list is derived from
`schema.prisma` rather than written down — which found a second occurrence nobody had reported, the
doctor's clinical panel rendering `{summary.gender}` raw.

**Q36. The settings screens Q28's fields had no interface for.** Admin gets «إعدادات العيادة» — name,
address, phones, and the logo with preview, replace and remove. Admin *and the doctor themselves* get
the doctor's print fields — printed name, title, syndicate number, signature and stamp. Nav items for
both, gated like the routes. *7f shipped the API without a screen, so every printed sheet came out
with no logo, no signature and no stamp, and the fields were reachable only with a token and curl.*
`SCHEMA-DECISIONS.md` D38. *Guards: the print sheet renders an uploaded logo and signature as
rendered output; the route↔capability manifest covers the new routes.*

**Q35. The visit screen carries a tab bar** listing the doctor's IN_CONSULTATION and PAUSED visits,
each tab showing the patient's name and **that draft's own save state**. Switching tabs never flushes
or blocks the other draft's autosave (Q17). D37. *Guard: two drafts open, one save failing, the other
still reports saved.*

**Q43. Printing was blank, and the fix is where the sheet is mounted — not what the stylesheet
matches.** `print-styles.ts` hides the application with `body > *:not(#print-root)`, and the sheet
rendered inside `<div id="root">`, so the rule hid its ancestor and took the sheet with it. *A
descendant of a `display: none` element cannot be brought back by any `!important` of its own, which
is why the existing guard — asserting the markup and the selectors separately — stayed green.* The
sheet is now portalled to `document.body`. `SCHEMA-DECISIONS.md` D43. *Guard: the print root's parent
is `document.body`, the stylesheet still says direct-child, and exactly one print root exists.*

**Q43b. The print dialog's document title is the document's name and the patient's**, restored
afterwards. *"Save as PDF" uses the title as the filename, so every sheet a clinic saved would
otherwise be called "Clinic OS"; restoring it keeps a patient's name out of the browser tab.*

**Q44. The open-visit tabs show only today's consultations for this doctor.** *Reproduced before it
was fixed, and the answer was both halves the founder asked between: the query had no date filter at
all, **and** the data held several — three IN_CONSULTATION rows for one doctor spanning fifteen days.
The data half is not a seeding artefact: a consultation nobody completes stays open forever, so any
real clinic accumulates them, and a tab bar without a date grows for the life of the practice.* The
day is the clinic's own, from the same `clinicDayBounds` the queue uses. D44.

**A real print-media test needs a browser, and is proposed rather than added.** Nothing in jsdom
applies `@media print`: it parses the stylesheet but never evaluates the query, so the one assertion
that would have caught this bug — *what is actually visible on paper* — cannot be written in the
current suite, and the structural guard above is a proxy for it. A real check needs Playwright, whose
`page.emulateMedia({ media: "print" })` makes the print cascade apply to a live layout, at which
point asserting the sheet is visible and the application is not is the literal statement of the
requirement. The cost is a new dependency, browser binaries in CI, and a third runner beside Jest and
Vitest — which is why this is a proposal and not a commit. It would pay for itself beyond printing,
being also the only way this project could assert that an RTL layout renders correctly.


**Q45. Printed documents are English, whatever language the interface is in.** A patient carries a
prescription to a pharmacy that reads Latin trade names, to an employer, and sometimes abroad; the
screen's language is the reader's preference and the paper's is not. *So the sheets do not go
through `t()` at all — a translated label would make the paper follow the screen, and the bug would
be invisible to anyone working in English.* The layout is a clinical form: a large letterhead (logo,
clinic name, tagline, address, phones, email), a patient block (name, date of birth, age, sex, file
number, phone), a visit block (date, time, doctor, licence number), the prescription as a table (#,
medication, strength, form, dosage & instructions, duration, quantity), follow-up, notes, signature
and stamp, footer. `SCHEMA-DECISIONS.md` D45. *Guard: the interface catalogue is Arabic and the same
words are English on the sheet, with the Arabic ones absent.*

**Q45a. New fields: clinic name and address in English, and the doctor's printed name in English.**
All three nullable, and the sheet falls back to the Arabic value rather than refusing to print — a
settings box cannot become a precondition for handing a patient a prescription.

**Q45b. A patient with no English name prints the transliteration.** `name_search_latin`, which the
patient search already maintains (D19) — not a second transliterator, so the sheet and the search
agree on how a name is spelled in Latin. **Shown to the doctor before the dialog opens**, because a
transliteration is a guess and the doctor is the only person who can catch a wrong one.

**Q45c. Dates on paper are written out, not left to `Intl`.** *Found while building this:
`toLocaleDateString("en-GB", { month: "short" })` returns "Sept" on Node's ICU and "Sep" in some
browsers, so the same visit would print differently depending on where the page ran.* One string,
decided in `print-english.ts`.

**Q46. Sick leave is recorded on the visit and printed as its own page.** Days, a start date and an
optional note, in the same print job as the prescription, in English, on the letterhead, with the
signature and stamp; the print count is kept like the prescription's. *The three fields move
together — the database refuses a half-written certificate — and an unissued one is not printed at
all, which is the one place a sheet is dropped rather than printed empty: an empty prescription is a
statement that nothing was prescribed, while an empty sick note is not a document.* D46.

**Q47 — BLOCKED ON LICENSING, 2026-09-09; see §4d. The pull request is removed, not deferred.**

**Q47. A medication reference, global rather than tenant-scoped — inspection first, and the
inspection is reported below.** Trade name EN, trade name AR, composition, manufacturer, class,
route; no prices; case-folded exact matching stays; free text remains allowed and is flagged "not in
the reference" on the screen and on the stored line. **Nothing is built until the founder confirms**,
and three findings from the inspection are for him rather than for the code:
its licence is a README badge with **no LICENSE file** and GitHub detects none; the only provenance
in the repository is a commit message reading *"Refresh prices from Drug Eye"*, which is a
commercial product rather than the EDA register; and the reference's trade names embed strength,
form and pack size in one string (`LEXOPAM 1.5MG 30 TAB.`), so autocompleting on them does not yield
the clean trade name Q45's new `strength` and `form` columns expect.


---
## 4d. What Phase 4 closes with — ruled 2026-09-09

Four rulings taken as the phase closed, recorded here rather than in a status section: each is a
decision, and decisions do not go stale when a branch merges.

**Q47 is blocked on licensing, and 7m is removed.** The Egyptian drug dataset was inspected before
anything was built, and the inspection is why. **The repository contains no LICENSE file** — only
`README.md` and `data/` — and GitHub's own licence detection returns nothing; the CC0 claim is a
README badge and a paragraph. The **only statement of provenance anywhere in the repository** is a
commit message reading *"Refresh prices from Drug Eye"*, which is a commercial product rather than
the EDA register, and a public-domain dedication is only valid from someone entitled to make it.
**Nothing from that dataset enters the product**, and the medication-reference pull request is
removed rather than deferred: it returns if and when a licensed source exists. Autocomplete
therefore stays what it has always been — this clinic's own prescribing history, case-folded exact.

**Print polish and any remaining English-name refinements go to the end of the roadmap, not to Phase
5.** They are improvements to a thing that works, and Phase 5 is money — the visit produces a
document today, and a better-looking document earns no time ahead of billing the visit.

**A patient file number — sequential per clinic — is an open item carried into Phase 5.** Q45's
printed patient block needs one and there is none in the schema: patients are identified by a UUID
and no per-clinic numbering exists anywhere in the project, so the sheet prints a stable reference
derived from the id. **Invoices and receipts will need the real thing**, which is what moves it into
Phase 5 rather than leaving it with the print work: it is a numbering policy (per clinic, sequential
from where, printed on a card the patient keeps) and a migration, not a formatting change.

**9b and 10 stay deferred, as previously ruled** — the camera on a real device, and the iPhone
check. Both need hardware in a hand rather than a test, and neither blocks the visit cycle.

---
## 5. Schema changes

| Change | From |
|---|---|
| ~~`DRAFT` in `VisitStatus`~~ — **already present** since Phase 1 | Q2 |
| ~~Structured dose fields on `prescription_items`~~ — **already present** | Q8 |
| **A revision counter on `visits`** for compare-and-set | Q7 |
| **A partial unique index — one `COMPLETED` visit per appointment.** Not one *row* per appointment: several drafts may exist, one may finish | Q2, Q15 |
| `visits.last_saved_at`, or reuse `updated_at` — reuse unless a reason appears | Q4, Q5 |
| **`appointments.quoted_price_minor`** — nullable, written at booking, never backfilled | `PHASE-5-DESIGN.md` §2.2, ruling 1 |
| **No new table.** If one appears, a ruling went the other way | — |

So: **two integer columns and one partial unique index.**

**Why `quoted_price_minor` is nullable, which looks like the weaker choice and is not.** Every
appointment booked from now on writes it, so the column is `NOT NULL` in practice for every row the
feature touches. It cannot be `NOT NULL` in the schema without backfilling the rows that already
exist — and the only value available to backfill them with is **today's** `services.price_minor`,
which is exactly the falsification the column was added to prevent. A backfilled row would assert
"reception quoted this patient 300" about a conversation that either never happened or happened at a
different number, and it would be indistinguishable from a row that recorded a real quote. **`NULL`
means "no quote was recorded", which is the truth about every appointment booked before this column
existed.** A screen must render that as *"not recorded"*, never as zero and never as the current
price.

**A correction to `ARCHITECTURE.md` §4 belongs with this.** It describes
`appointments 1:0..1 visits`; checked on 2026-09-02, nothing enforces that and `visits` carries no
unique index on `appointment_id` at all. After Q15 the documented relationship is also no longer the
one we want — several drafts, one completed visit — so §4 should be corrected to say that, rather
than left describing a constraint that never existed and is now deliberately not wanted.

**`prisma/sql/` next free number is 22**, checked against every branch rather than `develop` alone.

---

## 6. Definition of Done

Ticked against evidence, never recollection. An unticked box costs nothing.

**Clinical boundary**

- [ ] Every route in the product is classified doctor-only or reception-facing, and an unclassified
      route **fails the build** — proven by adding one and watching it fail (Q13)
- [ ] Every endpoint added here is in the sweep, or paired with a 403-at-the-guard test
- [ ] `clinical-leak-guard` passes with the new endpoints included, against real clinical content
- [ ] **A draft's content is invisible to everyone but its author** — proven with a second doctor's
      token and a reception token, against a draft containing sentinel text (Q2)
- [ ] Every reader of `visits` goes through the one shared draft filter, and a reader that does not
      fails the build
- [ ] **`visitStatus` on the queue is the only visit field reception receives** — asserted as an
      allow-list over the DTO's keys, so a field added later fails this test rather than passing it
      silently (Q14). The sentinel sweep cannot catch a derived field such as a character count, so
      this box is the one that guards that
- [ ] **Accepting a transfer gives the receiving doctor an empty draft**, and the originating
      doctor's draft is neither visible to them nor attached to the finished visit (Q15)
- [ ] **A pending transfer changes nothing** — the originating doctor can still write, because the
      patient is still in their queue (Phase 3 Q16)
- [ ] **Only one visit per appointment can be `COMPLETED`** — proven by attempting a second and
      being refused by the database, not by the service (Q2)
- [ ] An abandoned draft is **derived on read** against a passed-in instant. No job, no stored
      status, and a test that moves only the clock (Q15)

**The typing guarantee**

- [ ] **A visit survives a simulated crash** — typed, client killed with no cleanup, reopened, text
      present. A kill, not a logout (Q5)
- [ ] A failed autosave is visible and persistent, and the indicator never claims "saved" (Q4)
- [ ] Reopening a draft **says** it is resuming one, with a timestamp
- [ ] Two clients editing one visit: the second is refused with a message, not silently overwritten
      (Q7)
- [ ] **Two drafts open at once both save independently** — proven by typing into one while the
      other has a failing save, and asserting neither loses text and the indicator reports per
      draft rather than globally (Q17)

**Record integrity**

- [ ] Editing a `COMPLETED` visit writes a `visit_revisions` row **with a reason**, and the original
      values are recoverable from it (Q6)
- [ ] `visit_revisions` cannot be updated or deleted — the D5 trigger proven by attempting both
- [ ] A draft survives its appointment being cancelled, and its author can still see it (Q15)

**Clinic-managed services and the price snapshot** — added 2026-09-03 by ruling 1

- [ ] An admin can create, price, edit and deactivate a service from a screen, in Arabic and RTL
- [ ] **A doctor's token and a reception token are both refused** on create, update and deactivate —
      proven at the guard, not by the screen hiding a button
- [ ] **Booking writes `quoted_price_minor`**, proven by booking one and reading the row — not by
      reading the code that writes it
- [ ] **Changing a service's price leaves every existing appointment's `quoted_price_minor`
      untouched** — proven by booking, changing the price, and re-reading the appointment
- [ ] **No read path for a past amount joins to `services.price_minor`** — the §2.2 rule, enforced
      mechanically rather than documented, and proven by adding such a join and watching it fail
- [ ] An appointment booked before the column existed renders as **"not recorded"**, never as zero
      and never as the service's current price
- [ ] **Deactivating a service leaves every future appointment on it untouched and honoured** (§2.3),
      and the screen warns "N future appointments use this service" and proceeds — never refuses
- [ ] **A seeded service uses `CONSULTATION`** (§2.4), so the type dropdown shows no option that no
      row in the system exercises

**The patient book** — added 2026-09-03 by ruling

- [ ] Reception can find a patient who is not in today's queue **without opening a booking dialog**
- [ ] The list is ordered by most recently seen, where "seen" is a **completed** appointment — proven
      with a patient booked in the future who does not rank above one seen last week
- [ ] Paging does not repeat or skip a row
- [ ] **A doctor is refused the book at the guard, and still reads an individual patient** — the
      second half matters as much as the first, or the ruling gets mistaken for an ownership rule
- [ ] The book is in the `clinical-leak-guard` sweep
- [ ] Rows open the Q18 detail screen, which shows visit **metadata** only

**Attachments**

- [x] Content is fetched **through the API** under `visits.readContent`, never a public or
      pre-signed URL. Proven by attempting the storage URL directly and being refused (Q11)
- [x] A reception token cannot fetch attachment content
- [x] **Reception sees which attachments exist and never what they contain** — no filename, no
      preview, no content URL, no id. Proven as raw response text against real uploaded filenames,
      and by the leak sweep, which was given an attachment sentinel because it could not previously
      see this class of leak (Q10 as amended 2026-09-05)
- [x] Type is decided by **sniffing content**, not the declared MIME type — proven with an
      executable renamed `.pdf` (Q10)
- [x] Over 10 MB is refused server-side, not only in the browser
- [x] Downloads carry `Content-Disposition: attachment` (Q10)
- [x] Archiving sets `archived_at`; no row and no stored object is destroyed
- [ ] Camera upload works on a real iPhone (Q12) — needs the device and the upload screen, which is checkpoint 8
- [ ] `docs/SETUP.md` and `docs/DEPLOY.md` updated for the new service and variable, and SETUP.md
      re-run far enough to prove the new step — **both documents are updated; the box stays open
      because the re-run has not happened.** A setup document is only load-bearing on a machine that
      has never seen the project, and this one was edited on a machine that has

**WebKit** — see §8. Not a Phase 4 deliverable by default.

- [ ] At least one screen rendered on a real iPhone, with the result recorded

---

## 7. Checkpoints

Backend first, screen last: the founder's review time is the scarce resource, and backend
correctness is proven by tests.

**Order set by the founder on 2026-09-03:** services and the price snapshot first, then attachments
and the visit detail screen. The route-classification guard keeps its place ahead of the clinical
write paths, because that is what it exists to make self-proving.

1. **Clinic-managed services** — the screen over the backend that already exists, plus its tests,
   plus `appointments.quoted_price_minor` and the write at booking. → **checkpoint**
2. **The patient book and the patient detail screen** — the list, the search on the same screen, and
   the Q18 detail screen its rows open, which Phase 3 ruled and never built. → **checkpoint**
3. **The route-classification guard** (Q13) — before the clinical write paths, because it makes every
   later checkpoint's boundary self-proving instead of hand-audited. → **checkpoint**
4. **Visit write path, draft, autosave, the shared draft filter**, with the crash test and the
   author-only visibility tests. → **checkpoint**
5. **Prescriptions: service, endpoints, autocomplete.** → **checkpoint**
6. **Attachments: storage provider, upload, sniffing, gated download.** → **checkpoint**
7. **The visit screen** — one screen, progressive disclosure. The founder's eyes. → **checkpoint**
8. **Prescription printing and the attachment UI.** → **checkpoint**

---

## 8. What remains genuinely uncertain

- **WebKit, now across four phases.** `PHASE-1.md:381`: *"no part of this application has been
  rendered by WebKit."* `PHASE-2.md` repeats it twice. Verified again 2026-09-02: no Playwright, no
  Puppeteer, no `browserslist`, no browser job in CI. Concretely exposed: **34 CSS logical-property
  utilities** — a class that has already bitten once, `4b7e14a`, *"`inset-inline-*` is not a
  Tailwind utility — it generated no CSS"*, found by looking rather than by a test — and **15
  `type="date"` / `type="time"` inputs**, which on iOS are wheel pickers rather than text fields and
  are the likeliest place an Arabic RTL form breaks visibly. Q16 prices the cheapest first look.

- **Whether a doctor who forgets a sentence should have to file an amendment** (Q6). The ruling is
  made and coherent; whether it matches how he works is a question about him, not about the code.

- **Whether patient scans may lawfully sit in a third-party bucket** (Q11). An open legal question.
  The design keeps either answer a configuration change.

- **Virus scanning is a known gap** (Q10), flagged rather than half-built, in his own framing.

- **Phase 3's unbuilt items, inherited explicitly rather than folded in:** the patient detail
  **screen** (its backend exists, the screen does not — ~~and the **outstanding balance** and
  **appointment history** endpoints~~, **struck 2026-09-03: PR #45 built both**, and the line is
  struck rather than edited so the correction is visible); and **the seed produces an empty queue** — recorded as actively
  false on 2026-08-31, since `generate.ts` emits no `ARRIVED`/`WAITING`/`IN_CONSULTATION`. That last
  one blocks visual review of anything queue-shaped, **including this phase's own entry point**, and
  is probably the first thing to fix.

- **`appointments.write` is still one capability doing two jobs** (Phase 3 Q25). The matrix change
  remains the founder's call.

### Deferred by ruling, not by omission

**A week or month calendar — scoped into Phase 5, 2026-09-03.** The founder ruled it out that
morning and reversed himself the same day, about his own decision rather than anyone else's:

> *"Removing المواعيد from the sidebar was my call and it was wrong. A week or month calendar is a
> real gap for reception, not a convenience — a patient calls asking 'when is my appointment next
> week' and the day view makes that a hunt. Put it back as 'قريبًا' and scope it into Phase 5. It's
> deferred, not cancelled, and the badge was honest."*

Both halves of that are recorded because the second is the one that generalises. **The test for a
"قريبًا" badge is not whether the screen exists; it is whether the work is deferred or cancelled.**
A badge on deferred work tells a user the gap is known, and removing it hides a commitment rather
than an empty promise. A badge on cancelled work promises something nobody plans to build. The first
statement of the rule — *"a permanent 'coming soon' that nothing is scheduled to deliver is a promise
nobody made"* — is true only of the second case.

The concrete requirement, so Phase 5's scope does not have to re-derive it: **reception must be able
to answer "when is my appointment next week" without hunting day by day.** That is a question about a
range, and the day view cannot answer it at any cost the person on the phone will wait for.

**`ARCHITECTURE.md` §18 now argues the wrong way and is annotated in place** rather than edited
silently — it cuts the week/month calendar with the reason *"reception works one day at a time"*,
which is the belief this ruling overturned. Left unqualified, it is exactly the sentence that would
re-cut the feature in six weeks.

**التقارير stays out, and the distinction is the point.** `ARCHITECTURE.md` §18 cuts the reports
screen — *"Three dashboard numbers answer 90% of what a small clinic asks. Reports are a month-four
feature."* — and `PHASE-3.md` records that `reports.financial` is a capability no route, service or
DTO reads. That is a rejected *need*, not a deferred build, so its badge was the dishonest kind.

**المدفوعات stays**, because payments genuinely are Phase 5 by ruling 1 of `PHASE-5-DESIGN.md` §7,
and **الزيارات stays**, because the visit detail screen is this phase.

**Two remain, and they are the founder's call rather than mine:** **المستخدمون** and **إعدادات
العيادة**. Both meet his stated test exactly — `ARCHITECTURE.md` §18 cuts both (*"Pilot clinics have
2–5 users. Seed them"* and *"Ship a settings JSON edited by the operator; build the UI when a clinic
asks twice"*), and neither is scoped in any phase document. They were left in place rather than
removed with the other two because `shell-navigation.spec.ts` carries a deliberate assertion that
only OWNER and ADMIN see them, which is a sign they were placed on purpose, and removing them means
deleting that test.

- **The doctor's validated intent is a sample of one.** §1 rests on it entirely. Worth re-asking
  after the first week of real use.
