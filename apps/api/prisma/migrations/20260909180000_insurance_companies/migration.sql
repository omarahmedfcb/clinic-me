-- Phase 5, PR 1 — the insurance company registry. `PHASE-5-PLAN.md` PR 1, from Phase 4's withdrawn 7c.
--
-- ## No money here, and the absence is the ruling
--
-- No default coverage percentage and no copay. `PHASE-5-DESIGN.md` §4.2 makes the payer split manual
-- *because* no coverage rate exists, and `insurance_policies` already says in its own comment that a
-- percentage "invites a service to multiply by it and store the result". Adding the columns here
-- would make the split look automatable while nothing computes it.
--
-- ## The free-text insurer name stays
--
-- `insurance_policies.insurer_name` is not migrated away and not dropped. Rows written before this
-- registry existed name their insurer in text, and that text is the only record of what the desk was
-- told. `company_id` is nullable beside it: a policy either points at a registry row or still
-- carries its original text, and both are readable.

CREATE TYPE "InsuranceCompanyType" AS ENUM ('INSURER', 'TPA', 'CORPORATE', 'GOVERNMENT');
CREATE TYPE "ClaimSubmissionMethod" AS ENUM ('PORTAL', 'EMAIL', 'PAPER', 'OTHER');

CREATE TABLE "insurance_companies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "InsuranceCompanyType" NOT NULL,
    "contract_number" TEXT,
    "contract_start" DATE,
    "contract_end" DATE,
    "contact_person" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "claim_submission_method" "ClaimSubmissionMethod",
    "payment_terms_days" INTEGER,
    "prior_approval_required" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "insurance_companies_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "insurance_companies"
    ADD CONSTRAINT "insurance_companies_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One company per name per clinic. Case-folded, because "MedNet" and "MEDNET" typed by two
-- receptionists are one company, and two rows would split a clinic's policies across both.
CREATE UNIQUE INDEX "insurance_companies_tenant_id_name_key"
    ON "insurance_companies" ("tenant_id", lower("name"));

CREATE INDEX "insurance_companies_tenant_id_is_active_idx"
    ON "insurance_companies" ("tenant_id", "is_active");

-- A contract that ends before it starts is a data-entry slip, not a contract.
ALTER TABLE "insurance_companies"
    ADD CONSTRAINT "insurance_companies_contract_dates_ordered"
    CHECK ("contract_start" IS NULL OR "contract_end" IS NULL OR "contract_end" >= "contract_start");

-- Payment terms are counted in days and cannot be negative. Zero is real — "on presentation".
ALTER TABLE "insurance_companies"
    ADD CONSTRAINT "insurance_companies_payment_terms_not_negative"
    CHECK ("payment_terms_days" IS NULL OR "payment_terms_days" >= 0);

ALTER TABLE insurance_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE insurance_companies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON insurance_companies
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE TRIGGER insurance_companies_audit
  AFTER INSERT OR UPDATE OR DELETE ON insurance_companies
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- The policy points at a company, or keeps naming one in text. Both, never neither.
ALTER TABLE "insurance_policies" ADD COLUMN "company_id" UUID;
ALTER TABLE "insurance_policies" ADD COLUMN "plan_name" TEXT;

ALTER TABLE "insurance_policies"
    ADD CONSTRAINT "insurance_policies_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "insurance_companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "insurance_policies_company_id_idx" ON "insurance_policies" ("company_id");

-- Which policy applies first when a patient holds several. Not on the policy: the same corporate
-- scheme is primary for the employee and secondary for the spouse covered by her own employer.
ALTER TABLE "patient_insurance" ADD COLUMN "is_primary" BOOLEAN NOT NULL DEFAULT false;

-- At most one primary policy per patient. A partial unique index rather than a CHECK, because the
-- rule is about a set of rows and not about one of them.
CREATE UNIQUE INDEX "patient_insurance_one_primary"
    ON "patient_insurance" ("tenant_id", "patient_id") WHERE "is_primary";
