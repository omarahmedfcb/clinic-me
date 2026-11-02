import type { CurrentUser } from "../auth/session.tsx";

export function queueCapabilities(me: CurrentUser) {
  /**
   * **Whether this screen may ASK for the transfer list — not whether it may show it.**
   *
   * Read before `refresh` rather than beside the other capability checks below, because it decides
   * a fetch rather than a render, and the two fail differently. The others hide a control; a
   * missing check here took the whole board down.
   *
   * What happened: `patients.transfer` left OWNER on 2026-09-06 and `GET /transfers` moved to
   * `patients.transfer.read`, while this `Promise.all` kept asking for it unconditionally. One 403
   * rejects the whole `Promise.all`, so an owner opening the queue saw "تعذّر تحميل الطابور" and no
   * board at all — even though `/queue/today` and `/no-shows/pending` had both answered 200.
   * Measured in the browser against a throwaway database, not inferred: requests 6 and 7 returned
   * 200 and request 8, `GET /transfers?openOnly=false`, returned 403.
   *
   * A screen must not request what the matrix says the caller cannot read. It is the same rule as
   * "never offer an action the API will refuse", applied to the read side — and the read side is
   * the one that fails loudly instead of merely looking wrong.
   */
  const canReadTransfers = me.permissions["patients.transfer.read"] !== "none";

  /**
   * Read from the permission summary rather than from `role === "DOCTOR"`.
   *
   * A role check here would be a second copy of the §8 matrix kept by hand in the frontend, which
   * `navigation.ts` already refuses to do for the sidebar and for the same reason: it drifts the
   * first time the matrix changes and nothing notices. Naming the capability means this follows the
   * matrix wherever it goes — including if a clinic later grants it to an owner who also practises.
   *
   * A display hint, never the control. The route's `@RequirePermission` is what refuses.
   */
  const canCompleteVisit = me.permissions["appointments.completeVisit"] !== "none";

  /**
   * **The owner's queue is read-only from 2026-09-06.**
   *
   * `appointments.queueActions` became NONE for OWNER by ruling: an owner checking a patient in
   * under the owner role records "the owner did this", which in a multi-doctor clinic makes
   * accountability ambiguous. An owner who works the desk is meant to hold a second membership as
   * RECEPTIONIST and switch to it.
   *
   * The board itself stays visible — that is `appointments.write`, which the owner keeps, and
   * "read-only" is the ruling rather than "hidden". A display hint, never the control: the routes'
   * `@RequirePermission` is what refuses, and the integration suite asserts the refusal rather than
   * the absence of a button.
   */
  const canQueueActions = me.permissions["appointments.queueActions"] !== "none";
  // Q34: pausing and resuming are the doctor's, gated on `visits.write`. Reception is offered
  // nothing on a paused row, which is honest — the next move genuinely belongs to somebody else.
  const canPauseResume = me.permissions["visits.write"] !== "none";

  /**
   * **Transfers left the owner on 2026-09-06, and this screen had to follow.**
   *
   * `patients.transfer` is NONE for OWNER: a transfer is a clinical hand-off between doctors, not a
   * scheduling act. The owner still reaches this board — the queue is read-only for them rather
   * than hidden — so without this check they would see a "transfer" button on every row and an
   * accept/reject list, all of which now answer 403.
   *
   * That mismatch was **created by the matrix change and found by looking for it**, not reported: it
   * is exactly the shape `PHASE-3.md` Q20 warns about, where the screen and the API agree until one
   * of them moves. A display hint, never the control — the routes refuse regardless, and the
   * integration suite asserts the refusal rather than the absence of a button.
   */
  const canTransfer = me.permissions["patients.transfer"] !== "none";

  /** Who may write a visit, and therefore who the record screen is for. DOCTOR only. */
  const canWriteVisits = me.permissions["visits.write"] !== "none";

  /**
   * Booking is a desk act, and `appointments.write` stopped being the owner's on 2026-09-06 when it
   * was split from `appointments.read`. The board itself is `appointments.read`, which the owner
   * keeps — so without this the owner would reach the queue and be offered a "new appointment"
   * button that answers 403.
   */
  const canBook = me.permissions["appointments.write"] !== "none";

  return {
    canReadTransfers,
    canCompleteVisit,
    canQueueActions,
    canPauseResume,
    canTransfer,
    canWriteVisits,
    canBook,
  };
}
