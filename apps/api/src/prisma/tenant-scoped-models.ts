import { Prisma } from "../generated/prisma/client.ts";

/**
 * How the tenant-scoping extension treats a model's `tenantId` column:
 *
 * - "scoped"   required tenantId column -- auto-inject `where.tenantId` / `data.tenantId`.
 * - "nullable" tenantId column exists but null is a meaningful, deliberate value (a
 *              platform-wide MessageTemplate, an AuditLog row surviving tenant deletion via
 *              ON DELETE SET NULL). Auto-injecting a filter here would silently hide those rows;
 *              auto-injecting a value on write would silently take away the null option.
 *              Application code must set tenantId explicitly for these two models.
 * - "none"     no tenantId column at all (Tenant is the tenant; User and RefreshToken are
 *              scoped indirectly through Membership).
 * - "platform" a required tenantId column naming the clinic a row is ABOUT, on a table that
 *              belongs to the vendor rather than to that clinic. Never auto-injected: the operator
 *              reads across every clinic from a session that binds no tenant, so a filter on the
 *              bound tenant would return nothing and a value on write would be unavailable. What
 *              keeps a clinic out of these tables is not the extension but RLS — the policy is
 *              `is_active_platform_admin()`, which is false for every clinic user, so the whole
 *              table is empty to them. Added 2026-09-15 with the back office.
 */
export type TenantPolicy = "scoped" | "nullable" | "none" | "platform";

/**
 * One entry per model in schema.prisma, and only per model in schema.prisma. `satisfies
 * Record<Prisma.ModelName, TenantPolicy>` makes this exhaustive at compile time -- adding a
 * model to the schema without adding it here is a type error, not a gap discovered in
 * production. This is the "model registry" ARCHITECTURE.md §6 Layer 2 calls for.
 */
const TENANT_POLICY = {
  Tenant: "none",
  User: "none",
  RefreshToken: "none",

  AuditLog: "nullable",
  MessageTemplate: "nullable",

  Membership: "scoped",
  Doctor: "scoped",
  Service: "scoped",
  ScheduleTemplate: "scoped",
  ScheduleBreak: "scoped",
  ScheduleException: "scoped",
  Contact: "scoped",
  Patient: "scoped",
  Appointment: "scoped",
  AppointmentEvent: "scoped",
  Visit: "scoped",
  VisitRevision: "scoped",
  Prescription: "scoped",
  PrescriptionItem: "scoped",
  Payment: "scoped",
  PaymentAdjustment: "scoped",
  Consent: "scoped",
  BotCredential: "scoped",
  WebhookDelivery: "scoped",
  AccessGrant: "scoped",
  TreatmentPlan: "scoped",
  TreatmentPlanSession: "scoped",
  PrescriptionAccessToken: "scoped",
  Subscription: "scoped",
  UsageRecord: "scoped",
  UsageAlert: "scoped",
  Invoice: "scoped",
  Conversation: "scoped",
  Message: "scoped",
  FollowupTask: "scoped",
  Attachment: "scoped",
  Notification: "scoped",
  NotificationRead: "scoped",
  // Tenant-scoped like every other clinical table: an allergy belongs to one clinic's patient.
  PatientAllergy: "scoped",
  PatientClinicalProfileEntry: "scoped",
  PatientRelation: "scoped",
  // The clinic's own list of insurers -- one clinic's contracts are not another's.
  InsuranceCompany: "scoped",
  InsurancePolicy: "scoped",
  PatientInsurance: "scoped",
  PatientTransfer: "scoped",
  // A procedure line belongs to one clinic's visit, like every other clinical table.
  VisitProcedure: "scoped",
  VisitInvestigation: "scoped",
  // Phase 5: what a visit costs, what it is made of, and the materials a clinic prices. Each
  // belongs to exactly one clinic, like every other row that has money on it.
  VisitCharge: "scoped",
  VisitChargeLine: "scoped",
  ChargeableMaterial: "scoped",
  PatientCredit: "scoped",
  // The vendor's file on a clinic, not the clinic's own data. See "platform" above.
  PlatformClinicFile: "platform",
  PlatformClinicContact: "platform",
  PlatformClinicContract: "platform",
  // An operator's recovery codes. "none", like `User` and `RefreshToken`: an operator holds no
  // membership anywhere, so there is no tenant for a policy to compare against.
  OperatorRecoveryCode: "none",
} satisfies Record<Prisma.ModelName, TenantPolicy>;

export function tenantPolicyOf(model: Prisma.ModelName): TenantPolicy {
  return TENANT_POLICY[model];
}

export function isTenantScoped(model: Prisma.ModelName): boolean {
  return TENANT_POLICY[model] === "scoped";
}
