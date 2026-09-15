-- Phase 3 — patient insurance. `PHASE-3.md` Q18 (patient detail), founder ruling 1 September 2026.
--
-- Who is covered, by which insurer, under whose policy, and for how long. Claims are NOT here:
-- the founder ruled the claim workflow into Phase 5, recorded not integrated, on the finding that
-- Egyptian insurers offer a portal each plus paper. Modelling a claim now would build an
-- integration nobody can use.
--
--
-- THE POLICY HANGS OFF `contacts`, NOT `patients`
--
-- The founder's framing: **one phone, several patients, one policy.** `contacts` already is the
-- household — `patients.contact_id` points at it and `contacts` carries the unique
-- `(tenant_id, phone_e164)`. A father's policy covering his wife and two children is one
-- `insurance_policies` row and four `patient_insurance` rows, not four copies of a policy number
-- that can drift apart the day one of them is corrected.
--
-- The join table is not ceremony. Being under a household's phone does not mean being on that
-- household's policy — a live-in grandparent on their own government scheme is the ordinary case,
-- not the exotic one. Coverage has to be stated per patient rather than inferred from the contact.
--
--
-- THERE IS NO `is_active` COLUMN, FOR THE REASON D24 ALREADY GIVES
--
-- A policy is in force when `valid_from <= <the date asked about>` AND
-- `(valid_to IS NULL OR <the date asked about> <= valid_to)`. That comparison is made on every
-- read, against an instant the caller passes in. Nothing stores "expired" and no job writes it.
--
-- This is 19-patient-transfers.sql's rule applied to a second thing that expires, and it is the
-- same argument: a status column flipped by a nightly sweep looks like expiry, tests green
-- against it, and reports a lapsed policy as live forever if the sweep is never written or dies
-- quietly. Absence is the only symptom. **If you are here to add an expiry job, read D24 first.**
--
-- `valid_to` is nullable and NULL means open-ended, which is a real case — several Egyptian
-- corporate schemes renew silently and the desk is never told an end date. NULL must not read as
-- "expired" and must not read as "unknown": it is the honest value for a policy with no stated end.
--
--
-- WHAT IS DELIBERATELY ABSENT
--
-- No money. No coverage percentage, no ceiling, no co-payment. Those belong with the payer split
-- on `payments`, which is its own ruling and its own file — putting a percentage here would invite
-- a service to multiply by it and write the result somewhere, which is precisely the derived-money
-- drift D7 exists to prevent.

CREATE TABLE insurance_policies (
    "id"                UUID PRIMARY KEY,
    "tenant_id"         UUID NOT NULL REFERENCES tenants("id"),
    "contact_id"        UUID NOT NULL REFERENCES contacts("id"),

    -- Free text, not an enum or a lookup table. The founder's Phase 5 finding is that there is no
    -- integration and no registry to validate against; an enum here would be a closed list that
    -- the desk cannot extend when a patient arrives with an insurer nobody has seen, and the
    -- workaround for that is always a wrong value picked from the list.
    "insurer_name"      TEXT NOT NULL,
    "policy_number"     TEXT NOT NULL,

    -- The policyholder as the card names them. Deliberately NOT a foreign key to `patients`: the
    -- holder is very often an employer's employee who is not himself a patient of this clinic, and
    -- a nullable FK with a text fallback would give two places to read the same fact from.
    "policyholder_name" TEXT NOT NULL,

    "valid_from"        DATE NOT NULL,
    "valid_to"          DATE,

    "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    -- A window that ends before it starts is not a data-entry variation, it is a typo, and the
    -- read-time comparison above would silently report such a policy as never in force.
    CONSTRAINT insurance_policies_window_ordered
        CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from")
);

-- One insurer's policy number is one policy within a clinic. Scoped by insurer because two
-- insurers reusing a number is ordinary, and scoped by tenant because two clinics share nothing.
CREATE UNIQUE INDEX insurance_policies_number_unique
    ON insurance_policies ("tenant_id", "insurer_name", "policy_number");

CREATE INDEX insurance_policies_contact_idx ON insurance_policies ("tenant_id", "contact_id");

CREATE TABLE patient_insurance (
    "id"                           UUID PRIMARY KEY,
    "tenant_id"                    UUID NOT NULL REFERENCES tenants("id"),
    "patient_id"                   UUID NOT NULL REFERENCES patients("id"),
    "policy_id"                    UUID NOT NULL REFERENCES insurance_policies("id"),

    -- The existing `PatientRelationship` enum, not a new one. `patients.relationship_to_contact`
    -- already answers "who is this person to the phone owner" in exactly this vocabulary, and the
    -- two questions are the same shape. A second enum saying SPOUSE in different letters would be
    -- one more thing to keep in step for no gain.
    "relationship_to_policyholder" "PatientRelationship" NOT NULL,

    "created_at"                   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"                   TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- A patient appears on a given policy once. They may hold several policies — last year's lapsed
-- corporate scheme and this year's, or a government scheme alongside an employer's — so this is
-- NOT unique on (tenant_id, patient_id). Which one applies on a given date is the read-time
-- comparison's job, and more than one may apply at once; the screen shows what it finds rather
-- than picking a winner.
CREATE UNIQUE INDEX patient_insurance_patient_policy_unique
    ON patient_insurance ("tenant_id", "patient_id", "policy_id");

CREATE INDEX patient_insurance_patient_idx ON patient_insurance ("tenant_id", "patient_id");
CREATE INDEX patient_insurance_policy_idx ON patient_insurance ("tenant_id", "policy_id");

-- RLS, same shape as every other tenant-scoped table (D4, D15): ENABLE **and** FORCE, because
-- without FORCE the table owner bypasses the policy, and USING **and** WITH CHECK, because read
-- visibility and write legality are separate questions.
--
-- The comparison is spelled out inline rather than wrapped in a helper. The first draft of this
-- file (2026-09-01, unwired) called `current_tenant_id()`, a function that is defined nowhere in
-- this project -- so the file could not have been applied to any database, and had not been: no
-- migration referenced it and none of the three databases carried the tables. That is worth a
-- sentence rather than a silent correction, because a `.sql` file sitting in `prisma/sql/` looks
-- exactly like sixteen others that ARE applied, and nothing about its name says otherwise.
--
-- NULLIF(...) is not decoration either (01-constraints.sql): a bare `current_setting(...)::uuid`
-- throws on the empty string, while NULLIF turns "unset" into NULL, and `tenant_id = NULL` is
-- never true -- so an unbound session fails closed with zero rows visible and zero writable.
ALTER TABLE insurance_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE insurance_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON insurance_policies
    USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE patient_insurance ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_insurance FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON patient_insurance
    USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Audit triggers. 07-audit-triggers.sql builds these by looping over an explicit list of the
-- tenant-scoped tables; these two tables are new since that file was written, so they get the
-- identical trigger here rather than the list being edited retroactively.
--
-- The founder asked specifically that an edit to a patient's contact details be traceable, and
-- that reaches these tables too: `audit_row_change()` writes `previous_state` and `new_state` as
-- whole-row JSON on UPDATE, so a corrected policy number carries both spellings.
CREATE TRIGGER insurance_policies_audit
    AFTER INSERT OR UPDATE OR DELETE ON insurance_policies
    FOR EACH ROW EXECUTE FUNCTION audit_row_change();

CREATE TRIGGER patient_insurance_audit
    AFTER INSERT OR UPDATE OR DELETE ON patient_insurance
    FOR EACH ROW EXECUTE FUNCTION audit_row_change();
