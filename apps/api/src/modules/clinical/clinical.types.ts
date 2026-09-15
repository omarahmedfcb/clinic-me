import type { AllergySeverity, AppointmentStatus, VisitStatus } from "../../generated/prisma/client.ts";
import type { AttachmentView } from "../attachments/attachments.service.ts";
import type { QueueCoverage } from "../queue/queue.types.ts";

/**
 * The two clinical read shapes — `PHASE-4.md`.
 *
 * Separate types for separate endpoints, deliberately. `CLAUDE.md` forbids serving clinical content
 * by filtering one response, so there is no shape here that contains both a diagnosis and a phone
 * number and decides at runtime which half to send.
 */

export interface SummaryAllergy {
  id: string;
  substance: string;
  reaction: string | null;
  severity: AllergySeverity;
  recordedAt: Date;
}

/**
 * A medication read out of a prescription rather than stored.
 *
 * The provenance fields are not decoration: the interface must show which prescription this came
 * from and when, so a doctor can judge its age. Presenting derived medication as though someone
 * entered it is the failure this design exists to avoid.
 */
export interface DerivedMedication {
  medicationName: string;
  dose: string;
  frequency: string;
  sourcePrescriptionId: string;
  issuedAt: Date;
}

export interface ClinicalSummary {
  patientId: string;
  fullNameAr: string;
  fullNameEn: string | null;
  dateOfBirth: Date | null;
  gender: string | null;
  phoneE164: string;
  /** D26, derived on read. The header shows «ملف ناقص» and offers only the three the doctor may fix. */
  missingIntakeFields: string[];

  allergies: SummaryAllergy[];
  /**
   * When a clinician last confirmed the allergy list, or null if nobody ever has.
   *
   * Carried so the interface can tell "no known allergies" from "not yet recorded". An empty list
   * with no timestamp is not a negative finding, and must not be displayed as one.
   */
  allergiesReviewedAt: Date | null;

  /** Derived from the most recent prescription. Empty until prescriptions exist. */
  currentMedication: DerivedMedication[];

  activeTreatmentPlans: {
    id: string;
    title: string;
    totalSessions: number;
    completedSessions: number;
    startedAt: Date;
  }[];

  /**
   * Dates and doctor only — the content of a visit is Level 2.
   *
   * `appointmentId` is carried because the visit read is keyed by appointment (Q18 as revised
   * 2026-09-05, "one path, one rule"). Without it a screen holding this list has a visit id and no
   * way to address the route that opens it.
   */
  recentVisits: { id: string; appointmentId: string; doctorId: string; at: Date }[];

  /** The three-state insurance badge, decided by the same rule the queue row uses (Q21). */
  coverage: QueueCoverage;
  /** Completed visits, counted rather than taken from `recentVisits`, which is capped at ten. */
  visitCount: number;
  lastVisitAt: Date | null;

  /** Whether Level 2 would be served right now, so the interface can explain rather than guess. */
  mayReadFullHistory: boolean;
  appointmentStatus: AppointmentStatus;
}

export interface ClinicalHistory {
  visits: {
    id: string;
    /** The address of the route that opens this visit in full. See `recentVisits` above. */
    appointmentId: string;
    doctorId: string;
    completedAt: Date | null;
    createdAt: Date;
    complaint: string | null;
    medicalHistory: string | null;
    examination: string | null;
    diagnosis: string | null;
    treatmentPlan: string | null;
    doctorNotes: string | null;
    followUpDate: Date | null;
  }[];
  prescriptions: {
    id: string;
    issuedAt: Date;
    notes: string | null;
    items: {
      medicationName: string;
      dose: string;
      frequency: string;
      duration: string;
      instructions: string | null;
    }[];
  }[];
}


/**
 * One visit in full — `GET /appointments/:id/visit`, Q18 as revised 2026-09-05.
 *
 * A **third** clinical shape, and separate from `ClinicalHistory` on purpose even though the fields
 * overlap. History is a list of summaries for orientation; this is one record opened deliberately,
 * and it carries two things history does not: the attachments filed against it, and the revisions
 * that corrected it. Merging them would produce one type that is half-populated depending on which
 * endpoint filled it, which is the shape `CLAUDE.md` forbids for exactly this reason.
 */
export interface VisitRevisionView {
  id: string;
  /** Which fields the amendment touched. */
  changedFields: unknown;
  /** What they held before it. Clinical content, and doctor-only like everything else here. */
  previousValues: unknown;
  actorUserId: string;
  /** Required by the schema: an amendment without a stated reason cannot be written. */
  reason: string;
  createdAt: Date;
}

export interface VisitDetail {
  id: string;
  patientId: string;
  doctorId: string;
  appointmentId: string;
  status: VisitStatus;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;

  complaint: string | null;
  medicalHistory: string | null;
  examination: string | null;
  diagnosis: string | null;
  treatmentPlan: string | null;
  doctorNotes: string | null;
  followUpDate: Date | null;
  followUpIntervalDays: number | null;

  /** Metadata only. The bytes need their own separately-gated request. */
  attachments: AttachmentView[];
  /** Newest first. Empty until the amendment flow (Q6) exists — see `visit-detail.ts`. */
  revisions: VisitRevisionView[];
}
