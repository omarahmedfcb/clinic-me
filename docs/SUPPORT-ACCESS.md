# Support access to a clinic account (branches step 6b)

> **BUILT, NOT ENABLED.** No clinic gets support access until its service agreement carries the
> data-processor clause. A per-clinic flag, `tenants.support_access_enabled`, is off by default, and
> the database refuses to turn it on unless that clinic has a current contract recorded with the
> clause. Until then *"our staff cannot read your records"* stays true without qualification.
>
> **Reviewed before enabled (ruled 2026-11-01).** This phase builds the largest new security surface
> since September: a token type, a per-request check, dual identity on every row, expiry in three
> layers. Before it is enabled for any clinic, a **separate Claude Code session that did not write it**
> reviews it, with `docs/SECURITY-REVIEW.md` as the checklist and the three risks in §8 as the focus.
> #216 is the reason: a guard its author walked through unnoticed.

Rulings: `PILOT-READINESS.md` (amended 2026-10-30), `BRANCHES-DESIGN.md` §9 C, and those below.

## Rulings (2026-11-01)
1. **Clinical scope is approved only by a DOCTOR, and only for that doctor's own patients.** The admin
   approves the operational session; a doctor adds clinical scope separately if needed. An owner is
   never assumed to practise. A session may carry two approvals, each recorded. (Corrects ruling C,
   which let an admin name the clinical file: an admin cannot read clinical content.)
2. **Read-only by default.** Writes need a second, recorded "allow changes" by the approving admin.
   **Clinical writes are never possible in a support session**, whatever is approved: support
   diagnoses the system, it does not treat.
3. **Any staff member who sees the banner may end a session.** A wrong close costs a minute; a staff
   member who sees something wrong and cannot stop it costs more.
4. **`AccessGrant` is dropped**, in the sessions migration, after a check that it is empty.
5. **300 requests per session.** Crossing it ends the session and records why.
6. **PR 5 is split** (ruled 2026-11-01): 5a is the read-only default and "allow changes"; 5b, clinical scope, waits for a
   written design of how a doctor's approval maps onto a token that carries the admin's membership. Until 5b, a support
   session reads nothing clinical.
7. **Read-only is held twice** (ruled 2026-11-01): the database refuses every audited write under a session not yet allowed
   changes, and the request check refuses every method but GET, HEAD and OPTIONS. The hour's own housekeeping runs as the
   system, outside the session. A write to an unaudited table is refused by the request check alone.
8. **"Allow changes" is recorded once and lasts the session** (ruled 2026-11-01). Anyone who sees the banner can still end
   it; a renewal starts read-only.

## The plan
- **The switch:** the flag, the contract's `data_processor_clause`, the trigger that refuses the flag
  without a current such contract. Turning it off is always allowed and ends every open session.
- **Sessions** (`support_sessions`): requested by the operator or opened by an admin, approved by an
  ACTIVE admin of that clinic, exactly one hour from approval, renewed only by a fresh approval as a
  new linked row. Clinical scope is a second approval by a doctor, for their own patients.
- **The support token:** the operator's own id, the clinic, the session; at most 10 minutes and never
  past the session's end. Every request re-reads the session.
- **Both identities on every row:** the session id bound in each transaction and stamped by the audit
  trigger; every request recorded, reads included.
- **Scope:** the approving admin's capabilities and branches, read-only unless changes are allowed;
  clinical reads only under a doctor's approval and for that doctor's patients; clinical writes never.
- **The clinic sees and ends it:** settings list it, a banner shows on every screen while it is live,
  and anyone who sees the banner can end it.

## The contract's clause is an attestation (ruled 2026-11-01)
`data_processor_clause` is a legal attestation, not a form field. On the step 9 console screen the
checkbox carries the sentence **"ticking this confirms the uploaded agreement names support as a
consented data processor"**, and the contract list shows the uploader's identity (`uploaded_by`)
beside it.

## Build order
Each one PR, proven by breaking: (1) the switch; (2) sessions, `AccessGrant` dropped; (3) the support
token and per-request check with the three expiry layers; (4) both identities on every row and
per-request recording, with the cap; (5) scope, as 5a read-only and "allow changes", then 5b clinical
(ruling 6). (6) Screens wait for steps 8 and 9 and the founder's
preview.

## As built
- **PR 1** (`20261101082000_support_access_switch`): the flag and the contract's clause; a trigger
  refuses "on" without a current such contract and fails closed for any session that cannot see them.
- **PR 2** (`20261101091000_support_sessions`): `support_sessions`, and `access_grants` dropped after
  its empty check (the down recreates it, so down then up round-trips). The database holds the
  conditions: one hour to the microsecond from approval, an ACTIVE platform admin as operator, an
  ACTIVE OWNER or ADMIN as approver, the switch on. Turning the switch off ends every live session and
  closes every request, through a definer-owned trigger, since the operator's session sees no rows.
  An ACTIVE session past its hour is marked EXPIRED by the next call that touches the clinic's sessions.
  The operator requests (`POST /platform/support-sessions/clinics/:tenantId`, which notifies the
  clinic's admins through 6.4) and withdraws; admins open, approve, deny and renew; anyone holding
  `appointments.read` (every role but the bot) sees the live session and may end it.

- **PR 3** (`20261101094000_support_token`): a support token is the operator's id, the approver's
  membership and role, and the session, under its own audience; the ordinary verifier refuses a
  session id without that audience. It lives at most 10 minutes, never past the session's end, and is
  issued only for the operator's own ACTIVE session (`POST …/:sessionId/token`, in the clinic's trail).
  **Three layers:** (1) every request calls `resolve_live_support_session()`: ACTIVE, 30 s left, switch
  on, operator ACTIVE, approver still ACTIVE OWNER or ADMIN with the token's role; (2) every transaction
  re-checks with the same 30 s margin and sets `statement_timeout` to the time left; (3)
  `audit_row_change()`, which runs on every write, refuses any write under a session that is not live
  by the clock. Both margins are at least the client's 30 s transaction cap, so no transaction can
  outlive the hour; `support-margins.spec.ts` holds that relation. Reads already returned before the
  end are not recalled; PR 4 records each request so it is known what left.
  **The support token can WRITE wherever the approver's capabilities allow, because the read-only
  default and the second "allow changes" approval are PR 5's. Until PR 5 lands, PR 3 is not complete
  as a security boundary; the switch being off everywhere is what holds.**

- **PR 4** (`20261101120000_support_request_trail`): every `audit_logs` row written under a support
  session says `SUPPORT`, the session and the approving admin (`support_session_id`,
  `support_approver_id`), stamped by one `BEFORE INSERT` trigger on `audit_logs` itself, so every
  writer is covered, application rows included; CHECKs refuse half a stamp, or `SUPPORT` without a session.
  Every request, reads included, is a row in the append-only `support_session_requests`, written by
  `record_support_request()` under a lock on the session, numbered 1 to 300 (a CHECK holds the cap). The
  301st ends the session as the system, `request cap reached: 300 requests`, and is refused. Its down
  refuses once anything has been recorded under a session: reversing would erase both identities.
  **What a support session read is evidenced by `support_session_requests` (method, path, order, time),
  not by audit rows.** Audit rows cover what the session changed. A read writes no audit row: a patient
  record read under a support token answers 200 and leaves only its request row (probed 2026-11-01).

- **PR 5a** (`20261101155000_support_read_only`): `support_sessions.changes_allowed_at/_by`. CHECKs hold that
  only the approver sets it; a trigger holds that it is set once, only while ACTIVE, and never at creation. The
  `audit_logs` stamp refuses CREATE, UPDATE and DELETE under a session without it (`support_session_read_only`);
  the request check refuses non-reading methods with `SUPPORT_READ_ONLY` (403), after recording the request.
  `POST /support-sessions/:id/allow-changes` is the approver's alone (`NOT_THE_APPROVER` otherwise, the support
  token included); a repeat changes nothing. `settle()` now calls `expire_support_sessions()`, which clears
  the support binding and acts as the system for its one update, then restores both. Not function `SET` clauses: a
  non-superuser owner may not set a custom parameter that way (the RLS ownership drill refused it). **Until 5b, a support session reads nothing clinical.**
  Known, not fixed here: a support token ending its own session, once changes are allowed, is refused by PR 3's
  layer 3 (the audit trigger sees its own session ended) and answers 500; the clinic and the console can end it.

## §8 Risks the review focuses on
1. **A session outliving its hour mid-request:** the guard needs 30 s left; the transaction's timeout
   is the time left; a database check refuses any write under an expired or ended session.
2. **A compromised operator account without a session:** the console only, as today, and the ability
   to request a session, which notifies the clinic's admins and cannot approve itself.
3. **A compromised operator account with a session:** what the approving admin sees, read-only unless
   allowed, for what is left of the hour, capped at 300 requests; clinical only under a doctor's
   approval, never a clinical write; the clinic's banner and end button stay with the clinic. What it
   read is known from `support_session_requests` (method, path, order, time), not from audit rows;
   audit rows cover only what it changed.
