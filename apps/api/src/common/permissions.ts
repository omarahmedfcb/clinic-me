import type { MembershipRole } from "../generated/prisma/client.ts";

/**
 * ARCHITECTURE.md §8, transcribed as data -- "Permission matrix from ARCHITECTURE.md §8 as data,
 * not scattered conditionals" (PHASE-1.md). "own" (Doctor: schedules, slot-conflict override,
 * financial reports) means the role's access is restricted to resources tied to their own
 * membership. PermissionGuard only proves the role has *some* access to the capability -- telling
 * "own" apart from "full" against a *specific* resource (this doctor's own schedule vs. another
 * doctor's) needs the actual resource in hand, which a route-level guard checking a JWT claim
 * never has. That enforcement belongs to the service/controller once the resource is loaded.
 *
 * `permissionsOverride` (Membership.permissionsOverride, Json?) is intentionally not resolved
 * here -- ARCHITECTURE.md calls it "a per-membership override for edge cases" without specifying
 * a shape, and none of the required guard tests exercise it. Flagged, not silently implemented on
 * a guess: PermissionGuard currently checks the role's base matrix entry only.
 *
 * ## AI_AGENT holds nothing, and that is the decision
 *
 * ARCHITECTURE.md §12 rule 2 says the AI agent runs "under a synthetic AI_AGENT actor with its own
 * permission set -- strictly narrower than a receptionist's", and says nothing further. The enum
 * value lands in Phase 2 because extending a Postgres enum is cheap now and awkward against a
 * table holding real memberships (PHASE-2.md §6); the permission set is a Phase 7 conversation.
 *
 * So every cell in the AI_AGENT column is NONE, and `permissions-ai-agent-holds-nothing.spec.ts`
 * asserts it. That is not a placeholder to be quietly filled in. Nothing authenticates as
 * AI_AGENT until the tool registry exists, and a capability granted to a role nobody holds is a
 * capability nobody reviews -- it would sit here looking considered, having been guessed. The
 * failing test is the point: the first person to grant AI_AGENT anything has to delete an
 * assertion that says why they should not, which is where the conversation belongs.
 *
 * **This paragraph used to say `patients.write` guards search, create and read together, and it has
 * been wrong since bbdabe1 (2026-09-06)** — the split it asked for happened then. Search and single
 * patient reads are `patients.read`; `patients.write` is desk work: create, edit, relations,
 * insurance. The stale note was read as current on 2026-09-18 and nearly bought a second split.
 *
 * What is still true is the reason it was written. A bot needs `find_patient_by_phone` and must not
 * get `patients.read`, which also grants name search and any patient by id. That is a capability of
 * its own, not a loosening of these — `patients-capability-boundary.spec.ts` pins the shape.
 */
export const CAPABILITIES = [
  "clinicSettings.manage",
  "users.manage",
  "doctorSchedules.manage",
  "doctorProfile.manage",
  "services.manage",
  "patients.read",
  "patients.write",
  "patients.browse",
  "patients.merge",
  "patients.transfer.read",
  "patients.transfer",
  "appointments.read",
  "appointments.write",
  "appointments.overrideSlotConflict",
  "appointments.queueActions",
  "appointments.completeVisit",
  "visits.readIndex",
  "visits.readContent",
  "prescriptions.readExistence",
  "prescriptions.readItems",
  "followup.readDueDate",
  "visits.write",
  "prescriptions.write",
  "payments.read",
  "payments.record",
  "payments.adjust",
  "reports.financial",
  "auditLog.read",
  // The bot set, ruled 2026-09-18 (docs/WHATSAPP-BOT-CONTRACT.md §3). Held by AI_AGENT alone.
  "bot.findPatientByPhone",
  "bot.createProvisionalPatient",
  "bot.listSlots",
  "bot.book",
  "bot.reschedule",
  "bot.cancel",
  "bot.readAppointmentStatus",
  "bot.recordConsent",
  // Added 2026-09-22 for the web-chat prototype (docs precede it; the contract itself only ever
  // needed find/create/slots/book/reschedule/cancel/status/consent, because a WhatsApp number
  // already implies one clinic). A patient with no clinic yet, browsing by chat, needs to see the
  // doctor and service lists a receptionist already can -- `appointments.read`/`services.manage`
  // grant far more than that, so these are narrow capabilities of their own rather than a reuse.
  "bot.listDoctors",
  "bot.listServices",
] as const;

export type Capability = (typeof CAPABILITIES)[number];
export type PermissionLevel = "full" | "own" | "none";

const FULL: PermissionLevel = "full";
const OWN: PermissionLevel = "own";
const NONE: PermissionLevel = "none";

const MATRIX: Record<Capability, Record<MembershipRole, PermissionLevel>> = {
  "clinicSettings.manage": { OWNER: FULL, ADMIN: FULL, DOCTOR: NONE, RECEPTIONIST: NONE, AI_AGENT: NONE },
  "users.manage": { OWNER: FULL, ADMIN: FULL, DOCTOR: NONE, RECEPTIONIST: NONE, AI_AGENT: NONE },
  "doctorSchedules.manage": { OWNER: FULL, ADMIN: FULL, DOCTOR: OWN, RECEPTIONIST: NONE, AI_AGENT: NONE },
  /**
   * The doctor's printed identity — Q28's print fields, and Q36's screen for them.
   *
   * **New 2026-09-09, and the shape is the ruling.** The founder asked for the doctor profile to be
   * editable by "admin and the doctor themselves", which no existing capability expresses:
   * `users.manage` is NONE for DOCTOR, so a doctor is refused at the guard before any own-scoping
   * could run, and `doctorSchedules.manage` has exactly the right shape under a name about
   * something else.
   *
   * `own` for DOCTOR is enforced the way `doctorSchedules.manage` already is: the scope is applied
   * to the lookup, so another doctor's row is "no such thing" rather than a refused authorisation.
   */
  "doctorProfile.manage": { OWNER: FULL, ADMIN: FULL, DOCTOR: OWN, RECEPTIONIST: NONE, AI_AGENT: NONE },
  "services.manage": { OWNER: FULL, ADMIN: FULL, DOCTOR: NONE, RECEPTIONIST: NONE, AI_AGENT: NONE },
  /**
   * Reading **one patient** — the profile, their appointment history, their balance, their
   * insurance, and search.
   *
   * Split out of `patients.write` on 2026-09-06, and the founder's reason is about naming rather
   * than about the owner: *"`patients.write` guarding six reads means every future permission
   * decision on those routes is decided by a capability whose name says the opposite of what it
   * does."* That is how `appointments.write` came to gate `/queue/today`, which is a board.
   *
   * **Distinct from `patients.browse`, which is the whole book.** Browse answers "show me the
   * clinic's patients" and is reception's screen; this answers "show me this patient" and every
   * staff role needs it — a doctor reaches patients through their own queue and holds no browse.
   */
  "patients.read": { OWNER: FULL, ADMIN: FULL, DOCTOR: FULL, RECEPTIONIST: FULL, AI_AGENT: NONE },
  /**
   * Creating and editing a patient, and recording their insurance. **Desk work**, so OWNER is NONE
   * from 2026-09-06 under "owner administers, does not run the desk".
   *
   * Before the split this also guarded six reads, which is why removing it from OWNER was refused
   * on 2026-09-06: it would have left an owner able to list patients through `patients.browse` and
   * unable to open any of them.
   */
  "patients.write": { OWNER: NONE, ADMIN: FULL, DOCTOR: FULL, RECEPTIONIST: FULL, AI_AGENT: NONE },
  // Browsing the whole patient book, rather than searching for one by name (`patients.write`).
  //
  // DOCTOR is NONE by the founder's ruling of 2026-09-03: "doctors reach patients through their own
  // queue and history". Worth being exact about what that does and does not achieve, because it
  // reads like a security boundary and is not one: `patients.write` is FULL for DOCTOR and already
  // grants search and read of any patient in the clinic, which Q23 ruled correct — a patient
  // belongs to the clinic, not to a doctor. What is protected from doctors is clinical *content*,
  // on separate endpoints under `visits.readContent`. So this level is a product decision about
  // whose screen the book belongs on, and it must not be mistaken later for the thing that keeps a
  // doctor away from another doctor's patients.
  "patients.browse": { OWNER: FULL, ADMIN: FULL, DOCTOR: NONE, RECEPTIONIST: FULL, AI_AGENT: NONE },
  "patients.merge": { OWNER: FULL, ADMIN: FULL, DOCTOR: NONE, RECEPTIONIST: NONE, AI_AGENT: NONE },
  /**
   * Requesting, accepting and rejecting a patient transfer.
   *
   * **New on 2026-09-06, and it had to be new.** The founder ruled that an owner loses "the
   * transfer capabilities" — and there were none. All four transfer routes were guarded by
   * `appointments.write`, which also guards the queue board read, the availability and schedule
   * reads, and booking, rescheduling, cancelling and confirming. Taking `appointments.write` from
   * OWNER to satisfy the ruling would have removed the owner's ability to *see* the queue, which
   * the same ruling requires them to keep.
   *
   * So this is `PHASE-3.md` Q25 coming due: that question recorded `appointments.write` as "one
   * capability doing two jobs" and left splitting it to the founder. A transfer is a clinical
   * hand-off between doctors, not a scheduling act, and it is now guarded as one.
   *
   * DOCTOR holds it because a transfer is initiated and accepted by doctors. RECEPTIONIST holds it
   * because reception raises them at the desk on a doctor's instruction, which is how PHASE-3's
   * transfer design already worked.
   */
  /**
   * Reading the transfer list. Split from `patients.transfer` on 2026-09-06, the day after that
   * capability was created bundling one read with three writes — the same defect that had just
   * been fixed on `patients.write` and `appointments.write`, reintroduced at smaller scale.
   *
   * Kept `NONE` for OWNER rather than opened up. The split is about the capability's *name* meaning
   * what it does, not about widening access: an owner has no more business reading who is being
   * handed to whom than deciding it, and nothing asked for that to change.
   */
  "patients.transfer.read": { OWNER: NONE, ADMIN: FULL, DOCTOR: FULL, RECEPTIONIST: FULL, AI_AGENT: NONE },
  /** Requesting, accepting and rejecting. Three writes, and now only writes. */
  "patients.transfer": { OWNER: NONE, ADMIN: FULL, DOCTOR: FULL, RECEPTIONIST: FULL, AI_AGENT: NONE },
  /**
   * Reading the scheduling surface: availability, the day and range schedules, the queue board, the
   * pending no-show list, the appointment detail panel, the doctor roster used to pick a doctor,
   * and the notification list.
   *
   * Split out of `appointments.write` on 2026-09-06. That capability guarded **eleven reads and
   * five writes across five modules** — it was the clearest case of the bundling the founder
   * objected to, and the reason "the queue is read-only for an owner" could not be expressed
   * without this split.
   *
   * **`POST /notifications/read` is deliberately here rather than on the write side.** Marking your
   * own notification as read is a personal act on your own inbox, not an operation on a patient or
   * a booking, and an owner who cannot dismiss their own notifications would be a worse answer than
   * a slightly ill-fitting capability name. Flagged rather than hidden: if notifications ever grow
   * a capability of their own, that route belongs to it.
   */
  "appointments.read": { OWNER: FULL, ADMIN: FULL, DOCTOR: FULL, RECEPTIONIST: FULL, AI_AGENT: NONE },
  /**
   * Booking, rescheduling, cancelling and confirming. **Desk work**, so OWNER is NONE from
   * 2026-09-06.
   *
   * `PHASE-3.md` Q25 recorded this capability as "one capability doing more than one job" and left
   * the split to the founder. It took three attempts to come due: Q13 took the queue moves out, the
   * 2026-09-06 owner ruling took transfers out, and this took the reads out. What remains is one
   * job.
   */
  "appointments.write": { OWNER: NONE, ADMIN: FULL, DOCTOR: FULL, RECEPTIONIST: FULL, AI_AGENT: NONE },
  /**
   * OWNER became NONE on 2026-09-06: forcing a booking past a slot conflict is a desk override, and
   * "the owner administers, does not run the desk" is the ruling. No route reads this capability
   * yet (`own-capability-enforcement.ts` records it as unconsumed), so nothing changes behaviour
   * today — which is the argument for doing it now rather than later, while it is free.
   */
  "appointments.overrideSlotConflict": { OWNER: NONE, ADMIN: FULL, DOCTOR: OWN, RECEPTIONIST: NONE, AI_AGENT: NONE },
  /**
   * Check-in, start and no-show. Wired to the queue's three reception moves on 2026-09-03; until
   * then this row existed and no route read it, which reads as a live rule and is not one (Q24).
   *
   * **OWNER became NONE on 2026-09-06, and the founder overruled himself to get there.** His first
   * position was to leave the capability and hide the buttons, on the grounds that in a
   * single-doctor Egyptian clinic the owner *is* the doctor and often the desk too. He then
   * withdrew it:
   *
   * > *"The audit trail. An owner checking a patient in under the owner role records 'the owner did
   * > this' — which in a multi-doctor clinic makes accountability ambiguous. Under a receptionist
   * > membership it records what actually happened. And the product serves clinics and medical
   * > centres, not just single-doctor practices. A rule that only works because one person wears
   * > every hat is not a rule."*
   *
   * The single-doctor case is not lost, it is modelled properly: that owner holds a **second
   * membership** as DOCTOR or RECEPTIONIST and switches to it, which `memberships` already supports
   * and the tenant switcher already does. The seed gives Nile Family's owner exactly that, so the
   * case stays testable rather than becoming a story nobody exercises.
   *
   * **The owner keeps `appointments.write`,** so the queue board stays readable. "Read-only for an
   * owner" is the ruling, and removing the read would have been a different and stricter one.
   */
  "appointments.queueActions": { OWNER: NONE, ADMIN: FULL, DOCTOR: FULL, RECEPTIONIST: FULL, AI_AGENT: NONE },
  /**
   * `IN_CONSULTATION -> COMPLETED`, and nothing else. **`PHASE-3.md` Q13, revisited 2026-09-03.**
   *
   * Q13 folded every queue move into `appointments.write` and said the moment to split would be "a
   * clinic that wants a receptionist who books but cannot check in". The reason it actually split is
   * a different one: **completing a visit is a clinical assertion**, not a scheduling act — it says
   * the doctor finished and recorded their notes. Under `PHASE-4.md` Q6 it is also what finalises
   * the record, so after it the doctor adding a forgotten sentence must file a `visit_revisions`
   * row with a reason. A receptionist tidying the board could do that to a doctor mid-sentence.
   *
   * `DOCTOR` only, including not `OWNER` or `ADMIN`: the assertion is about who saw the patient, and
   * an owner who is not the treating clinician is in the same position as reception.
   */
  "appointments.completeVisit": { OWNER: NONE, ADMIN: NONE, DOCTOR: FULL, RECEPTIONIST: NONE, AI_AGENT: NONE },
  "visits.readIndex": { OWNER: FULL, ADMIN: FULL, DOCTOR: FULL, RECEPTIONIST: FULL, AI_AGENT: NONE },
  "visits.readContent": { OWNER: NONE, ADMIN: NONE, DOCTOR: FULL, RECEPTIONIST: NONE, AI_AGENT: NONE },
  "prescriptions.readExistence": { OWNER: FULL, ADMIN: FULL, DOCTOR: FULL, RECEPTIONIST: FULL, AI_AGENT: NONE },
  "prescriptions.readItems": { OWNER: NONE, ADMIN: NONE, DOCTOR: FULL, RECEPTIONIST: NONE, AI_AGENT: NONE },
  "followup.readDueDate": { OWNER: FULL, ADMIN: FULL, DOCTOR: FULL, RECEPTIONIST: FULL, AI_AGENT: NONE },
  "visits.write": { OWNER: NONE, ADMIN: NONE, DOCTOR: FULL, RECEPTIONIST: NONE, AI_AGENT: NONE },
  "prescriptions.write": { OWNER: NONE, ADMIN: NONE, DOCTOR: FULL, RECEPTIONIST: NONE, AI_AGENT: NONE },
  /**
   * OWNER became NONE on 2026-09-06, by the same argument that moved the queue: an owner taking a
   * payment under the owner role records "the owner took this money", which in a multi-doctor
   * clinic makes accountability ambiguous — and money is where that matters most.
   *
   * `payments.adjust` deliberately stays FULL. Approving a refund or a discount **is**
   * administration: it is the decision an owner should be making, and it is a different act from
   * standing at the desk taking cash. The two rows now differ on purpose.
   *
   * **ADMIN became NONE on 2026-09-11 (R2), and DOCTOR became OWN.** An admin may see every figure
   * on the payments screen and take none of it — a separation of duties, not a convenience — so
   * `payments.read` carries the screen and `payments.record` carries the act. A doctor collects
   * only for their own patients, and only when the per-doctor `collects_payments` flag is set;
   * the flag is checked in the service, because a capability matrix describes roles and this is a
   * fact about one person.
   */
  "payments.read": { OWNER: FULL, ADMIN: FULL, DOCTOR: OWN, RECEPTIONIST: FULL, AI_AGENT: NONE },
  "payments.record": { OWNER: NONE, ADMIN: NONE, DOCTOR: OWN, RECEPTIONIST: FULL, AI_AGENT: NONE },
  "payments.adjust": { OWNER: FULL, ADMIN: FULL, DOCTOR: NONE, RECEPTIONIST: NONE, AI_AGENT: NONE },
  "reports.financial": { OWNER: FULL, ADMIN: FULL, DOCTOR: OWN, RECEPTIONIST: NONE, AI_AGENT: NONE },
  "auditLog.read": { OWNER: FULL, ADMIN: FULL, DOCTOR: NONE, RECEPTIONIST: NONE, AI_AGENT: NONE },

  /**
   * The bot set — `AI_AGENT` and nobody else, ruled 2026-09-18.
   *
   * **Not reused staff capabilities, and that is the decision.** `patients.read` would have covered
   * the lookup, and it also grants name search and any patient by id; the contract forbids both, so
   * the bot gets a capability that does one thing. Every row below is `NONE` for every human role
   * for the same reason in reverse: a receptionist reaching a bot endpoint would be a second path
   * to the same act with different refusals, and two paths drift.
   *
   * What the bot cannot hold is enforced by these rows being the only ones it has: no
   * `visits.readContent`, no `prescriptions.*`, no `payments.*`, no `patients.browse`.
   */
  "bot.findPatientByPhone": { OWNER: NONE, ADMIN: NONE, DOCTOR: NONE, RECEPTIONIST: NONE, AI_AGENT: FULL },
  "bot.createProvisionalPatient": { OWNER: NONE, ADMIN: NONE, DOCTOR: NONE, RECEPTIONIST: NONE, AI_AGENT: FULL },
  "bot.listSlots": { OWNER: NONE, ADMIN: NONE, DOCTOR: NONE, RECEPTIONIST: NONE, AI_AGENT: FULL },
  "bot.book": { OWNER: NONE, ADMIN: NONE, DOCTOR: NONE, RECEPTIONIST: NONE, AI_AGENT: FULL },
  "bot.reschedule": { OWNER: NONE, ADMIN: NONE, DOCTOR: NONE, RECEPTIONIST: NONE, AI_AGENT: FULL },
  "bot.cancel": { OWNER: NONE, ADMIN: NONE, DOCTOR: NONE, RECEPTIONIST: NONE, AI_AGENT: FULL },
  "bot.readAppointmentStatus": { OWNER: NONE, ADMIN: NONE, DOCTOR: NONE, RECEPTIONIST: NONE, AI_AGENT: FULL },
  "bot.recordConsent": { OWNER: NONE, ADMIN: NONE, DOCTOR: NONE, RECEPTIONIST: NONE, AI_AGENT: FULL },
  "bot.listDoctors": { OWNER: NONE, ADMIN: NONE, DOCTOR: NONE, RECEPTIONIST: NONE, AI_AGENT: FULL },
  "bot.listServices": { OWNER: NONE, ADMIN: NONE, DOCTOR: NONE, RECEPTIONIST: NONE, AI_AGENT: FULL },
};

export function permissionLevel(role: MembershipRole, capability: Capability): PermissionLevel {
  return MATRIX[capability][role];
}

export function hasAnyAccess(role: MembershipRole, capability: Capability): boolean {
  return permissionLevel(role, capability) !== NONE;
}

/**
 * Every capability with the level this role holds for it. **A display hint, and nothing else.**
 *
 * Returned by `GET /auth/me` so the UI can hide controls a user cannot use. It is computed
 * server-side per request from the same matrix `PermissionGuard` reads, so it cannot disagree with
 * enforcement at the moment it is produced -- but it is sent to the client, and anything sent to a
 * client is a claim the client can modify.
 *
 * **Never authorise from this.** Not on the server, obviously; but also not by reasoning "the UI
 * hides the button, so the endpoint is safe". Authorisation is `@RequirePermission()` on the route,
 * evaluated per request against the role in the validated token.
 *
 * **If this function ever gains a caller that branches on its result for anything but rendering,
 * that is a bug in the caller.** It has exactly one legitimate consumer -- `GET /auth/me` -- and
 * `permission-summary-is-display-only.spec.ts` asserts that, by scanning the source for any other
 * import. A guard, a service, or a controller reading it is the shape of a permission check that
 * looks present and enforces nothing.
 *
 * A map rather than a flat list because the middle level is real: `{ schedules: "own" }` says what
 * `["schedules"]` cannot, and says it without encoding a scope into a string.
 */
export function permissionSummary(role: MembershipRole): Record<Capability, PermissionLevel> {
  const summary = {} as Record<Capability, PermissionLevel>;
  for (const capability of CAPABILITIES) summary[capability] = permissionLevel(role, capability);
  return summary;
}
