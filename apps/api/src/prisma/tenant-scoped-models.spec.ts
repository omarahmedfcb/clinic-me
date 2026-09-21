import { Prisma } from "../generated/prisma/client.ts";
import { isTenantScoped, tenantPolicyOf } from "./tenant-scoped-models.ts";

/**
 * `satisfies Record<Prisma.ModelName, TenantPolicy>` in tenant-scoped-models.ts already makes an
 * unregistered model a compile error. This spec is the runtime companion: it proves the counts
 * and specific classifications are what SCHEMA-DECISIONS.md D4/D12 actually say, not just that
 * the map happens to be exhaustive.
 */
describe("tenant-scoped-models registry", () => {
  const allModelNames = Object.values(Prisma.ModelName);

  test("every model in the schema has exactly one classification", () => {
    // 36 since Phase 2 added Notification and NotificationRead. This number is the point of the
    // test: it fails when a model is added to schema.prisma and not classified here, which is the
    // moment the tenant-scoping extension would otherwise start silently defaulting.
    // 38 as of 2026-09-01: PatientTransfer joined (SCHEMA-DECISIONS.md D24).
    // 40 as of 2026-09-02: InsurancePolicy and PatientInsurance joined (PHASE-3.md Q18).
    // 41 as of 2026-09-08: PatientClinicalProfile joined (PR 7b).
    // 43 as of 2026-09-08: VisitProcedure joined (PR 4, PHASE-4.md Q25).
    // 48 as of 2026-09-09: InsuranceCompany (PR 1), then VisitCharge, VisitChargeLine and
    // ChargeableMaterial (PR 3). The balance is a view and therefore not a model here.
    // 49 as of 2026-09-13: PatientCredit (ruling 5). `patient_credit_balances` is a view, for the
    // same reason `visit_charge_balances` is, so it is not a model either.
    // 52 as of 2026-09-15: PlatformClinicFile, PlatformClinicContact and PlatformClinicContract
    // joined with the back office, under the new "platform" classification.
    // 53 as of 2026-09-16: OperatorRecoveryCode joined, classified "none".
    // 54 as of 2026-09-18: BotCredential joined, scoped — a credential belongs to one clinic.
    // 55 as of 2026-09-18: WebhookDelivery joined, scoped — one clinic's outbox.
    expect(allModelNames).toHaveLength(55);
    for (const name of allModelNames) {
      expect(["scoped", "nullable", "none", "platform"]).toContain(tenantPolicyOf(name));
    }
  });

  test("classifies the three non-tenant models as none", () => {
    expect(tenantPolicyOf("Tenant")).toBe("none");
    expect(tenantPolicyOf("User")).toBe("none");
    expect(tenantPolicyOf("RefreshToken")).toBe("none");
  });

  test("classifies AuditLog and MessageTemplate as nullable, not scoped", () => {
    expect(tenantPolicyOf("AuditLog")).toBe("nullable");
    expect(tenantPolicyOf("MessageTemplate")).toBe("nullable");
    expect(isTenantScoped("AuditLog")).toBe(false);
    expect(isTenantScoped("MessageTemplate")).toBe(false);
  });

  test("classifies the 12 RLS-protected tables as scoped", () => {
    const rlsModels: Prisma.ModelName[] = [
      "Patient",
      "Visit",
      "VisitRevision",
      "Prescription",
      "PrescriptionItem",
      "Payment",
      "PaymentAdjustment",
      "Consent",
      "TreatmentPlan",
      "TreatmentPlanSession",
      "PrescriptionAccessToken",
      "Attachment",
    ];
    for (const model of rlsModels) {
      expect(isTenantScoped(model)).toBe(true);
    }
  });

  test("has exactly 46 scoped, 2 nullable, 4 none and 3 platform models (46 + 2 + 4 + 3 = 55)", () => {
    const counts = { scoped: 0, nullable: 0, none: 0, platform: 0 };
    for (const name of allModelNames) {
      counts[tenantPolicyOf(name)] += 1;
    }
    // Notification and NotificationRead are both plainly scoped: every row belongs to exactly one
    // clinic, and neither has a nullable tenantId where null would mean something.
    // 33 as of 2026-09-01: patient_transfers joined (prisma/sql/19, SCHEMA-DECISIONS.md D24).
    // 35 as of 2026-09-02: insurance_policies and patient_insurance joined (prisma/sql/21,
    // PHASE-3.md Q18). Both are plainly scoped -- a policy belongs to exactly one clinic.
    // 36 as of 2026-09-08: patient_clinical_profiles joined (PR 7b). Its own table rather than
    // columns on `patients`, which reception reads on every screen it has.
    // 38 as of 2026-09-08: visit_procedures joined (prisma/sql/26, PHASE-4.md Q25).
    // 44 as of 2026-09-13: patient_credits joined (ruling 5). Plainly scoped — a credit belongs to
    // one patient in one clinic, and a balance that crossed clinics would be a different product.
    // 2026-09-15: the three back-office tables joined as "platform" — they carry a `tenantId`
    // naming the clinic they are ABOUT, on tables that belong to the vendor. Classifying them
    // "scoped" would have been the silent mistake: the extension would inject a filter on a tenant
    // the operator never binds, and every read would answer nothing while looking correct.
    // 2026-09-16: operator_recovery_codes joined as "none". An operator holds no membership in any
    // clinic, so there is no tenant for a policy to compare against — the same reasoning as `User`
    // and `RefreshToken`, and the reason that table carries no RLS either.
    // 2026-09-18: bot_credentials joined as "scoped". The bot authenticates before any tenant is
    // bound, which is why `resolve_bot_credential` exists — not a reason to loosen the model.
    // 2026-09-18: webhook_deliveries joined as "scoped". Its rows name one clinic's appointments.
    expect(counts).toEqual({ scoped: 46, nullable: 2, none: 4, platform: 3 });
  });
});
