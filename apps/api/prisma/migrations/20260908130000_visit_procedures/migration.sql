-- Phase 4, PR 4 — the procedures recorded on a visit. `PHASE-4.md` Q25.
--
-- `PHASE-4.md` §5 said "no new table. If one appears, a ruling went the other way." Q25 is that
-- ruling: the invoice PHASE-5-DESIGN.md builds at COMPLETE is built from recorded procedures, and
-- there is nowhere to record one. `unit_price_minor` is NULLABLE for the same reason
-- `appointments.quoted_price_minor` is — NULL means "no price was recorded", never zero.

CREATE TYPE "ProcedureSource" AS ENUM ('RECEPTION', 'DOCTOR');

CREATE TABLE "visit_procedures" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "visit_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price_minor" INTEGER,
    "source" "ProcedureSource" NOT NULL,
    "recorded_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "visit_procedures_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "visit_procedures"
    ADD CONSTRAINT "visit_procedures_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "visit_procedures"
    ADD CONSTRAINT "visit_procedures_visit_id_fkey"
    FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "visit_procedures"
    ADD CONSTRAINT "visit_procedures_service_id_fkey"
    FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "visit_procedures"
    ADD CONSTRAINT "visit_procedures_recorded_by_user_id_fkey"
    FOREIGN KEY ("recorded_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A quantity of zero or less is not a line anyone meant to record, and a negative price is a
-- refund, which is Phase 5's adjustment row and not this table's business.
ALTER TABLE "visit_procedures"
    ADD CONSTRAINT "visit_procedures_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "visit_procedures"
    ADD CONSTRAINT "visit_procedures_price_not_negative"
    CHECK ("unit_price_minor" IS NULL OR "unit_price_minor" >= 0);

-- One RECEPTION line per visit: it is the consultation reception already booked, and a second copy
-- would be billed twice.
CREATE UNIQUE INDEX "visit_procedures_one_reception_line"
    ON "visit_procedures" ("visit_id") WHERE "source" = 'RECEPTION';

CREATE INDEX "visit_procedures_tenant_id_visit_id_idx"
    ON "visit_procedures" ("tenant_id", "visit_id");

-- Tenant isolation, identical in shape to every other tenant-scoped table.
ALTER TABLE visit_procedures ENABLE ROW LEVEL SECURITY;
ALTER TABLE visit_procedures FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON visit_procedures
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- The audit trigger list is a literal array, which is how `attachments` once ended up with a gap.
CREATE TRIGGER visit_procedures_audit
  AFTER INSERT OR UPDATE OR DELETE ON visit_procedures
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
