-- Branches step 6.6 (BRANCHES-DESIGN §4.4, ruled 2026-10-30 and 2026-10-31): when a branch is created, every future-dated
-- exception is put to the clinic, not only the every-branch ones. Opened by a service, decided by a person, never a trigger.

CREATE TYPE "ExceptionReviewDecision" AS ENUM ('KEEP', 'COPY_TO_NEW_BRANCH');

CREATE TABLE "branch_exception_reviews" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "exception_id" UUID NOT NULL,
    "decision" "ExceptionReviewDecision",
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branch_exception_reviews_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "branch_exception_reviews_decided_together" CHECK (("decision" IS NULL) = ("decided_by" IS NULL) AND ("decided_by" IS NULL) = ("decided_at" IS NULL))
);
CREATE UNIQUE INDEX "branch_exception_reviews_branch_id_exception_id_key" ON "branch_exception_reviews"("branch_id", "exception_id");
ALTER TABLE "branch_exception_reviews" ADD CONSTRAINT "branch_exception_reviews_tenant_id_branch_id_fkey"
    FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "branch_exception_reviews" ADD CONSTRAINT "branch_exception_reviews_exception_id_fkey"
    FOREIGN KEY ("exception_id") REFERENCES "schedule_exceptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "branch_exception_reviews" ADD CONSTRAINT "branch_exception_reviews_decided_by_fkey"
    FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE branch_exception_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE branch_exception_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON branch_exception_reviews
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON branch_exception_reviews TO clinic_os_app;
CREATE TRIGGER branch_exception_reviews_audit AFTER INSERT OR UPDATE OR DELETE ON branch_exception_reviews
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
