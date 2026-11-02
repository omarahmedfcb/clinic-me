-- Support access, PR 1 (docs/SUPPORT-ACCESS.md): BUILT, NOT ENABLED. A per-clinic flag, off by default, that the database
-- refuses to turn on unless that clinic has a current contract recorded with the data-processor clause.

ALTER TABLE "platform_clinic_contracts" ADD COLUMN "data_processor_clause" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenants" ADD COLUMN "support_access_enabled" BOOLEAN NOT NULL DEFAULT false;

-- Fails closed: a session that cannot see the vendor's contracts (any clinic session) sees none, and is refused.
CREATE FUNCTION enforce_support_access_contract() RETURNS trigger AS $$
BEGIN
  IF NEW.support_access_enabled AND (TG_OP = 'INSERT' OR NOT OLD.support_access_enabled) THEN
    IF NOT EXISTS (
      SELECT 1 FROM platform_clinic_contracts c
       WHERE c.tenant_id = NEW.id AND c.data_processor_clause
         AND c.starts_on <= current_date AND c.ends_on >= current_date
    ) THEN
      RAISE EXCEPTION 'support access needs a current contract with the data-processor clause'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'tenants_support_access_needs_clause';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tenants_support_access_needs_clause BEFORE INSERT OR UPDATE OF support_access_enabled ON tenants
  FOR EACH ROW EXECUTE FUNCTION enforce_support_access_contract();
