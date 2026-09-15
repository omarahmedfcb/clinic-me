import { MembershipRole } from "../generated/prisma/enums.ts";
import { CAPABILITIES, permissionLevel, type Capability } from "./permissions.ts";

/**
 * Where each `own`-level capability is actually enforced — or an explicit admission that it is not.
 *
 * ## Why this file exists
 *
 * `permissions.ts` says plainly that `PermissionGuard` cannot decide `own`: it proves the role has
 * *some* access, and telling `own` from `full` against a specific resource needs the resource in
 * hand. Enforcement therefore lives in a service, somewhere else, out of sight of the matrix.
 *
 * That gap is how this project has now been caught twice, and `PHASE-3.md` Q20 and Q22 name the
 * shape: **a label stood in for a check.** Someone reads `DOCTOR: OWN` in the matrix, concludes the
 * scoping is handled, and it is not — because the matrix is a declaration of intent and nothing
 * makes the code honour it.
 *
 * Two capabilities are declared `OWN` today and enforced by **nothing at all**, because the
 * endpoints that would consume them do not exist yet. That is not a bug — you cannot scope an
 * endpoint you have not written — but it is a trap set for whoever writes them, who will find
 * `OWN` already in the matrix and reasonably assume the work is done.
 *
 * So each one is listed here with a status, and the accompanying spec fails when a capability gains
 * an `own` level and is not classified. The point is that building the reports endpoint now
 * *requires* changing this file, which is the moment to notice the scoping is owed.
 *
 * Same idea as `prisma/tenant-scoped-models.ts`, which this project already trusts for the same
 * reason: a registry the type system forces you to complete beats a convention people remember.
 */
export type OwnEnforcement =
  /** A service narrows the query on this capability, and an integration test asserts the refusal. */
  | { status: "enforced"; where: string; provenBy: string }
  /**
   * No endpoint consumes this capability yet. **The `own` in the matrix is currently a promise
   * nobody keeps** — harmless only for as long as nothing calls it.
   */
  | { status: "no-endpoint-yet"; owed: string };

/**
 * Capabilities that **no route consumes**, with what is owed when one finally does.
 *
 * Widened on 2026-09-01 from `own`-only to *every* level, because the `own`-only version missed the
 * two that matter most. `visits.write` and `prescriptions.write` are `DOCTOR: FULL` and have no
 * endpoint — and `FULL` is the more dangerous label to inherit, because `own` at least reads as
 * "scoping owed" while `FULL` reads as "no scoping needed".
 *
 * The scenario, stated so the next author meets it: **a doctor authoring a visit and a prescription
 * on a colleague's patient.** The audit trail would name them correctly and the record would look
 * entirely legitimate — and unlike a bad read, which leaves a trace to investigate, it leaves a
 * diagnosis in a medical record that another doctor will later act on. There is no code path to it
 * today, because there is no endpoint. There will be one the day somebody writes `POST /visits`,
 * and `FULL` in the matrix will tell them nothing is owed.
 *
 * The check is deliberately **not** written yet. `PHASE-3.md` Q22 rules that you prove the hole is
 * reachable before building the wall, and a guard on an endpoint that does not exist cannot be
 * proven by breaking it — it would be the exact error that ruling names. What is written instead is
 * this entry, which fails the suite the moment the endpoint appears without one.
 *
 * ## It worked, on 2026-09-05 — `visits.write` is no longer here
 *
 * The attachments upload route consumed `visits.write` and this registry turned the suite red, with
 * exactly the scenario above still unhandled: the first draft checked that the caller was a doctor
 * and that the patient existed, and nothing else, so **any doctor in the clinic could file a
 * document onto any patient's record**. The check now lives in
 * `modules/attachments/attachments.service.ts` as `hasCareRelationship`, and
 * `test/integration/attachments.integration.spec.ts` proves the refusal against a doctor with no
 * relationship to the patient.
 *
 * Recorded because the mechanism is the point: nobody was looking for that hole, and nobody had to
 * be. `prescriptions.write` is still below, and will do the same thing to whoever writes its route.
 */
export const NO_CONSUMER: Record<string, string> = {
  "appointments.overrideSlotConflict":
    "No override path exists. DOCTOR holds `own` here precisely so a doctor cannot force a booking " +
    "into a colleague's diary; narrow the caller before it ships.",
  "patients.merge":
    "No merge endpoint -- ARCHITECTURE.md §18 makes merging a manual DB task for the pilot.",
  // "auditLog.read" left this registry on 2026-09-14, when Phase 5 PR 11 built `GET /audit-log`.
  // ARCHITECTURE.md §18 had cut the viewer from the pilot; the founder put it back on 2026-09-09.
  // "reports.financial" left it the same day, when Phase 5 PR 14 built `GET /reports/payments`.
  // Its entry asked that a DOCTOR's report be narrowed explicitly rather than by a WHERE clause
  // that happens to be right; `payments-report.ts` resolves the caller's own doctor row once and
  // applies it to every query and every total, and the refusal is tested.
  // "payments.record" left this registry on 2026-09-10: Phase 5 PR 7 gave it a consumer, the
  // payer split on a charge. "payments.adjust" left it on 2026-09-11, when R2 took the desk away
  // from an admin and `PUT /charges/:id/discount/authorised` became the route that lets an owner
  // or admin allow a discount above the ceiling without being able to take the money. The guard
  // noticed both entries had gone stale, which is the whole reason it exists.
  "prescriptions.readExistence":
    "No prescription endpoints yet; Phase 4. Reception may learn that a prescription exists but " +
    "never its items, so this and prescriptions.readItems must stay SEPARATE endpoints with " +
    "separate DTOs (CLAUDE.md), never one response filtered by role.",
  "followup.readDueDate":
    "No follow-up endpoints; Phase 8 per ARCHITECTURE.md §13.",
};

export const OWN_ENFORCEMENT: Record<string, OwnEnforcement> = {
  "doctorSchedules.manage": {
    status: "enforced",
    where: "modules/schedules/schedules.service.ts resolveWritableDoctor()",
    provenBy: "test/integration/schedules-own-scope.integration.spec.ts",
  },
  "doctorProfile.manage": {
    status: "enforced",
    where: "modules/clinic-identity/clinic-identity.service.ts resolveOwnDoctor()",
    provenBy: "test/integration/clinic-identity.integration.spec.ts",
  },
  "appointments.overrideSlotConflict": {
    status: "no-endpoint-yet",
    owed:
      "No route, service or DTO reads this capability. When an override path is built, the caller " +
      "must be narrowed to their own appointments before it ships -- ARCHITECTURE.md gives DOCTOR " +
      "`own` here precisely so a doctor cannot force a booking into a colleague's diary.",
  },
  "payments.read": {
    status: "enforced",
    where: "modules/billing/payments-overview.ts getPaymentsOverview(), desk.ts readCharge()",
    provenBy: "test/integration/payments-and-pricing.integration.spec.ts",
  },
  "payments.record": {
    status: "enforced",
    where: "modules/billing/desk.ts recordPayment()",
    provenBy: "test/integration/payments-and-pricing.integration.spec.ts",
  },
  "reports.financial": {
    status: "no-endpoint-yet",
    owed:
      "There is no reports endpoint -- ARCHITECTURE.md §18 cuts the reports screen from the pilot. " +
      "A doctor's financial report would today be scoped only by whatever WHERE clause its author " +
      "happened to write. It would be correct for a reason that is not ownership enforcement, and " +
      "so could stop being correct without anything failing. Scope it explicitly and test it.",
  },
};

/**
 * Every capability where at least one role holds `own`. **Derived from the matrix, never
 * hand-listed** — a second hand-maintained copy would drift from the first, which is the failure
 * this file exists to prevent rather than reproduce.
 *
 * Roles come from the Prisma enum rather than a literal, so adding a role cannot quietly narrow
 * what this sweeps.
 */
export function ownCapabilities(): Capability[] {
  const roles = Object.values(MembershipRole);
  return CAPABILITIES.filter((capability) =>
    roles.some((role) => permissionLevel(role, capability) === "own"),
  );
}
