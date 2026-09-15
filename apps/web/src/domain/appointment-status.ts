/**
 * The appointment state machine's states, mirroring the `AppointmentStatus` enum in
 * `apps/api/prisma/schema.prisma` exactly -- all nine, same order. PAUSED joined with Q34.
 *
 * This is domain vocabulary, not interface text, which is why it no longer lives under `i18n/`.
 * Its Arabic labels are ordinary catalogue entries keyed `appointment.status.*`, and
 * `strings.spec` asserts every state has one -- so a new state added to the enum surfaces as a
 * missing key rather than as an English identifier appearing on the queue board.
 */
export const ALL_APPOINTMENT_STATUSES = [
  "BOOKED",
  "CONFIRMED",
  "ARRIVED",
  "WAITING",
  "IN_CONSULTATION",
  "PAUSED",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
] as const;

export type AppointmentStatus = (typeof ALL_APPOINTMENT_STATUSES)[number];

/**
 * Which actions a screen may offer at a given status.
 *
 * These mirror `legalSourcesFor("CANCEL")` and `canReschedule()` in
 * `apps/api/src/modules/appointments/domain/transition.ts`, and
 * `appointment-actions-conformance.spec.ts` fails if the two ever disagree. Mirrored rather than
 * imported because `apps/web` and `apps/api` are separate packages; checked rather than trusted
 * because two files that must agree and nothing comparing them is the exact gap this project found
 * in its colour maps a day earlier.
 *
 * **The screen asks; it does not decide.** The founder's instruction, 1 September 2026, after the
 * detail panel offered cancel on a COMPLETED appointment: *"drive it from the state machine, not
 * from a hardcoded list."* Hiding a button is not the fix and never was — the API refuses these
 * transitions, and this exists so the screen stops offering an action the server will reject.
 */
export const CANCELLABLE_FROM: ReadonlyArray<AppointmentStatus> = [
  "BOOKED",
  "CONFIRMED",
  "ARRIVED",
  "WAITING",
];

/**
 * Deliberately the same set as cancel. Both ask "has this visit already happened or already
 * begun?" — COMPLETED rewrites a medical record after the fact, IN_CONSULTATION is not a real
 * action while the patient is with the doctor.
 */
export const RESCHEDULABLE_FROM: ReadonlyArray<AppointmentStatus> = CANCELLABLE_FROM;

export const canCancel = (status: AppointmentStatus): boolean => CANCELLABLE_FROM.includes(status);
export const canReschedule = (status: AppointmentStatus): boolean =>
  RESCHEDULABLE_FROM.includes(status);
