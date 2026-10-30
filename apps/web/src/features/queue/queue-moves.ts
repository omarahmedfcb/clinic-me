import type { AppointmentStatus } from "../../domain/appointment-status.ts";
import { intlLocale } from "../../i18n/format.ts";
import type { Locale } from "../../i18n/locale.ts";
import type { TranslationKey } from "../../i18n/strings.ts";
import type { QueueMove } from "./queue-api.ts";

export const MOVE_LABEL: Record<QueueMove, TranslationKey> = {
  "check-in": "queue.action.checkIn",
  start: "queue.action.start",
  pause: "queue.action.pause",
  resume: "queue.action.resume",
  complete: "queue.action.complete",
  "no-show": "queue.action.noShow",
};

/**
 * The one obvious next action for a row, or none.
 *
 * **Takes the role, because one of these moves is not reception's.** `PHASE-3.md` Q13, revisited
 * 2026-09-03: `IN_CONSULTATION → COMPLETED` is `appointments.completeVisit`, which is `DOCTOR` only.
 * Completing a visit asserts the doctor finished and recorded their notes, and under `PHASE-4.md`
 * Q6 it finalises the record — after it, adding a forgotten sentence costs a `visit_revisions` row
 * with a reason. A receptionist tidying the board must not be able to do that to a doctor
 * mid-sentence.
 *
 * **This is not the access control.** `@RequirePermission("appointments.completeVisit")` on the
 * route is, and it refuses whatever this function returns. Hiding a button the server would reject
 * is a courtesy to the user, and Q20 is emphatic that a UI change which *looks* like a permission
 * fix is worse than none — so the server-side half landed in the same change, and a test asserts
 * the refusal rather than the absence of a button.
 *
 * Reception keeps check-in, start and no-show, so a row mid-consultation simply offers them nothing
 * — which is honest: the next move genuinely belongs to somebody else.
 */
export function nextMove(
  status: AppointmentStatus,
  canComplete: boolean,
  canQueueActions: boolean,
  canPauseResume: boolean,
): QueueMove | null {
  switch (status) {
    case "BOOKED":
    case "CONFIRMED":
      return canQueueActions ? "check-in" : null;
    case "ARRIVED":
    case "WAITING":
      // Q40: starting a consultation is the appointment's doctor's, not the desk's. Reception is
      // offered nothing here, which is honest — the next move belongs to somebody else, and the
      // API refuses them either way.
      return canPauseResume ? "start" : null;
    case "IN_CONSULTATION":
      return canComplete ? "complete" : null;
    // Q34: resuming is the doctor's own act, gated on `visits.write`, so reception is offered
    // nothing here — the API refuses them either way, and this stops the board offering it.
    case "PAUSED":
      return canPauseResume ? "resume" : null;
    default:
      return null;
  }
}

export function today(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export function clockOf(iso: string, locale: Locale): string {
  return new Date(iso).toLocaleTimeString(intlLocale(locale), {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
