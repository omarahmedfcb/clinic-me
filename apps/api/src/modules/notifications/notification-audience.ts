import type { NotificationKind } from "../../generated/prisma/client.ts";

/** Notifications addressed to reception only (desk-notifications.ts). */
export const RECEPTION_KINDS: readonly NotificationKind[] = ["CONSULTATION_STARTED", "CONSULTATION_ENDED"];

/** Notifications addressed to the patient's own doctor only (desk-notifications.ts). */
export const DOCTOR_KINDS: readonly NotificationKind[] = ["PATIENT_CHECKED_IN", "PATIENT_PAID"];
