# Refusal messages: a stable code plus params, rendered in Arabic by the client

**Status: a proposal. Nothing here is built, and nothing should be until this is ruled on.**
Requested 2026-09-06: *"propose (don't implement) a design where the API returns a stable code +
params and the client renders Arabic."*

---

## The problem, stated as what a receptionist sees

The interface is Arabic and right-to-left by decision. **Every refusal it shows is written in
English**, because the client renders the server's sentence verbatim:

```ts
// apps/web/src/features/booking/booking-api.ts
return { reason: body.reason ?? "UNKNOWN", message: body.message ?? "تعذّر حجز الموعد." };
```

The Arabic string in that line is the *fallback for when the server sends nothing*. Whenever the
server does its job, the fallback is skipped and the user reads English. So a receptionist who loses
a booking race is told **"That time was taken while you were booking. Ask for availability again."**
in the middle of an otherwise Arabic screen.

There are **34 refusal codes** reaching the client today (inventory below). Every one of them is in
this position. `CONTENDED`, added on 2026-09-06, simply joined them.

This is not a translation backlog. It is a design gap: the server currently owns both the *fact* and
its *wording*, and only one of those is the server's business.

---

## The proposed shape

**The API returns a code and the data the sentence needs. The client owns every word.**

```jsonc
// 409
{
  "reason": "SLOT_TAKEN",
  "params": {},
  "message": "That time was taken while you were booking. Ask for availability again."
}
```

```jsonc
// 422, a refusal whose sentence needs facts
{
  "reason": "OUTSIDE_HORIZON",
  "params": { "days": 60, "until": "2026-11-05" },
  "message": "This clinic books up to 60 days ahead (to 2026-11-05)."
}
```

Three rules make it work:

1. **`reason` is a stable identifier and part of the API contract.** Renaming one is a breaking
   change; adding one is not. It is already returned — this proposal promotes it from a debugging
   aid to the thing the client switches on.
2. **`params` carries values, never prose.** Numbers, dates, ids, enum members. Never a
   pre-composed phrase, because a phrase cannot be re-ordered for another language's grammar and
   Arabic re-orders a great deal.
3. **`message` stays, in English, as the developer-facing explanation.** It goes to logs, to the AI
   tool layer (`ARCHITECTURE.md` §12, which calls services directly and has no client to render
   for), and to any future integrator. **The client must stop displaying it.**

The client gains one function:

```ts
refusalText(reason, params, t) // -> Arabic, from the existing i18n catalogue
```

with one catalogue entry per code — `refusal.SLOT_TAKEN`, `refusal.OUTSIDE_HORIZON` — using the
`{name}` placeholder convention `strings.ts` already uses for `doctors.upcoming` and
`shell.support.message`. **A missing entry falls back to its key, visibly**, exactly as `t()` does
today, so an untranslated refusal reads as "nobody has written this yet" rather than as a rendering
fault.

### Why not translate on the server

It would need the caller's locale on every request, and the locale lives in the client (D20 makes it
a per-user setting with a cached fallback). It would also put Arabic prose in a codebase whose
reviewer reads the code in English. The client already has the catalogue, the locale, and the
`t()` fallback behaviour.

---

## What the inventory says about the work

**`NOT_FOUND` is 24 of the 70 refusal sites and carries at least 12 distinct sentences** — "No such
appointment", "No such doctor", "No visit has been recorded yet", "This patient has no contact
record, so there is no household to attach a policy to". One code cannot render as twelve sentences,
so this has to be ruled:

- **(a) Split it** into `PATIENT_NOT_FOUND`, `APPOINTMENT_NOT_FOUND`, and so on. Precise, and it
  makes the wire contract self-describing — but it is roughly a dozen new codes.
- **(b) Keep one code with a `resource` param** — `{ "reason": "NOT_FOUND", "params": { "resource":
  "appointment" } }` — and one Arabic template per resource. Fewer codes; the client needs a
  resource→noun map that has to stay in step with the server's vocabulary.

**Recommendation: (a).** The 404-not-403 rule already means these strings are the *only* thing
distinguishing one missing thing from another, and a code that means twelve things is a code the
client cannot switch on — which is the whole point of the change.

**Nine codes carry interpolated values today**, which is the evidence that `params` is required
rather than a nicety: `OUTSIDE_HORIZON`, `RANGE_TOO_LONG`, `TOO_LARGE`, `TYPE_MISMATCH`,
`ILLEGAL`, `ILLEGAL_TRANSITION`, `TERMINAL_STATUS`, `GRACE_PERIOD_NOT_ELAPSED`, `QUEUE_MOVED_ON`.
A code-only design would lose the numbers and the dates.

**Four codes are developer-facing only** and should be ruled as never rendered to a user:
`MISSING_CONTEXT`, `ILLEGAL_TRANSITION`, `TERMINAL_STATUS` and `REASON_REQUIRED`'s state-machine
variant are programming errors reaching a state machine — the correct user-facing outcome is a
generic "something went wrong" plus a log entry, not a translated explanation of an internal edge.

---

## Cost, if it is approved

| Piece | Size |
|---|---|
| `params` added to the refusal envelope, and the ~9 interpolating sites converted | ~half a day |
| Splitting `NOT_FOUND` (option a) across 24 sites | ~half a day |
| `refusalText()` plus 34–46 Arabic catalogue entries | ~half a day |
| A conformance test: every `reason` the API can return has a catalogue entry | ~2 hours |
| Client call sites switched from `message` to `refusalText` | ~2 hours |

**About two days.** The conformance test is the piece that makes it stay correct, and it is the same
shape as the route→capability manifest: enumerate the codes from the API source, assert the client
catalogue covers them, and fail the build when a new refusal ships untranslated.

---

## Open questions for the ruling

1. **`NOT_FOUND`: split, or one code with a `resource` param?** Recommendation above.
2. **Do developer-facing refusals get a user-facing string at all?** Recommendation: no — one
   generic Arabic sentence for all four, and the code in the console.
3. **English catalogue.** `strings.ts` deliberately keeps `en` sparse (D20: a half-translated
   interface reads as broken). Refusals would be the first place English *is* the source text, since
   the server already writes it. Suggest: populate `en` for refusals from the existing server
   strings, since they are already written and reviewed.
4. **Does this extend to validation errors?** `class-validator` produces its own English messages
   through `ValidationPipe`, in a different shape (`message` as an array). Out of scope as proposed,
   and the largest remaining source of English text if it stays that way.

---

## Appendix — every refusal code in the codebase, 2026-09-06

34 codes reach the client. Text shown as written; `${...}` marks an interpolated value that becomes
a `param`.

| Code | English text today | Module |
|---|---|---|
| `ALREADY_A_DOCTOR` | That membership already has a doctor record. | doctors |
| `ALREADY_DECIDED` | Someone answered this request already — the screen you acted on was out of date. | transfers |
| `ALREADY_OPEN` | This patient already has a transfer request waiting for an answer. | transfers |
| `CONTENDED` | Too many people are booking this slot at once. Ask for availability again. | appointments |
| `DUPLICATE_POLICY` | This patient is already recorded on that policy. | insurance |
| `EMPTY_FILE` | The uploaded file is empty. | attachments |
| `EXPIRED_TOKEN` | That slot list has expired. Ask for availability again. | appointments |
| `GRACE_PERIOD_NOT_ELAPSED` | Not markable as NO_SHOW until `${eligibleAt}` | appointments (domain) |
| `HEIC_NOT_CONVERTED` | This is a HEIC/HEIF image. The upload screen converts photographs before sending… | attachments |
| `ILLEGAL` | An appointment that is `${status}` cannot be moved. Legal from: … | appointments |
| `ILLEGAL_TRANSITION` | `${event}` is not legal from `${current}`. Legal from: `${…}`. | appointments (domain) |
| `INVALID_TOKEN` | That slot was not offered by this clinic. | appointments |
| `INVALID_WINDOW` | The end date is before the start date. / That would put the end date before the start date. | insurance |
| `MISSING_CONTEXT` | MARK_NO_SHOW needs now, scheduledStart and noShowGraceMinutes… | appointments (domain) |
| `NOT_A_DOCTOR` | Only a doctor may attach a file… / read a patient's attachments / read attachment content / archive an attachment. | attachments |
| `NOT_FOUND` | **12+ distinct sentences across 24 sites** — see the section above | 8 modules |
| `NOT_PERMITTED` | This patient is not in your care. / This patient is not currently in your care. | attachments |
| `NOT_PRESENT` | The full record is available once this patient is with you — checked in, waiting, or… | clinical |
| `OUTSIDE_HORIZON` | This clinic books up to `${days}` days ahead (to `${horizonEnd}`). | appointments |
| `OVERLAPPING_TEMPLATE` | *(the overlap description, computed)* | schedules |
| `QUEUE_MOVED_ON` | This appointment is `${status}`, not `${expected}`. Someone else moved it… | queue |
| `RANGE_TOO_LONG` | Ask for between 1 and `${MAX_RANGE_DAYS}` days. | appointments |
| `REASON_REQUIRED` | §9: cancelling requires a reason… / Say why, so reception knows whether to try another doctor… | appointments, transfers |
| `SAME_DOCTOR` | That is the doctor the patient is already with. | transfers |
| `SLOT_TAKEN` | That time was taken while you were booking. / …while you were rescheduling. | appointments |
| `TERMINAL_STATUS` | `${current}` is terminal; no event moves an appointment out of it… | appointments (domain) |
| `TOO_LARGE` | Attachments are limited to `${max}` bytes; this one is `${actual}`. | attachments |
| `TYPE_MISMATCH` | This file is named or sent as `${claimed}`, but its contents are… | attachments |
| `UNKNOWN_DOCTOR` | No such doctor. | appointments |
| `UNKNOWN_MEMBERSHIP` | No membership with that id in this clinic. | doctors |
| `UNKNOWN_PATIENT` | No patient with that id in this clinic. | appointments |
| `UNKNOWN_SERVICE` | No service with that id in this clinic. | appointments |
| `UNSUPPORTED_TYPE` | Only images (PNG, JPEG, WebP, GIF) and PDFs may be attached. | attachments |
| `VISIT_MISMATCH` | That visit belongs to a different patient. | attachments |

Three further codes — `EMPTY`, `HEIC`, `UNSUPPORTED` — exist in `attachments/domain/sniff.ts` and
never reach the wire; the service maps them to `EMPTY_FILE`, `HEIC_NOT_CONVERTED` and
`UNSUPPORTED_TYPE`. They are listed only so that a reader grepping for refusal reasons is not
surprised by them.

**Two codes have two different sentences under one code today** (`SLOT_TAKEN`, `INVALID_WINDOW`,
and `REASON_REQUIRED` across two modules). Whether that survives translation is a smaller version of
the `NOT_FOUND` question: one Arabic sentence each is probably right, and the distinction between
"while you were booking" and "while you were rescheduling" is one the screen already knows.
