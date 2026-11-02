-- Reverses 20261101082000_support_access_switch.
DROP TRIGGER "tenants_support_access_needs_clause" ON "tenants";
DROP FUNCTION enforce_support_access_contract();
ALTER TABLE "tenants" DROP COLUMN "support_access_enabled";
ALTER TABLE "platform_clinic_contracts" DROP COLUMN "data_processor_clause";

DELETE FROM _prisma_migrations WHERE migration_name = '20261101082000_support_access_switch';
