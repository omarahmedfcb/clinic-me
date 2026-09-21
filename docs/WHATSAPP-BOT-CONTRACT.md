# WhatsApp bot — the contract

For an external developer building the WhatsApp conversation layer, and for whoever builds our half.
It defines the boundary: what the bot may do, what it may never see, how it authenticates, how it is
audited, and what it must pass before it is pointed at a real clinic.

**The bot is a client of the API. It is never a client of the database.** No direct connection, no
read replica, no export, no shared volume. Every capability it has is an endpoint someone reviewed,
and everything it can reach is decided by the same row-level security that governs a receptionist —
not by the bot's own good behaviour.

---

## 1. Two halves, two repositories

| Ours (this repository, Phase 6) | Theirs (their repository) |
|---|---|
| The bot credential and its capability set | The WhatsApp Business integration: numbers, templates, Meta review |
| Every endpoint listed in §3, with its refusals | The conversation: Arabic and English wording, menus, retries, fallbacks to a human |
| The outbound webhook for reminders and confirmations | Receiving that webhook and sending the message |
| Rate limits, audit rows, the sandbox and its test credential | Their own logging, their own uptime, their own deployment |
| This document | An implementation that passes §9 |

**Neither half ships without the other's half of §9.** The developer cannot test against a real
clinic, and we cannot accept a bot we have not watched fail.

---

## 2. Identity: one credential per clinic

A bot credential is a **membership in one clinic**, with the role `AI_AGENT` — a role the schema has
carried since Phase 2 for exactly this. One credential, one clinic: a bot serving three clinics
holds three credentials and cannot use one clinic's to reach another's data, because `tenantId`
comes from the validated token and never from the request.

**What `AI_AGENT` can do today is nothing, deliberately.** Every cell in its column of the permission
matrix is `NONE`, and `apps/api/test/unit/permissions-ai-agent-holds-nothing.spec.ts` asserts it for
every capability, with a comment saying why: a capability granted to a role nobody holds is a
capability nobody reviews. Whoever implements §3 has to delete that assertion, which is where the
conversation about each capability belongs.

Two known pieces of work that fall out of that, recorded here because they are not obvious:

- **The bot's lookup is its own capability, not a `patients.*` grant.** An earlier draft of this
  document repeated a comment in `permissions.ts` saying `patients.write` guards search, create and
  read together — that comment was stale, and the split it asked for happened on 2026-09-06 (commit
  `bbdabe1`). Today `patients.read` covers search and reading any patient by id, which is still
  wider than §3 allows the bot: it must not be able to search the book by name. So
  `bot.findPatientByPhone` is a capability of its own, exact-match only, and
  `patients-capability-boundary.spec.ts` pins the surrounding shape.
- **The booking channel is derived from the caller's role, never accepted from the request** — a
  staff lead time of zero is right for a receptionist and wrong for a remote channel. The bot gets
  its own channel with its own lead time, and cannot ask for a different one.

Credentials are issued by the clinic's ADMIN or by the operator, are revocable in one action, and a
revoked credential stops working on its **next request** — the membership-freshness check already
re-reads on every authenticated call.

---

## 3. The capability set: `BOT`

Exactly these, and each one is an endpoint, not a query:

| Capability | What it does | Shape of what comes back |
|---|---|---|
| `bot.findPatientByPhone` | Exact match on a full **E.164** number, in this clinic only | **Every patient on that number** — id, display name, relationship to the contact, and whether the file is incomplete. Nothing else. No partial match, no name search, no listing |
| `bot.createProvisionalPatient` | Creates a patient from **name and phone only**, marked as created over WhatsApp | The new patient's id and display name |
| `bot.listSlots` | Bookable slots for a doctor or service, within a window | Times and a slot token. Nothing about other patients |
| `bot.book` | Books one of those slots for the identified patient | The appointment's id, time, doctor, status |
| `bot.reschedule` | Moves an appointment the bot's clinic owns | Same |
| `bot.cancel` | Cancels one, with a reason | Same |
| `bot.readAppointmentStatus` | Status of one appointment by id | Status, time, doctor. **Not** the visit, and not what happened in it |
| `bot.recordConsent` | Records a consent the patient gave in chat | Acknowledgement only |

Consent is a first-class record here already (`consents`: purpose, granted, timestamp, who captured
it, and an `evidence` JSON). A bot recording `WHATSAPP_COMMS` writes the message id and timestamp
into `evidence`, so the clinic can show what the patient agreed to and when.

### One phone, several patients — ruled 2026-09-18

**A lookup returns the whole household on that number, not one patient.** Sharing a number across a
family is the Egyptian norm, not an edge case: a mother books for a child on her own phone. The bot
gets each member's **display name and relationship to the contact** and asks which of them the
booking is for. Those two fields and the id are all it gets — no date of birth, no national id, no
history, and nothing that would let it assemble a family's records.

The schema already carries this: patients hang off a `Contact`, each with a `relationship_to_contact`
of `SELF`, `SPOUSE`, `CHILD`, `PARENT`, `SIBLING` or `OTHER`.

### Provisional patients — ruled 2026-09-18

A patient the bot has never seen must be bookable without a receptionist, so
`bot.createProvisionalPatient` takes **a name and a phone, and nothing else**. Three properties, each
of which is a test:

1. **Any other field in the body is refused.** Not ignored — refused, naming the field. A bot that
   could pass `dateOfBirth` could pass `notes`, and free text from a chat is how clinical content
   arrives in a record nobody reviewed.
2. **It is marked as created over WhatsApp, and the bot cannot set or clear that mark.** It is
   derived from who is calling, server-side. A provenance flag a caller can choose is not provenance.
3. **It arrives incomplete, and the desk already knows what to do with it.** Intake completeness is
   *derived*, never stored (`intake-completeness.ts`, D26): a record with only a name and a phone is
   missing date of birth, gender and nationality, so it carries «ملف ناقص» in the patient book and
   in search the moment it exists — through the flow reception already uses, with no new screen.

**The bot can never edit an existing patient.** There is no update capability, so a wrong name typed
into a chat cannot overwrite a record the desk has already completed. Correcting a patient is desk
work, and a duplicate is `patients.merge`, which the bot also does not hold.

### Never readable by the bot, under any capability

Clinical notes, diagnoses, examinations, plans, prescriptions and attachments; invoices, payments,
balances and receipts; any other patient's data; staff lists, schedules beyond bookable slots,
reports and the audit log.

This is not a filter over a wider response. **Clinical content lives behind separate endpoints and
separate DTOs**, which is a standing rule of the codebase: there is no shape of request the bot can
send that returns a diagnosis, because no endpoint it can reach has one in its response type. A
sweep in CI asserts that clinical sentinels never appear in non-clinical payloads, and the bot's
endpoints join that sweep.

### One patient at a time

Every capability above takes an identified patient or an appointment the bot already knows. **There
is no list endpoint**, no "today's patients", no export. A bot that has been talking to one patient
can reach that patient; a compromised bot cannot walk the clinic's book.

The household lookup is not an exception to that, and the distinction is the point: it returns the
patients on **one number the caller already had**, never a page of the clinic's patients. A bot
holding a thousand numbers learns a thousand households and no more, which is the same thing it would
learn by asking each of them.

**A patient the bot cannot see returns 404, never 403** — the same rule the rest of the system
follows, because 403 confirms the record exists.

---

## 4. Audit

Every call the bot makes writes an audit row with the bot as actor: `actor_role = AI_AGENT`, the
credential's user id, and the clinic's `tenant_id`.

The trail reaches the conversation through `audit_logs.message_id`, which is a foreign key to our own
`messages` row — and that row carries WhatsApp's `external_message_id`. So a clinic asking "who moved
this appointment?" gets the bot, the message, and the id the developer's own logs use. Note what
`messages` deliberately does **not** hold: its `body_preview` is capped at 280 characters and is
commented "never clinical content". The message log is a delivery record, not a second patient file.

Audit rows are append-only and tenant-scoped: the bot cannot read them, and nobody can edit them.
When a clinic asks "who moved this appointment?", the answer names the bot and the message.

---

## 5. Rate limits

Per clinic, and keyed so one clinic's traffic cannot exhaust another's. Starting numbers, to be
tuned against the first weeks of real traffic:

| Scope | Limit |
|---|---|
| Per credential | 60 requests/minute |
| Per patient phone | 10 booking-changing calls/hour (`book`, `reschedule`, `cancel`) |
| `findPatientByPhone` per credential | 30/minute |
| `createProvisionalPatient` per credential | 10/hour — a bot that can create patients is a bot that can fill a clinic's book with them |

Over the limit is **429 with `Retry-After`**. The bot backs off and tells the patient it will try
again — it never retries in a tight loop, and it never presents the failure as the clinic being
closed. These limits protect the clinic's database from a runaway script, which is the failure mode
a conversation layer actually has.

---

## 6. The webhook: our side calling theirs

For reminders and confirmations, we call the bot rather than the bot polling us.

- **Transport**: HTTPS `POST` to one URL per clinic, registered through
  `POST /clinic/bot-credential/webhook`. **HTTPS only** — refused by the DTO and by a database
  CHECK, because a reminder carries a patient's first name past every hop on the way.
- **Signature**: `X-Clinic-Signature`, an HMAC-SHA256 of `<timestamp>.<raw body>` with a per-clinic
  signing secret, plus `X-Clinic-Timestamp`. The bot **must** verify it and reject anything older
  than five minutes. The timestamp is inside the signed string, not merely beside it: signing the
  body alone lets anyone who has seen one delivery replay it forever with a fresh timestamp.
- **The signing secret is issued with the credential and dies with it.** It is shown once, in the
  issue response, beside the credential's own secret; revoking the credential revokes it, and
  re-issuing rotates both. No read route ever returns it — `GET /clinic/bot-credential` returns the
  URL we call and never the secret we sign with.
- **Idempotency**: every delivery carries an `X-Idempotency-Key`, which is the delivery's own id.
  Retries reuse it. The bot must not send a patient two messages for one key.
- **Retries**: on a non-2xx or a timeout we retry at 1m, 5m, 15m, 1h, 3h, 6h and 12h — seven
  attempts inside the 24 hours — then stop, record the failure, and **write it to the clinic's own
  audit trail**. The bot returns 2xx **on receipt**, not after the message is delivered.
- **Nothing at the desk waits for the bot.** Deliveries are queued by a database trigger on the act
  that caused them and sent by a separate dispatcher, so a screen never blocks on somebody else's
  endpoint being up.
- **Events**: `appointment.reminder`, `appointment.confirmed`, `appointment.cancelled`,
  `appointment.rescheduled`.

### Consent gates every delivery — ruled 2026-09-18

Nothing is sent to a patient with no recorded `WHATSAPP_COMMS` consent, and consent is read **at
send time**, not when the event was queued: a patient who withdraws between booking and the reminder
must not be messaged. A booking made through the bot records that consent at booking time, with the
chat message id as its evidence (`consentMessageId`, required on `bot.bookAppointment`). A booking
made at the desk sends nothing until the desk records consent through the flow it already has.

A delivery that is not sent is not discarded: the row records `NO_CONSENT`, `NO_WEBHOOK` or
`PATIENT_GONE`, so "we never told the bot" is a fact somebody can look up rather than an absence.

### The body, and the whole of it — ruled 2026-09-18

The minimum: a first name, a time, who or what the visit is with, the status, and our ids. Never a
full name, a diagnosis, a note or an invoice. `test/unit/webhook-event-shape.spec.ts` pins the key
set as an exact set — the failure worth guarding against is an added key, and no list of
fields-not-to-add anticipates the next one.

| Key | What it is |
|---|---|
| `eventId` | The delivery id, and the idempotency key |
| `eventType` | One of the four above |
| `occurredAt` | When the act happened, ISO 8601 |
| `clinicId` | Our id for the clinic |
| `appointmentId` | Our id for the appointment |
| `patientId` | Our id for the patient |
| `patientFirstName` | The first token of the name, so the bot can greet them |
| `scheduledStart` | The appointment time, ISO 8601 |
| `doctorName` | The doctor, as the clinic writes it |
| `serviceName` | The service, as the clinic writes it |
| `appointmentStatus` | `BOOKED`, `CONFIRMED`, `CANCELLED`, … |

---

## 7. Error semantics

Refusals are codes, not prose: the API answers with a stable code and the bot decides the wording, in
the patient's language. `docs/REFUSAL-CODES.md` is the register.

| Situation | HTTP | What the bot should do |
|---|---|---|
| Slot taken between listing and booking | 409 | Re-list and offer the nearest alternatives |
| Outside the booking window for this channel | 422 | Say the earliest time it can book, and offer the desk |
| Unknown patient / appointment / other clinic's row | 404 | Offer to register or to hand over to a human. Never say "that belongs to another clinic" |
| Rate limited | 429 | Back off per `Retry-After` |
| Credential revoked or expired | 401 | Stop, alert the developer's own monitoring, hand over to a human |
| Our fault | 5xx | Apologise, hand over to a human, and do not retry a booking blindly — a retried `book` can double-book |

**A refusal says only what it can justify.** The bot must not translate a 404 into "you have no file
at this clinic" when it may equally mean the phone number differs by one digit.

---

## 8. The sandbox

Before any real clinic, the developer works against a review build with seeded synthetic clinics:
two clinics, doctors with real schedules, ~200 synthetic patients, and a bot credential issued for
one of them. No real patient data has ever been in it.

- Amir starts it with `npm run preview`. The build **issues the credential itself** and prints it in
  the READY banner, once: credential id, secret, webhook signing secret, and the webhook URL. There
  is no second look — the secrets are hashed or unreadable at rest, and the next preview revokes that
  credential and issues another.
- The sandbox's webhook points at a **local echo receiver** started with the stack. It logs every
  delivery and says whether the signature verified (`signature OK` / `SIGNATURE BAD`), and it
  answers 401 to a delivery that does not verify — so the developer can see a correct one before
  writing their own, and can see what a forged one looks like. The outbox is swept every five
  seconds rather than every minute, because a confirmation nobody watches arrive proves nothing.
- **None of this can exist in production.** `BOT_SANDBOX=on` is what turns it on; the API refuses to
  boot with it under `NODE_ENV=production`, and both sandbox scripts refuse to run there too — the
  same shape as `OPERATOR_TOTP=off`, and for the same reason: a flag that weakens a boundary is a
  liability the moment it can reach a server by accident.
- The seed is deterministic from a reference date, so "the 10:00 slot on Tuesday" means the same
  thing on both sides of a conversation about a bug.
- The database is disposable and gets reset; the bot must tolerate its data disappearing.
- **Nothing in the sandbox is a promise about production limits**: rate limits there are the same
  numbers, but the machine is a laptop.

---

## 9. Acceptance checklist

Every line is evidence the developer hands over, not a claim. Until all of it passes, the credential
stays a sandbox credential.

**Twelve of these run as a script.** `npm run bot:acceptance` (in `apps/api`) exercises our side
against the sandbox and prints a pass/fail report, `--json <path>` writes it out to hand back, and a
failure exits non-zero so it can gate a hand-over rather than be read charitably. The exact command,
with the sandbox's own ids filled in, is printed by `npm run preview`.

The lines it cannot run are marked **EVIDENCE** rather than passed: 1, 4, 13, 14, 15, 16 and 17 are
about the developer's own repository, their own logs, and statements only they can make. A script
that claimed those had passed would be worse than one that skipped them.

**Boundary**
1. The bot's code contains no database driver, connection string or SQL. Shown by the dependency list.
2. Attempting a clinical endpoint with the bot credential returns 403, and the attempt is in the audit log.
3. Asking for another clinic's appointment id returns **404**, not 403.
4. No response the bot has ever received contains a diagnosis, prescription, invoice or another patient's name — shown from their own logs of a full test conversation.

**Correctness**
5. A full booking conversation: find patient → list slots → book → confirm, with the audit rows that resulted.
6. A double-booking race: two bookings of the same slot, one 409, no double booking in the clinic's book.
7. Reschedule and cancel, each leaving the clinic's day correct.
8. A number with **several patients on it**: the bot asks which member the booking is for, and books
   for the one the patient named — not the first in the list.
9. A patient who does not exist: a provisional record created from name and phone, then booked for.
   Their own log shows the create body carried **only** those two fields.
10. Consent recorded, with the message id in the evidence.

**Resilience**
11. 429 handled with backoff, shown in their logs.
12. A webhook with a bad signature is **rejected**; a valid one is accepted; a replayed delivery sends no second message.
13. A 5xx from us does not produce a duplicate appointment.
14. Credential revoked mid-conversation: the bot stops and hands over to a human within one exchange.

**Operational**
15. A named contact and an escalation path for when the bot misbehaves at 9am in a clinic.
16. Their own monitoring alerts them — not us — when their side is down.
17. A statement of what they log, where it lives, and for how long. **Message content is the clinic's patient data**: it must stay in Egypt and must not be used to train anything.

---

## 10. Open questions, for Amir rather than for the developer

- **Meta's verification and template approval** are on their own timeline. Guiding Decision 4 exists
  precisely so pilot timing never depends on it.
- **Consent wording** for `WHATSAPP_COMMS`, in Arabic, is a legal question under Law 151/2020, not a
  copy question. It needs the same review as the DPA.
- **Who is Controller** for messages held on the bot's side is a contract question. The clinic is
  Controller of the record; the bot developer is a sub-processor, and the DPA has to say so.
- **What the bot may say about a visit** is a clinical-safety boundary. Today it may say nothing —
  the contract above gives it no visit content at all, and that is the safe default to start from.
