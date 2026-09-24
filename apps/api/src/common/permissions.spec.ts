import type { MembershipRole } from "../generated/prisma/client.ts";
import { type Capability, hasAnyAccess, permissionLevel } from "./permissions.ts";

const ROLES: MembershipRole[] = ["OWNER", "ADMIN", "DOCTOR", "RECEPTIONIST"];

/**
 * Independently transcribed from ARCHITECTURE.md §8, not imported from permissions.ts's own
 * MATRIX -- if this test read the production matrix and checked it against itself, a typo in
 * MATRIX would be invisible to it. One row per capability, in table order: [Owner, Admin, Doctor,
 * Reception].
 */
const EXPECTED: Record<Capability, ["full" | "own" | "none", "full" | "own" | "none", "full" | "own" | "none", "full" | "own" | "none"]> = {
  "clinicSettings.manage": ["full", "full", "none", "none"],
  "users.manage": ["full", "full", "none", "none"],
  "doctorSchedules.manage": ["full", "full", "own", "none"],
  // New 2026-09-09 (Q36). "Admin and the doctor themselves" is a shape no existing capability had:
  // users.manage refuses a doctor at the guard, before own-scoping could ever run.
  "doctorProfile.manage": ["full", "full", "own", "none"],
  "services.manage": ["full", "full", "none", "none"],
  // Split 2026-09-06. `patients.write` guarded six reads; naming a capability "write" and having
  // it decide reads is how `appointments.write` came to gate /queue/today.
  "patients.read": ["full", "full", "full", "full"],
  "patients.write": ["none", "full", "full", "full"],
  "patients.browse": ["full", "full", "none", "full"],
  "patients.merge": ["full", "full", "none", "none"],
  // New 2026-09-06. Transfers were guarded by `appointments.write`, which also guards the queue
  // read and booking -- so "the owner loses the transfer capabilities" could not be expressed
  // without splitting it out. PHASE-3.md Q25 coming due.
  // Split 2026-09-06, the day after it was created: one read among three writes is the same
  // naming defect as `patients.write`, at smaller scale. Access unchanged, name corrected.
  "patients.transfer.read": ["none", "full", "full", "full"],
  "patients.transfer": ["none", "full", "full", "full"],
  // Split 2026-09-06: eleven reads and five writes across five modules under one name.
  "appointments.read": ["full", "full", "full", "full"],
  "appointments.write": ["none", "full", "full", "full"],
  // OWNER -> none 2026-09-06: forcing a booking past a conflict is a desk override.
  "appointments.overrideSlotConflict": ["none", "full", "own", "none"],
  // OWNER became `none` on 2026-09-06: an owner checking a patient in under the owner role records
  // "the owner did this", which in a multi-doctor clinic makes accountability ambiguous. An owner
  // who works the desk holds a second membership and switches to it.
  "appointments.queueActions": ["none", "full", "full", "full"],
  // Q13 revisited 2026-09-03: completing a visit is a clinical assertion, not a scheduling act.
  "appointments.completeVisit": ["none", "none", "full", "none"],
  "visits.readIndex": ["full", "full", "full", "full"],
  "visits.readContent": ["none", "none", "full", "none"],
  "prescriptions.readExistence": ["full", "full", "full", "full"],
  "prescriptions.readItems": ["none", "none", "full", "none"],
  "followup.readDueDate": ["full", "full", "full", "full"],
  "visits.write": ["none", "none", "full", "none"],
  "prescriptions.write": ["none", "none", "full", "none"],
  // OWNER -> none 2026-09-06. `payments.adjust` stays full: approving a refund is
  // administration, taking cash at the desk is not.
  //
  // R2, 2026-09-11: ADMIN -> none on `payments.record` and DOCTOR -> own, with the new
  // `payments.read` carrying the screen. An admin sees every figure and takes none of the money.
  "payments.read": ["full", "full", "own", "full"],
  "payments.record": ["none", "none", "own", "full"],
  "payments.adjust": ["full", "full", "none", "none"],
  "reports.financial": ["full", "full", "own", "none"],
  "auditLog.read": ["full", "full", "none", "none"],
  // The bot set, 2026-09-18: AI_AGENT alone holds these, so every human role is none. The AI_AGENT
  // column is asserted separately, in bot-capability-set.spec.ts, which replaced the holds-nothing
  // assertion this file used to sit beside.
  "bot.findPatientByPhone": ["none", "none", "none", "none"],
  "bot.createProvisionalPatient": ["none", "none", "none", "none"],
  "bot.listSlots": ["none", "none", "none", "none"],
  "bot.book": ["none", "none", "none", "none"],
  "bot.reschedule": ["none", "none", "none", "none"],
  "bot.cancel": ["none", "none", "none", "none"],
  "bot.readAppointmentStatus": ["none", "none", "none", "none"],
  "bot.recordConsent": ["none", "none", "none", "none"],
  // Added 2026-09-22 for the web-chat prototype; AI_AGENT column asserted in
  // bot-capability-set.spec.ts, same as the original eight.
  "bot.listDoctors": ["none", "none", "none", "none"],
  "bot.listServices": ["none", "none", "none", "none"],
};

describe("permission matrix (ARCHITECTURE.md §8)", () => {
  const cases = Object.entries(EXPECTED).flatMap(([capability, levelsByRole]) =>
    ROLES.map((role, i) => [capability as Capability, role, levelsByRole[i]] as const),
  );

  // One number, not two. This read "covers exactly the 20 capabilities x 4 roles = 80 cells" while
  // asserting 84: the count was updated when a capability was added and the sentence was not, so
  // the name described a shape the test had stopped checking. The count stays a literal rather than
  // being derived from CAPABILITIES, because EXPECTED is deliberately an independent transcription
  // of §8 -- deriving it from the code under test is exactly the independence this file trades
  // convenience for. TypeScript already refuses an EXPECTED that is missing a capability.
  test("covers every capability x role cell", () => {
    // 26 capabilities x 4 roles. 88 -> 92 when `patients.transfer` was added on 2026-09-06,
    // then -> 100 when patients and appointments were split into read and write the same day.
    // -> 108 on 2026-09-09 when doctorProfile.manage arrived (Q36): "admin and the doctor
    // themselves" is a shape no existing capability expressed.
    // -> 112 on 2026-09-11 when R2 split the payments screen (`payments.read`) from the act of
    // taking money (`payments.record`), so that an admin can hold one and not the other.
    // -> 144 on 2026-09-18 with the eight bot.* capabilities: AI_AGENT holds them and the four
    // human roles hold none of them, which is the part this file checks.
    // -> 152 on 2026-09-22 when bot.listDoctors and bot.listServices joined for the web-chat
    // prototype's clinic browsing.
    expect(cases).toHaveLength(152);
  });

  test.each(cases)("%s x %s -> %s", (capability, role, expectedLevel) => {
    expect(permissionLevel(role, capability)).toBe(expectedLevel);
  });

  test("hasAnyAccess is true for full/own and false for none", () => {
    expect(hasAnyAccess("DOCTOR", "visits.write")).toBe(true); // full
    expect(hasAnyAccess("DOCTOR", "doctorSchedules.manage")).toBe(true); // own
    expect(hasAnyAccess("RECEPTIONIST", "visits.write")).toBe(false); // none
  });
});
