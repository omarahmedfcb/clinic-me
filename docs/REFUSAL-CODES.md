# Refusal codes — the source of truth

Ruled 2026-09-06. **The API returns `{ code, params }` and no human sentence. The client owns every
word a user reads.**

- The codes live in `apps/api/src/common/refusals.ts`; this document is their human-readable face.
- The Arabic and English live in `apps/web/src/i18n/strings.ts` under `refusal.*` and `resource.*`,
  rendered by `apps/web/src/i18n/refusals.ts`.
- `apps/api/test/unit/refusal-codes-conformance.spec.ts` fails the build when a code here has no
  Arabic, when a string exists for a code the API cannot return, and when a controller puts an
  English sentence on the wire.

## The three rules

**1. A code names what the user should DO next, not the noun that was missing.** `NOT_FOUND` is one
code carrying a `resource` param, because "no such appointment" and "no such doctor" ask for the
same next action — look again at what you clicked. A sentence earns its own code only when it asks
for something *different*: `NO_VISIT_YET` means wait, `NO_CONTACT_RECORD` means go and add contact
details, `SCOPE_TOO_NARROW` means ask an administrator.

**2. `params` carries values, never prose.** Numbers, dates, ids, enum members. A phrase cannot be
re-ordered for another language's grammar, and Arabic re-orders a great deal.

**3. Renaming a code is a breaking change; adding one is not.** The client switches on it.

## The codes

`params` lists what a message may substitute. A code with no params has a fixed sentence.

### Booking and the slot engine

| Code | params | What it means | HTTP |
|---|---|---|---|
| `SLOT_TAKEN` | — | Someone booked it between the offer and the insert. Verified by the constraint, not guessed | 409 |
| `CONTENDED` | — | Three attempts all deadlocked. **Not** `SLOT_TAKEN`: nothing established that the slot is gone (D25) | 409 |
| `INVALID_TOKEN` | — | That slot was never offered by this clinic | 400 |
| `EXPIRED_TOKEN` | — | The slot list has expired; ask again | 400 |
| `PAST_SLOT` | — | That time has already passed. **Not** `EXPIRED_TOKEN`: no fresh offer would help | 422 |
| `OUTSIDE_HORIZON` | `limit`, `until` | Beyond the clinic's booking horizon | 400 |
| `RANGE_TOO_LONG` | `limit` | Availability asked for more days than the engine will answer | 400 |

### The appointment state machine

| Code | params | What it means | HTTP |
|---|---|---|---|
| `QUEUE_MOVED_ON` | `status`, `expected` | Someone else moved this appointment while you were looking at it | 409 |
| `GRACE_PERIOD_NOT_ELAPSED` | `at` | Too early to mark a no-show | 422 |
| `REASON_REQUIRED` | — | Cancelling, or requesting a transfer, needs a reason in writing | 400 |
| `ILLEGAL_TRANSITION` | `event`, `status`, `legalFrom` | **Developer-facing.** A caller asked for an edge the state machine does not have | 422 |
| `TERMINAL_STATUS` | `status` | **Developer-facing.** Nothing moves an appointment out of a terminal status | 422 |
| `MISSING_CONTEXT` | — | **Developer-facing.** A transition was called without the facts it needs | 500 |

**The three developer-facing codes render one generic apology**, by ruling: translating *"MARK_NO_SHOW
needs now, scheduledStart and noShowGraceMinutes"* into Arabic would dress a bug up as a decision
somebody at the desk could act on. The code goes to the console; the user gets `refusal.INTERNAL`.

### Things that were not there

| Code | params | What it means | HTTP |
|---|---|---|---|
| `NOT_FOUND` | `resource` | No such thing in this clinic. **404, never 403** — a cross-tenant id must not be confirmed to exist | 404 |
| `NO_VISIT_YET` | — | The appointment exists; no visit has been recorded against it. Different action: wait | 404 |
| `NO_CONTACT_RECORD` | — | No household to attach a policy to. Different action: add contact details first | 422 |

`resource` is one of: `appointment`, `attachment`, `botCredential`, `charge`, `clinic`,
`coverage`, `doctor`, `exception`, `insuranceCompany`, `membership`, `patient`, `policy`,
`procedure`, `service`, `transfer`, `visit`.
An unknown value renders a generic
noun rather than leaving a hole in the sentence.

### The visit record

| Code | params | What it means | HTTP |
|---|---|---|---|
| `STALE_REVISION` | `revision` | The autosave carried a revision the row no longer has — someone saved first (Q7). `revision` is what the row now holds, so the client refetches once rather than twice | 409 |
| `ALREADY_COMPLETED` | — | The visit is finished. Different action from `STALE_REVISION`: amend it with a reason, do not save into it | 409 |
| `NOT_COMPLETED` | — | An amendment was sent to a visit still in draft. Different action: just save it | 409 |

### Kinship

| Code | params | What it means | HTTP |
|---|---|---|---|
| `ALREADY_LINKED` | — | These two patients are already linked as kin (Q30). Different action: remove the link, or pick another patient | 409 |

### The clinic's bot credential

| Code | params | What it means | HTTP |
|---|---|---|---|
| `ALREADY_ISSUED` | — | This clinic already has a live bot credential, and it may hold only one. Different action: revoke the one that exists, then issue | 409 |
| `INVALID_CREDENTIAL` | `resource` | What `POST /bot/auth/token` answers to a wrong secret, a revoked credential and an id that never existed alike — which of the three it was is not the caller's business | 401 |

### Permission and the care relationship

| Code | params | What it means | HTTP |
|---|---|---|---|
| `NOT_A_DOCTOR` | — | Clinical content and attachments are doctor-only (CLAUDE.md) | 403 |
| `NOT_PERMITTED` | — | This patient is not in your care | 403 |
| `NOT_PRESENT` | — | The full record opens while the patient is with you, or under an accepted transfer (D24) | 403 |
| `SCOPE_TOO_NARROW` | — | A clinic-wide action attempted with doctor-scoped permission. Different action: ask an admin | 403 |

### Attachments

| Code | params | What it means | HTTP |
|---|---|---|---|
| `EMPTY_FILE` | — | Zero bytes | 400 |
| `TOO_LARGE` | `limit`, `actual` | Over the size limit | 413 |
| `UNSUPPORTED_TYPE` | — | Not an accepted image or PDF | 415 |
| `HEIC_NOT_CONVERTED` | — | An iPhone photograph that reached the API unconverted | 415 |
| `TYPE_MISMATCH` | `claimed`, `detected` | The declared type and the magic bytes disagree | 415 |
| `VISIT_MISMATCH` | — | That visit belongs to a different patient | 422 |

### Transfers

| Code | params | What it means | HTTP |
|---|---|---|---|
| `ALREADY_OPEN` | — | This patient already has a request waiting for an answer | 409 |
| `ALREADY_DECIDED` | `status` | The request is settled. `status` says how: `ACCEPTED` or `REJECTED` by a person, `LAPSED` when the appointment ended under it | 409 |
| `SAME_DOCTOR` | — | That is the doctor the patient is already with | 422 |

**`ALREADY_DECIDED` is the only code a settled request returns, and `params.status` is not
decoration.** It absorbed `NO_LONGER_OPEN` on 2026-09-07, and with it the entire distinction
between "somebody answered before you" and "nobody could answer, because the appointment ended".
A caller that drops the param collapses three different sentences into one vague one, which is why
`transfer-state.spec.ts` asserts the three statuses stay distinguishable rather than only asserting
the code.

### Clinic management

| Code | params | What it means | HTTP |
|---|---|---|---|
| `ALREADY_A_DOCTOR` | — | That membership already has a doctor record | 422 |
| `ALREADY_A_MEMBER` | `name` | That person already has an account in this clinic — one role per clinic | 409 |
| `INVALID_PHONE` | — | Not a phone number this can parse. Correct it | 400 |
| `LAST_ADMIN` | — | The last active administrator cannot be suspended; nobody would be left to undo it | 422 |
| `SELF_SUSPEND` | — | You cannot suspend your own membership — you would be locked out of undoing it | 422 |
| `INSUFFICIENT_CREDIT` | `limit`, `actual` | More credit than the patient has. `limit` is the balance | 422 |
| `REFUND_REASON_REQUIRED` | — | A refund is given on request **with a reason**; the reason is not optional | 400 |
| `AMOUNT_NOT_POSITIVE` | — | Zero is not a movement. Money is integer minor units | 400 |
| `INVALID_PERIOD` | — | A report period that is neither a day nor a month. Ask for a real one | 422 |
| `SLUG_TAKEN` | `name` | That short name is already a clinic's. Choose another | 400 |
| `ALREADY_IN_THAT_STATE` | `status` | Suspending a suspended clinic, or reactivating a live one | 422 |
| `INVALID_FIELD` | `field` | A field the DTO refused, with `field` saying which. Added 2026-09-15: a `ValidationPipe` rejection carries no code, and a client with no code renders its generic apology — so a mistyped short name reached the operator as "a system error occurred" | 400 |
| `NOT_OPERATOR_OWNER` | — | Seating an operator, changing a seat, or clearing a second factor. The platform OWNER alone. Different action from `NOT_PERMITTED`: ask the owner | 422 |
| `TOTP_ENROLMENT_REQUIRED` | — | The operator has no confirmed authenticator. The action is to enrol, and nothing else works until they do | 403 |
| `TOTP_INVALID` | — | Six digits that are not the current code. Different action: read the app again | 422 |
| `TOTP_ALREADY_ENROLLED` | — | An authenticator is confirmed already; re-enrolling would lock the old one out. It is reset, not replaced quietly | 422 |
| `NOT_RECOVERY_SESSION` | — | Replacing the authenticator is only for a session a recovery code opened. An operator who still has theirs wants `recovery-codes/regenerate`, which demands it | 403 |
| `INVALID_DATE_RANGE` | `field` | A contract that ends before it starts, or a date that is not one | 422 |
| `INVALID_AMOUNT` | `field` | A discount outside 0–100, or an agreed price below zero | 422 |
| `CLIENT_FILE_EXISTS` | — | A clinic has one client file. It is edited, not created twice | 422 |
| `DUPLICATE_PHONE` | — | That number is already somebody's login. It parses; it is taken | 409 |
| `NOT_EDITABLE_HERE` | `name` | A doctor's record belongs to the Doctors tab, not the users list | 422 |
| `OWNER_ROLE_FIXED` | — | The owner's role is not changed from the users list; ownership transfer needs its own screen | 422 |
| `SELF_ROLE_CHANGE` | — | You cannot change your own role — you would lose the screen that undoes it | 422 |
| `PASSWORD_CHANGE_REQUIRED` | — | A temporary password is outstanding. Nothing else works until it is replaced | 403 |
| `OVERLAPPING_TEMPLATE` | — | The hours overlap something already saved for that doctor | 422 |
| `INVALID_WINDOW` | — | The end date is before the start date | 400 |
| `DUPLICATE_POLICY` | — | This patient is already on that policy | 409 |
| `DUPLICATE_COMPANY` | `name` | An insurance company with that name is already in this clinic’s registry | 409 |
| `SPLIT_EXCEEDS_CHARGE` | `limit`, `actual` | The payer share is more than the charge has left after its discount | 422 |
| `DISCOUNT_ABOVE_CEILING` | `limit`, `actual` | Only an owner or admin may discount more than the clinic’s ceiling | 403 |
| `ALREADY_SETTLED` | — | The charge is void or closed, so its split cannot move | 409 |
| `PRICE_ADJUSTMENT_NOT_ALLOWED` | — | This doctor is not set up to change a visit total; an admin turns it on (R1) | 403 |
| `PRICE_ADJUSTMENT_ABOVE_CAP` | `limit`, `actual` | Allowed to adjust, but not by that much. Different action: adjust by less | 403 |
| `COLLECTION_NOT_ALLOWED` | — | This doctor is not set up to take payment; an admin turns it on (R2) | 403 |
| `PAYMENT_EXCEEDS_BALANCE` | `limit`, `actual` | More than the patient still owes. Collect the remaining balance or less | 422 |

---

## Migration status — complete, 2026-09-06

**Every controller returns `{ code, params }`.** The register that tracked nine controllers and 46
unmigrated sites is gone from `refusal-codes-conformance.spec.ts`, replaced by the assertion it was
counting down to: no controller sends an English sentence, and none throws a bare string either --
which Nest would turn into one.

The migration found more than the register counted. It scanned for `new …Exception(result.detail)`,
so it missed 16 bare-string literals in five controllers, two of which (`patients`, `services`) were
not in the register at all.

**One documented exception: `auth.controller.ts`.** Its five refusals -- *"Not authenticated."*,
*"Session is no longer valid. Please log in again."*, *"That workspace is not available for this
account."* -- are the only English left on the wire. They are listed in the spec as awaiting a
ruling rather than migrated: the 2026-09-06 ruling was about the refusal codes the *services*
return, auth has no service-layer refusal type at all, and the login screen already renders its own
Arabic for 401 and 429 rather than the server's words. Inventing three codes for it would be
guessing at a surface nobody ruled on.

### Codes added during the migration

| Code | Why it was not in the first list |
|---|---|
| `NO_FILE_UPLOADED` | A multipart request with no file part, as opposed to `EMPTY_FILE`'s zero bytes |

### Codes removed

| Code | Why |
|---|---|
| `ILLEGAL` | Flattened every state-machine refusal into one. The machine's own code is forwarded now |
| `UNKNOWN_DOCTOR`, `UNKNOWN_SERVICE`, `UNKNOWN_PATIENT`, `UNKNOWN_MEMBERSHIP` | All `NOT_FOUND` with a `resource` |
| `NO_LONGER_OPEN` | Folded into `ALREADY_DECIDED` with `status: "LAPSED"`, ruled 2026-09-07. Both asked the reader for the same next action, and both already carried `status` — so the second code was a distinction the param was already making |

### Statuses corrected

| Code | Was | Is | Why |
|---|---|---|---|
| `SCOPE_TOO_NARROW` | 404 | **403** | Ruled 2026-09-07. The 2026-09-06 migration changed what the wire carried and deliberately left every HTTP status alone, so this table's 403 described an intent the code had not yet caught up with. It is safe to be a 403 because the refusal names no record: it fires only on a clinic-wide closure attempted by a caller holding `own`, decided from the role before any row is read. Every *other* refusal in `SchedulesController` stays 404 for the usual reason — a 403 there would confirm a doctor row exists |
| `NOT_THE_RECEIVING_DOCTOR` | Declared in a union and never emitted. A caller who is not the receiving doctor gets `NOT_FOUND`, deliberately |
