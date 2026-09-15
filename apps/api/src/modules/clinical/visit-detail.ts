import { injected } from "../../prisma/injected.ts";
import { withTenant } from "../../prisma/with-tenant.ts";
import type { CallerContext } from "../appointments/appointments.service.ts";
import { attachmentsForVisit, type AttachmentView } from "../attachments/attachments.service.ts";
import {
  isPresentWithDoctor,
  recordSensitiveRead,
  resolveAccess,
  type ClinicalRefusal,
} from "./clinical.access.ts";
import type { VisitDetail } from "./clinical.types.ts";
import { visitScope } from "./visit-scope.ts";

void injected;

/**
 * One past visit, read through its appointment — `PHASE-4.md` Q18, **as revised 2026-09-05**.
 *
 * ## Why this is `GET /appointments/:id/visit` and not `GET /visits/:id`
 *
 * Q18 originally ruled a visit-scoped route, and it was built. The founder reversed it on
 * 2026-09-05, and the argument is the one that decides it:
 *
 * > *"Every clinical read in this project resolves ownership through the appointment, and a
 * > visit-scoped route means a second ownership path that has to stay in step with the first.
 * > We've already found this exact shape five times — a check that exists in one place and not in
 * > its sibling. One path, one rule."*
 *
 * The visit-scoped version was the proof of his point rather than a counterexample to it. It had
 * its own presence logic, and that logic was **wrong on the first attempt** — it asked whether the
 * *visit's own* appointment was present, which is a month-old `COMPLETED` row, so a colleague with
 * the patient in front of them was refused. A test caught it; nothing structural would have. There
 * is now no second path to keep in step: this function calls `resolveAccess`, the same function
 * `clinical-summary` and `clinical-history` call, and inherits every rule it enforces.
 *
 * **The transfer grant composes for free**, which is the other half of his argument: `resolveAccess`
 * already opens Level 2 on an accepted, unexpired grant (D24), so a receiving doctor sees the visit
 * without a line of code here mentioning transfers.
 *
 * ## There is no "but I wrote it" exception, and that is deliberate
 *
 * The first version let a doctor open a visit they authored **unconditionally**, on the reasoning
 * that presence is the wrong question about a record you wrote yourself. The founder rejected it on
 * 2026-09-05, and the objection is stronger than the reasoning it replaces:
 *
 * > *"Adding an authored-by-me exception would let a doctor keep access to a patient they no longer
 * > treat, forever, on the strength of having once written a note. That's exactly the
 * > permanent-access accumulation I rejected when we designed episode-scoped grants."*
 *
 * **This is the most natural objection anyone will raise, so it is answered here in full.** "But I
 * wrote it" feels like it should be sufficient, and it is not, because it is not a claim about the
 * present. Authorship is a fact about the past that never expires: a doctor who saw a patient once,
 * three years ago, would hold a permanent key to that patient's record — and would hold one such
 * key for every patient they had ever seen. That is precisely the accumulation episode-scoped
 * grants exist to prevent, and an exception granting it silently would undo D24 without amending
 * it.
 *
 * The rule is therefore **current ownership or an active grant**, and nothing else. A doctor who
 * needs to see something they wrote for a patient who has moved on asks the clinic, and that
 * request leaves a record — which is the point. An access path that leaves no record is the one
 * worth refusing even when the person using it has a good reason.
 *
 * ## Revisions are clinical content, not audit trivia
 *
 * The payload carries `visit_revisions` because a doctor reading a past visit needs to know whether
 * the diagnosis was corrected afterwards and why. A record that silently presents its current state
 * as its only state invites a reader to act on a correction they cannot see.
 *
 * **They will be empty until the visit write path exists.** Nothing writes `visit_revisions` today
 * — Q6's amendment flow is a later checkpoint — so this returns `[]` for every visit in the
 * database right now. That is correct and it is not evidence the field works; the Definition of
 * Done box for revisions stays unticked until something has written one and this has read it back.
 */

export interface VisitDetailResult {
  ok: true;
  value: VisitDetail;
}

export type GetVisitResult = VisitDetailResult | { ok: false; refusal: ClinicalRefusal };

const VISIT_COLUMNS = {
  id: true,
  patientId: true,
  doctorId: true,
  appointmentId: true,
  status: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  complaint: true,
  medicalHistory: true,
  examination: true,
  diagnosis: true,
  treatmentPlan: true,
  doctorNotes: true,
  followUpDate: true,
  vitals: true,
  followUpIntervalDays: true,
} as const;

export async function getAppointmentVisit(
  caller: CallerContext,
  actorRole: string,
  appointmentId: string,
  /** Passed in, never read here — the transfer window is compared against it (CLAUDE.md). */
  now: Date,
): Promise<GetVisitResult> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const resolved = await resolveAccess(tx, caller, appointmentId, now);
    if (!resolved.ok) return { ok: false as const, refusal: resolved.refusal };

    const access = resolved.access;

    /**
     * **"Current ownership" is a fact about the patient now, not about this appointment's row.**
     *
     * `resolveAccess` answers presence from the appointment in the URL, which is right for
     * `clinical-summary` and `clinical-history` because those are always called on the appointment
     * the doctor is looking at. Here the appointment in the URL is a *past* one — that is the whole
     * point of the route — and a past appointment is `COMPLETED` by definition. Taken literally,
     * `mayReadFullHistory` is therefore false for every past visit, including the caller's own,
     * **including while the patient is sitting in front of them.**
     *
     * That was not a hypothetical. Measured on the review stack: with the patient `IN_CONSULTATION`,
     * `clinical-history` returned three past visits' full content, and opening any one of them
     * through this route was refused 409. The feature would have shipped clickable and dead, and
     * `clinical-history` would have been handing out the same content beside it.
     *
     * So the second clause asks the founder's rule as he stated it — *"current ownership or an
     * active grant"* — of the patient rather than of the row: **this was my appointment, and this
     * patient is in my care right now.** It grants nothing to a doctor with no current
     * relationship, which is Q3's whole concern, and it uses the shared `isPresentWithDoctor`
     * helper so presence still has exactly one definition.
     *
     * It is deliberately **not** a change to `resolveAccess` itself: widening presence there would
     * widen `clinical-summary` and `clinical-history` too, letting either be called on a stale
     * appointment. The narrow clause lives here, where the stale appointment is expected.
     */
    const currentlyMine =
      !access.isAnotherDoctorsPatient &&
      access.callerDoctorId !== null &&
      (await isPresentWithDoctor(tx, access.patientId, access.callerDoctorId));

    if (!access.mayReadFullHistory && !currentlyMine) {
      return {
        ok: false as const,
        refusal: {
          // The same code as the clinical summary's. The two sentences said the same thing about
          // the same rule in different words; one Arabic sentence covers both.
          code: "NOT_PRESENT" as const,
          params: {},
        },
      };
    }

    /**
     * Ordered rather than arbitrary. One appointment may carry several visits once drafts exist
     * (Q2/Q15: several drafts, one `COMPLETED`), and an unordered `findFirst` would return a
     * different one on a different day for no visible reason.
     *
     * **This needs revisiting when the draft write path lands**, because "the visit for this
     * appointment" stops being a single answer at that point — a doctor's own unfinished draft and
     * a finished visit are different things and this route currently cannot say which it returned.
     * Flagged rather than guessed at.
     */
    const visit = await tx.visit.findFirst({
      where: { appointmentId, ...visitScope(caller) },
      select: VISIT_COLUMNS,
      orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
    });
    if (visit === null) {
      return {
        ok: false as const,
        // NO_VISIT_YET, not NOT_FOUND: the appointment exists and nothing is missing that the
        // caller could go and look for. It asks for a different action -- wait until the doctor
        // records one -- so by the ruling it earns its own code.
        refusal: { code: "NO_VISIT_YET" as const, params: {} },
      };
    }

    const attachments: AttachmentView[] = await attachmentsForVisit(tx, visit.id);

    const revisions = await tx.visitRevision.findMany({
      where: { visitId: visit.id },
      select: {
        id: true,
        changedFields: true,
        previousValues: true,
        actorUserId: true,
        reason: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    // Cross-doctor reads only, per the existing ruling: recording a doctor reading their own
    // patient would bury the reads that matter under the ones that do not.
    if (access.isAnotherDoctorsPatient) {
      await recordSensitiveRead(tx, caller, actorRole, access, "FULL_HISTORY");
    }

    return { ok: true as const, value: { ...visit, attachments, revisions } };
  });
}
