# Schema Decisions — Answers to Phase 1 Checkpoint 1 Questions

**Date:** 21 August 2026
**Status:** Authoritative. Where this document conflicts with `ARCHITECTURE.md`, **this document wins.**
**Purpose:** resolve the nine ambiguities raised before `schema.prisma` is written.

Good catches — several of these were real gaps in the architecture document, not misreadings.

---

## Verdict on the seven proposed assumptions

| # | Assumption | Verdict |
|---|---|---|
| 1 | UUIDv7 via Postgres extension | ❌ **Rejected** — see D6 |
| 2 | Money as `Int` minor units | ✅ Approved |
| 3 | `remaining` computed in application code | ❌ **Rejected** — see D7 |
| 4 | Exclude the five undefined tables | ❌ **Rejected** — they are defined below |
| 5 | Add `allow_overlap` to appointments | ✅ Approved |
| 6 | Best-effort enum extraction | ⚠️ **Superseded** — authoritative list below |
| 7 | RLS + EXCLUDE as raw SQL in the migration | ✅ Approved |
| 8 | `payment_adjustments` field guess | ✅ Approved with additions |

---

## D1 — The five undefined tables

The DoD was right and §4 was incomplete. These are defined now and **are created in this migration**. They stay empty until Phase 6+.

### conversations
`id, tenant_id, contact_id, channel (enum, whatsapp only for now), external_conversation_id, status, last_message_at, opened_at, closed_at, assigned_to_user_id NULL, created_at, updated_at`
Unique: `(tenant_id, external_conversation_id)`

### messages
`id, tenant_id, conversation_id, contact_id, direction, message_type, external_message_id, template_id NULL, body_preview NULL (varchar 280), media_url NULL, status, failure_reason NULL, billable BOOL, billing_category, sent_at, delivered_at NULL, read_at NULL, created_at`
Unique: `(tenant_id, external_message_id)`

**`body_preview` is capped at 280 characters and must never hold clinical content.** The original brief says to avoid storing unnecessary message data; a truncated preview is enough for a support conversation and keeps sensitive data out of the message log.

### message_templates
`id, tenant_id NULL, name, external_template_name, language, category, bundles String[], body, variables Json, meta_approval_status, approved_at NULL, is_active, created_at, updated_at`

`tenant_id` is nullable: null means a platform-wide template. `bundles` lists the notification purposes one template satisfies — this is what enforces the message-bundling rule in `PRICING.md`.

### followup_tasks
`id, tenant_id, patient_id, doctor_id, visit_id, treatment_plan_id NULL, due_date, status, attempts INT DEFAULT 0, sent_at NULL, responded_at NULL, resulting_appointment_id NULL, expires_at, created_at, updated_at`

### invoices
`id, tenant_id, subscription_id, invoice_number, period_start, period_end, currency, subtotal_minor, overage_minor, discount_minor, tax_minor, total_minor, status, issued_at NULL, due_at, paid_at NULL, payment_reference NULL, eta_submission_id NULL, eta_status NULL, created_at, updated_at`
Unique: `(tenant_id, invoice_number)`

`eta_*` columns are for Egyptian Tax Authority e-invoicing. Unused now; the columns cost nothing and adding them to a table holding real invoices later does.

---

## D2 — payment_adjustments

Approved, with three additions:

`id, tenant_id, payment_id, adjustment_type (enum), amount_minor (signed), reason (required, not null), actor_user_id, previous_status, new_status, created_at`

`adjustment_type`: `CORRECTION | REFUND | DISCOUNT_APPLIED | WRITE_OFF`

`reason` is `NOT NULL` deliberately. An adjustment without a stated reason is indistinguishable from tampering when someone audits this in two years.

---

## D3 — allow_overlap

Confirmed. Add to `appointments`:

`allow_overlap BOOLEAN NOT NULL DEFAULT false`
`overlap_authorised_by_user_id UUID NULL`
`overlap_reason TEXT NULL`

The exclusion constraint predicate becomes:

```sql
WHERE (status NOT IN ('CANCELLED', 'NO_SHOW') AND allow_overlap = false)
```

An override records who authorised it and why. Silent overrides are how double-booking bugs become undebuggable.

---

## D4 — RLS and EXCLUDE constraints

Approved exactly as proposed. Workflow:

```bash
npx prisma migrate dev --create-only --name init
# hand-edit the generated SQL, then:
npx prisma migrate dev
```

Add to the hand-edited SQL, in this order:

1. `CREATE EXTENSION IF NOT EXISTS btree_gist;`
2. The `no_double_booking` exclusion constraint (§9, with the D3 predicate)
3. RLS enable + policies on 12 tables: `patients`, `visits`, `visit_revisions`, `prescriptions`, `prescription_items`, `payments`, `payment_adjustments`, `consents`, `treatment_plans`, `treatment_plan_sessions`, `prescription_access_tokens`, **`attachments`**
4. The append-only triggers from D5
5. The `remaining_minor` generated column from D7

**Correction (21 Aug 2026):** this list originally predated the `Attachment` model and read 11 tables. `attachments` holds patient-uploaded lab/imaging files — clinical data by the same reasoning that put `treatment_plans` and `prescription_access_tokens` on the list — and is added as the 12th.

Note that D3's addition means the RLS list is longer than §6 stated — treatment plans, prescription tokens, and attachments are clinical data and belong in it.

Keep this SQL in a checked-in file (`prisma/sql/01-constraints.sql`) and apply it from the migration, so it is reviewable in isolation rather than buried in generated DDL.

---

## D5 — Append-only enforcement

**Database-level, not advisory.** Application-only enforcement is a comment, not a guarantee, and these four tables are the audit trail that a regulator or an acquirer will examine.

Use a trigger rather than `REVOKE`, because the application connects as a single role that also needs write access:

```sql
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
```

Attach `BEFORE UPDATE OR DELETE` to: `audit_logs`, `appointment_events`, `visit_revisions`, `payment_adjustments`.

Add this to the Phase 1 DoD and write a test per table asserting that UPDATE and DELETE both raise.

---

## D6 — UUID v7 — assumption rejected

**Do not use a Postgres extension.** Generate v7 in the application.

Reason: the hosting provider is not selected yet, and data residency may force a smaller Egyptian host where `pg_uuidv7` is unavailable. A schema that will not migrate to the eventual production database is worse than a marginally less elegant one. `ARCHITECTURE.md` §18b makes portability an explicit requirement.

Implementation: the `uuidv7` npm package, injected by the same Prisma client extension already being built for tenant scoping. One extension, two responsibilities: set `tenantId`, set `id` if absent.

In the schema, IDs are `String @id @db.Uuid` with no `@default`. If a create ever arrives without an id, that is a bug in the extension registry and should throw rather than silently fall back to v4.

**Dependency precedent set here:** prefer a package with prebuilt native binaries over one requiring a node-gyp/C++ build toolchain, when both are otherwise reasonable — the founder's own machine has to `npm install` this too. Followed again for Argon2id password hashing (Phase 1 auth): `@node-rs/argon2` over `argon2`, for the same reason — prebuilt binaries, no Visual Studio Build Tools needed on Windows.

---

## D7 — `remaining` — assumption rejected — **amended 2026-09-03**

**Use a Postgres generated column** where the derivation lives inside one row. Where it does not, read the amendment at the end of this decision before reaching for a mechanism: the rule is that the *database* computes derived money, and the column is only the single-row form of it.

```sql
ALTER TABLE payments
  ADD COLUMN remaining_minor INT
  GENERATED ALWAYS AS (amount_due_minor - amount_paid_minor) STORED;
```

Reason: application-computed derived money drifts. One code path that updates `amount_paid_minor` without recomputing `remaining` produces a patient balance that is quietly wrong, and in a payments table that is the worst class of bug — it is silent, it is financial, and it is discovered by a customer.

A generated column cannot drift, and it is indexable for the "who owes us money" query that reception uses daily.

Prisma cannot write to it. Declare it in the schema as a nullable read field and mark it in the client extension as never-writable; the value comes from the hand-edited SQL in D4.

Apply the same reasoning anywhere else a stored total appears.

### Amended 2026-09-03 — the principle is *database-computed*, not `GENERATED`

**The rule is: derived money is computed by the database, never by application code. A generated column is one way to satisfy that rule; it is not the rule.**

Where the derivation stays inside a single row, `GENERATED ALWAYS … STORED` remains the form to use, and `payments.remaining_minor` above is unchanged by this amendment.

Phase 5's charge design forces the distinction. A `visit_charges` row is settled by *many* `payments` rows, so its balance is a **cross-table aggregate** — and `GENERATED ALWAYS` cannot express one, because a generated column may only read other columns of its own row. The three available forms, and where the ruling went:

- **A view, `visit_charge_balances` — ruled by the founder on 2026-09-03.** It cannot drift for the same structural reason the generated column cannot: there is no second write path to get wrong, because there is no write at all. The balance is recomputed from its inputs every time it is read.
- **A stored column maintained by a trigger. Rejected.** This satisfies D7's *letter* — the balance would be a column — while reintroducing precisely the failure D7 exists to prevent. A trigger is a write path, and a write path can be bypassed: a bulk `COPY`, a restore run under `session_replication_role = replica`, or a `DISABLE TRIGGER` during some future migration each produce a stored balance that silently disagrees with the rows beneath it. Silent, financial, discovered by a customer — the same sentence as the original reason.
- **Application-side summation. Rejected outright.** It is the thing D7 was written to forbid.

**Why this is recorded as an amendment to D7 rather than as a new decision.** The original text names a mechanism in its opening line — *"Use a Postgres generated column"* — and a reader who has only that line, meeting a view where the rule says column, would reasonably conclude the view is a violation and "restore" the column. Restoring it would mean a trigger, since a generated column is impossible across a one-to-many, so the restoration would be a regression carrying the authority of the numbered decision it was made in obedience to. **The mechanism was never the point. Drift was.** A new decision number would have left the misleading sentence sitting in D7 unqualified, which is the state that produces the bad restore.

**What is lost, stated so the trade is visible rather than discovered.** The original reason cites indexability for the "who owes us money" query reception runs daily, and a view's computed balance is not directly indexable. The mitigation is that the aggregate's *inputs* are: an index on the settlement side of `payments` covers the summation. If receivables ever measures too slow against real clinic data, the answer is a materialised view with an explicit refresh — still database-computed — and not a trigger-maintained column.

---

## D8 — Authoritative enum list

This supersedes any values inferred from prose. Where a value below does not appear in `ARCHITECTURE.md`, this list is still correct — the prose was incomplete.

```
MembershipRole          OWNER | ADMIN | DOCTOR | RECEPTIONIST
MembershipStatus        INVITED | ACTIVE | SUSPENDED | REVOKED
UserStatus              ACTIVE | SUSPENDED | LOCKED
TenantStatus            ACTIVE | SUSPENDED | ARCHIVED

SubscriptionStatus      TRIAL | ACTIVE | PAST_DUE | SUSPENDED | CANCELLED
BillingPeriod           MONTHLY | ANNUAL
InvoiceStatus           DRAFT | ISSUED | PAID | VOID | PAST_DUE

ServiceType             NEW | CONSULTATION | FOLLOW_UP | PROCEDURE   -- amended, see below
ScheduleExceptionType   BLOCKED | HOLIDAY | EXTRA_AVAILABILITY

PatientStatus           ACTIVE | ARCHIVED | MERGED
PatientRelationship     SELF | SPOUSE | CHILD | PARENT | SIBLING | OTHER

AppointmentStatus       BOOKED | CONFIRMED | ARRIVED | WAITING
                        | IN_CONSULTATION | COMPLETED | CANCELLED | NO_SHOW
AppointmentSource       WHATSAPP | RECEPTION | DOCTOR | ONLINE | WALK_IN
AppointmentEventType    CREATED | STATUS_CHANGED | RESCHEDULED
                        | CANCELLED | OVERLAP_AUTHORISED | NOTE_ADDED

VisitStatus             DRAFT | COMPLETED
TreatmentPlanStatus     ACTIVE | COMPLETED | ABANDONED
TreatmentSessionStatus  PLANNED | COMPLETED | SKIPPED

PaymentStatus           UNPAID | PENDING_CONFIRMATION | PARTIAL | PAID | REFUNDED
PaymentMethod           CASH | CARD | INSTAPAY | MOBILE_WALLET
                        | BANK_TRANSFER | OTHER
ConfirmationMethod      GATEWAY_WEBHOOK | MANUAL_RECEPTION | CASH
AdjustmentType          CORRECTION | REFUND | DISCOUNT_APPLIED | WRITE_OFF

ConversationStatus      OPEN | CLOSED
MessageDirection        INBOUND | OUTBOUND
MessageType             TEXT | TEMPLATE | IMAGE | DOCUMENT | LOCATION | INTERACTIVE
MessageStatus           QUEUED | SENT | DELIVERED | READ | FAILED
MessageCategory         UTILITY | SERVICE | MARKETING | AUTHENTICATION
TemplateApprovalStatus  PENDING | APPROVED | REJECTED
FollowupStatus          PENDING | SENT | BOOKED | DECLINED | EXPIRED | CANCELLED

ConsentPurpose          TREATMENT | WHATSAPP_COMMS
                        | PRESCRIPTION_DELIVERY | MARKETING
AuditAction             CREATE | UPDATE | DELETE | READ_SENSITIVE | LOGIN
                        | LOGOUT | PERMISSION_CHANGE | BREAK_GLASS_ACCESS

AttachmentCategory      LAB | IMAGING | REPORT | ID_DOCUMENT | OTHER
```

**31 enums total, not 28.** `AttachmentCategory` was added when the `attachments` table was added after this list was first written — it belongs here for the same reason every other enum does: exact values, no drift between what's approved and what's implemented.

**On `TenantStatus`:** billing state lives on `subscriptions`, not on `tenants`. A tenant is ACTIVE, SUSPENDED, or ARCHIVED as an operational fact; whether they have paid is a subscription fact. Mixing the two produces contradictory states like a trialling tenant that is also past due.

---

### D8 amendment — ServiceType gains CONSULTATION (2026-08-27)

This list originally recorded three service types. The founder specified four when the scheduling
backend was scoped: **NEW كشف · CONSULTATION استشارة · FOLLOW_UP إعادة كشف · PROCEDURE إجراء آخر**.

Recorded here rather than only in the schema because this document says it is authoritative and
supersedes values inferred from prose — so a schema that quietly disagreed with it would leave the
next reader trusting the wrong one. `prisma/sql/16-service-type-consultation.sql` adds the value.

Two implementation notes worth keeping:

- The value is added `AFTER 'NEW'`, not appended. Postgres sorts enum columns by declared order, so
  `ORDER BY type` yields the clinical sequence a receptionist expects rather than the order values
  happened to be added in. **Enum order cannot be changed later without recreating the type.**
- That migration does nothing else, deliberately. `ALTER TYPE ... ADD VALUE` and any *use* of the
  new value cannot share a transaction, and Prisma wraps each migration in one — so a migration
  that added the value and inserted a row using it would fail with "unsafe use of new value".

**Durations are not a property of the type.** They live on the `services` row, which is per tenant:
one clinic's كشف is thirty minutes and another's is twenty, and a global default would be wrong
for whichever clinic did not set it.

---

**Salvaged 2026-08-29.** This amendment and its migration were the only things on PR #20
that nothing else carried; the rest of that branch was superseded by PR #22 and closed.
The migration was renumbered from 13 to 16, the slot it wanted having been taken while it
sat open.

---

## D9 — `diagnosis_ref` in treatment_plans

Poorly named on my part. Replace with two columns:

- `diagnosis_text TEXT` — free text, copied at plan creation
- `origin_visit_id UUID NULL` — FK to the visit where the plan was created

There is no diagnoses table and none is planned for V1. The text is a snapshot: if the visit's diagnosis is later corrected, the plan retains what was true when it was made. The FK preserves the link for context without coupling the plan's validity to a mutable field.

---

## Additions to the Phase 1 Definition of Done

- [ ] Append-only triggers exist and are tested (UPDATE and DELETE both raise) on all four tables
- [ ] `remaining_minor` is a generated column, and a test asserts a write attempt fails
- [ ] All ids are UUID v7, generated in the application; a test asserts no v4 id is produced
- [ ] The exclusion constraint honours `allow_overlap`; tests cover both the blocked and the authorised path
- [ ] `prisma/sql/01-constraints.sql` is checked in and reviewable
- [ ] Every enum above exists with exactly these values

---

## D10 — Prisma version

Use Prisma 7. Pin EXACT versions in `package.json` — no caret:
`"prisma": "7.9.1"`, `"@prisma/client": "7.9.1"`, `"@prisma/adapter-pg": "7.9.1"`
A minor bump mid-project on a medical schema is not acceptable drift.

Five mandatory configurations:

1. `moduleFormat = "cjs"` in the generator block.
   NestJS is CommonJS by default. ESM adds risk we are not being paid to take.

2. Explicit `pg` pool options — NOT optional:
   ```ts
   new PrismaPg({
     connectionString: process.env.DATABASE_URL,
     connectionTimeoutMillis: 5000,
     max: 10,
   })
   ```
   Prisma 6 defaulted to a 5s connect timeout. The `pg` driver defaults to 0,
   meaning no timeout — a bad connection hangs forever instead of failing.

3. Do NOT use `@map` on enum values. Known Prisma 7 bug.
   Enum names are the database values. The D8 list uses SCREAMING_CASE — keep it.

4. Explicit dotenv loading. Prisma 7 no longer loads `.env` automatically.
   `import "dotenv/config"` at the top of `prisma.config.ts`.

5. Generator output path is required and lives outside `node_modules`.

**D4 supersession — the migration workflow changes:**
- `--schema` and `--url` CLI flags are removed
- `--from-url` / `--to-url` become `--from-config-datasource` / `--to-config-datasource`
- `shadowDatabaseUrl` goes in `prisma.config.ts`, not the CLI

### Implementation note — where the adapter actually lives

`@prisma/config`'s `datasource` shape (verified against the installed 7.9.1 types) only accepts `{ url, shadowDatabaseUrl }` — there is no `adapter` field. `prisma.config.ts` therefore only carries the plain connection string for CLI operations (`migrate`, `generate`, `studio`).

The `PrismaPg` instance with the pool options from item 2 (`connectionTimeoutMillis`, `max`) does **not** go in `prisma.config.ts` — it is constructed where `PrismaClient` is instantiated at runtime (`apps/api/src/prisma/client.ts`, not yet written — that is Phase 1 backend-service work, not this checkpoint):

```ts
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000, max: 10 });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
```

Two different files, two different concerns: `prisma.config.ts` is CLI tooling config, the adapter is application runtime config.

### Applied

- `apps/api/prisma/schema.prisma` — generator block updated to `provider = "prisma-client"`, `output = "../src/generated/prisma"`, `moduleFormat = "cjs"`; `datasource.url` removed (no longer legal in the schema file).
- `apps/api/prisma.config.ts` — created, with `dotenv/config` import and `datasource.url` / `shadowDatabaseUrl` from `process.env`.
- `apps/api/package.json` — created with exact-pinned `prisma`, `@prisma/client`, `@prisma/adapter-pg`, plus `pg` and `dotenv` at whatever exact patch npm resolved.
- `.gitignore` — added `src/generated/` for the generated client output.
- `npx prisma validate` and `npx prisma generate` both ran clean against the full 34-table schema. **Nothing in the schema was rejected by Prisma 7.**

---

## D11 — Optional patient fields

`Patient.dateOfBirth`, `Patient.gender`, and `Patient.emergencyContact` are nullable. `ARCHITECTURE.md` §4 lists them without a `NULL` marker; the original product brief marks them optional. The brief is correct.

**Rationale:** a clinic registering a walk-in at the desk will not have a date of birth. A required field there means staff invent one, and invented clinical data is worse than absent clinical data.

**Consequence for Phase 2:** patient age is derived, not stored, and every screen and report must handle an unknown age. Do not default to 0 or to today's date.

---

## D12 — RLS requires a non-superuser connection role

A Postgres superuser bypasses Row-Level Security unconditionally.
FORCE ROW LEVEL SECURITY does not apply to superusers — this is a
Postgres invariant, not a policy defect. The postgres:16 image creates
POSTGRES_USER as a superuser, so the default connection role silently
defeats every RLS policy.

Resolution: clinic_os_app (LOGIN, NOSUPERUSER, NOBYPASSRLS) is the
application runtime role. clinic_os remains the migration role only.
ALTER DEFAULT PRIVILEGES ensures future tables grant automatically.

Consequence: RLS isolation tests are meaningless unless they run as the
application role. A test that connects as the migration role passes
whether or not RLS works at all.

---

## D13 — Postgres authentication must be scram-sha-256, including loopback

The official postgres image leaves initdb trust rules for 127.0.0.1/32 and
::1/128 ahead of the scram-sha-256 rule its entrypoint appends. pg_hba matches
top-to-bottom, so any loopback connection skips password verification entirely.
Verified: a deliberately wrong password authenticated successfully.

Consequence: on the default image, database passwords provide no protection
over loopback. Enforced via POSTGRES_INITDB_ARGS in docker-compose.yml so the
setting is declarative and survives volume recreation.

---

## D14 — Append-only + ON DELETE RESTRICT means a tenant's data can never be fully deleted

Discovered while writing integration-test cleanup for the append-only tables
(D5): payment_adjustments, visit_revisions, appointment_events, and audit_logs
reject UPDATE and DELETE unconditionally, for every role, with no override.
ON DELETE RESTRICT on their foreign keys means that guarantee doesn't stop at
the row itself — it also blocks deleting whatever the row references. A single
payment_adjustment blocks deleting its payment; that blocks deleting the
patient it belongs to; that blocks deleting the tenant. The same chain runs
through visit_revisions and appointment_events. Once a tenant has any
clinical or financial history at all — which is Phase 1 by day one of real
use — the tenant row itself becomes permanently undeletable.

**This is correct, not a bug.** D5's reasoning stands: application-only
enforcement is a comment, not a guarantee, and these four tables are exactly
the audit trail a regulator or an acquirer will examine. A clinic's medical
and financial records must survive intact regardless of what happens to the
tenant relationship later.

**The collision:** Egypt's Personal Data Protection Law (PDPL) gives data
subjects an erasure right. "We cannot delete it, by design, on purpose" is
the correct engineering answer to a lawyer's question about a closed clinic's
data — but only if it's already the documented answer when the question is
asked, not a discovery made while answering it.

**Consequence for tenant offboarding:** deletion is not the mechanism.
Offboarding a tenant — whether by their choice or ours — will need an
anonymisation strategy: strip identifying fields (patient names, phone
numbers, national IDs, free-text notes) while preserving the row structure
and financial/audit trail the append-only guarantee protects. That
distinction — anonymise the person, keep the record — is what reconciles
PDPL erasure with medical/financial record-keeping obligations. **Not
designed here.** This entry exists so it's a planned Phase (likely alongside
billing/offboarding work), not a gap someone else finds first.

---

## D15 — RLS extended from 12 tables to 29: D4's boundary was the wrong question

D4 scoped RLS to 12 clinical/financial tables — the reasoning at the time was
"is this data sensitive." Found to be the wrong boundary while building
Checkpoint 3's guards: `TenantGuard` binds `tenantContext` via
`AsyncLocalStorage.enterWith()`, not `run()`, because a Guard's
`canActivate()` has no `next.handle()`-equivalent callback to wrap "the
controller and everything it calls" the way an Interceptor does (see
`tenant-context.ts` and `tenant.guard.ts`). The consequence: once
`TenantGuard` runs, `tenantContext` is bound ambiently for the rest of the
request, so a service that forgets an explicit `withTenant()` call still
runs *correctly scoped* at the Prisma/JS layer (Layer 2) — for any table
without RLS, that's the only layer there is. A bug that skips `withTenant()`
on a non-RLS table doesn't fail loudly; it just quietly loses Postgres's
independent enforcement, with nothing to notice.

**The right boundary is not "is this data sensitive." It's "is there a
second layer if the application layer fails."** Every tenant-scoped table
needs that second layer, not just the ones holding clinical or financial
data — appointments, for instance, held none under D4's list despite being
the most-read table in the product.

**Extended to:** `appointments`, `appointment_events`, `doctors`, `services`,
`schedule_templates`, `schedule_breaks`, `schedule_exceptions`, `contacts`,
`memberships`, `followup_tasks`, `conversations`, `messages`,
`usage_records`, `usage_alerts`, `subscriptions`, `invoices`,
`access_grants` — the 17 tenant-scoped tables D4 left uncovered, bringing
the total to 29. `usage_alerts` was not on the founder's original list for
this revision; included anyway on the stated principle (its `tenant_id` is
required, exactly like `usage_records`, which was on the list) and flagged
rather than silently decided either way.

**Not extended:** `Tenant`, `User`, `RefreshToken` — genuinely cross-tenant
by design (`tenant-scoped-models.ts`'s `"none"` classification), not an
oversight. `AuditLog`, `MessageTemplate` — nullable `tenantId` where `NULL`
is a deliberate, meaningful value (a platform-wide template, an audit row
surviving tenant deletion via `ON DELETE SET NULL`); the same RLS predicate
used everywhere else would make those legitimately-null rows invisible to
every tenant-scoped session, which needs its own design, not a mechanical
copy of this one.

**Real breakage found by extending this, exactly as expected:**
`listActiveMemberships()` (`user-lookup.ts`) and `resolveActiveMembership()`
(`refresh-tokens.ts`) are *deliberately* cross-tenant raw queries against
`memberships` — discovering which tenant(s) a user belongs to before any
single tenant is known, which is the one thing a per-tenant RLS session
variable structurally cannot express. With RLS enforced, both failed closed
unconditionally. Fixed with two `SECURITY DEFINER` SQL functions
(`prisma/sql/04-membership-lookup-functions.sql`,
`list_active_memberships_for_user`/`resolve_active_membership`), owned by
the migration superuser and granted to `clinic_os_app` by `EXECUTE` only —
running with the owner's RLS-bypassing privilege for exactly these two
lookups, with every other access to `memberships` through `clinic_os_app`
staying fully RLS-constrained. Not a broader bypass grant, which would have
undone the point of this entry for every other query on the table.

Migration cost today: one migration against an empty database. The same
change against live patient data would have been a project of its own.

---

## D16 — audit as a database guarantee, not an application convention

**This is the third application of the same principle in this document — D5
(append-only), D15 (RLS extension), now this. The next person facing this
choice for some other table should not have to re-litigate it: if
application code is the only thing standing between the database and an
unaudited/unenforced write, that is a comment, not a guarantee.**

Built first as `AuditInterceptor`: a NestJS interceptor writing to
`audit_logs`, with a request-scoped `auditContext` (`AsyncLocalStorage`,
mirroring `tenantContext`) carrying entity type/id and before/after state
from whichever service performed the mutation, since an interceptor sees
only the HTTP request and whatever the handler returns — never a created
row's generated id, never an update's prior state. Fully built, tested (7
integration tests against real Postgres writes), and committed rather than
discarded: the history should show what was tried and why it was replaced,
not just the replacement.

**The comparison:**

| | Interceptor | Trigger |
|---|---|---|
| Guarantee | Application convention — fires only if the route is wired to it and the service remembers to call `auditContext.record()` | Database fact — fires on every `INSERT`/`UPDATE`/`DELETE` regardless of code path: Nest app, a future background job, a raw migration, a bug that skipped the interceptor entirely |
| Before/after fidelity | Only as good as the service's discipline — a stale or wrong snapshot is a service bug away | `to_jsonb(OLD)`/`to_jsonb(NEW)` is the row Postgres actually just committed, unconditionally |
| Action | Inferred from HTTP verb (a guess — a `PATCH .../cancel` is technically still an `UPDATE` at the row level, which `TG_OP` gives directly and more reliably) | `TG_OP`, exact |
| New-route safety | A developer must remember to wire the interceptor and call `record()` on every new mutating endpoint | Automatic on any already-triggered table — nothing to remember |
| Actor / IP / User-Agent | Has them directly, from the JWT and the request | Cannot know them — genuinely HTTP-layer concepts. Needs the application to `SET LOCAL` them before writing, same pattern as `app.current_tenant_id` |
| Reads (`READ_SENSITIVE`, `BREAK_GLASS_ACCESS`) | Could eventually cover this | Cannot — no such thing as an `AFTER SELECT` trigger. Needs its own mechanism regardless of which way write-auditing goes |
| Review surface | TypeScript — the founder's daily working language | PL/pgSQL — a real, not hypothetical, cost for a non-developer founder |
| No-actor writes (seeds, migrations, jobs) | N/A — application code controls when it runs | Must be decided explicitly: `actor_user_id` is `NOT NULL`. See below |

**The concrete evidence, not just the argument:** the interceptor's first
working version wrote the audit row inside a fire-and-forget `tap()` — the
HTTP response could go out before the `INSERT` actually finished. Found by a
flaky test, not by inspection. That class of bug cannot exist in an `AFTER
INSERT` trigger: there is no fire-and-forget-vs-awaited distinction for a
trigger to get wrong, because the trigger runs as part of the same
statement, synchronously, by definition.

**Decision: triggers for writes.** The interceptor's remaining job shrinks
to threading actor/IP/User-Agent into session context (`withTenant()`,
extended) and whatever read-auditing mechanism `READ_SENSITIVE`/
`BREAK_GLASS_ACCESS` need later — which was always going to need something
interceptor-shaped regardless of this decision.

**No-actor-bound writes: raise, not a silent system default.** A trigger
that fires with `app.current_actor_id` unset raises an exception, blocking
the write — consistent with D5/RLS's own severity: this project's other two
database guarantees don't degrade gracefully either. But raising
unconditionally would be wrong on its own: ARCHITECTURE.md §9 already
describes a legitimate unattended mutation (the nightly no-show
auto-marking job), and seed scripts and data migrations are a normal part
of the product's lifecycle. The fix is not to weaken the raise — it's a
well-known **system user** row that any legitimate unattended process
explicitly authenticates as before writing, the same way a human actor's id
comes from a validated JWT claim. "Raise on nothing" and "a real, named
system account for unattended writes" answer different questions: the first
catches an oversight; the second gives a genuine non-human operation a real,
auditable identity instead of either an implicit silent default or a wall
that legitimate automation can't get past. `withTenant()`'s actor parameter
is required, not optional, at the TypeScript layer too — the same
defense-in-depth split as tenant scoping itself: a compile-time requirement
backed by a runtime one, not either alone.

### Applied

- `prisma/sql/05-uuid-v7.sql` — `uuid_generate_v7()`, core Postgres only (no
  extension, per D6). The trigger inserts into `audit_logs` from inside the
  database, where there is no application to obtain an id from, and every other
  id in the schema is v7; `gen_random_uuid()` would have made `audit_logs` the
  one table with randomly-ordered primary keys.
- `prisma/sql/06-system-actor.sql` — the system actor as a real `users` row with
  a well-known, v7-shaped id (`019b76da-a800-7000-8000-000000000001`), plus
  `system_actor_id()` as the single place that value is written down.
  `status = 'LOCKED'` and a `password_hash` that is not a parseable Argon2
  encoding, so it cannot be authenticated as. Reached from TypeScript through
  `modules/audit/system-actor.ts`, which resolves the id from the database
  rather than repeating the literal.
- `prisma/sql/07-audit-triggers.sql` — `audit_row_change()` and 29 triggers,
  the same table set as `tenant-scoped-models.ts`'s `"scoped"` classification
  and D15's RLS list. `TG_OP` for the action, `to_jsonb(OLD)`/`to_jsonb(NEW)`
  for state, the row's own `tenant_id`, and `actor_role` looked up from
  `memberships` rather than taken from the caller's JWT claim.
- `src/prisma/with-tenant.ts` — binds `app.current_actor_id`, `app.current_ip`
  and `app.current_user_agent` alongside `app.current_tenant_id`, in the same
  transaction, with `actor` as a required parameter. All four are set via
  `set_config(name, value, true)` rather than `SET LOCAL name = '...'`: the two
  are equivalent in effect, but `SET` is a utility statement with no
  bind-parameter support and can only be built by string interpolation, while
  `set_config` is an ordinary function call taking real bind parameters. That
  matters for `userAgent`, a raw attacker-controlled header with no shape to
  validate against.
- `src/common/audit.interceptor.ts` and `audit-context.ts` — **deleted**,
  replaced by `actor-context.interceptor.ts` and `actor-context.ts`. All that
  remains is binding the actor; the entity/before/after reporting machinery the
  interceptor needed from services is entirely superseded by `to_jsonb`. The
  rename is deliberate: an interceptor still called `AuditInterceptor` that
  writes no audit rows is a trap for the next reader.
- `src/modules/auth/password.ts` — `verifyPasswordHash()` now returns `false`
  on an unparseable stored hash instead of throwing. This is what makes the
  system actor's sentinel `password_hash` a barrier rather than a 500 on the
  login endpoint.
- `test/integration/audit-triggers.integration.spec.ts` — 9 tests. The
  load-bearing one issues a raw SQL `UPDATE` over a bare `pg` connection, with
  no Prisma, no `withTenant()`, and no Nest pipeline anywhere in the path, and
  asserts the audit row exists anyway. `audit-interceptor.integration.spec.ts`
  is deleted with the code it tested.

**Open, deliberately not decided here — `audit_logs` has no RLS, and now holds
clinical content.** D15 excluded it because its `tenantId` is nullable and a
mechanical copy of the standard policy would hide those legitimately-null rows
from every session. That reasoning is unchanged, but the stakes are: before
this entry `audit_logs` held whatever a service chose to report, and it now
holds `to_jsonb(NEW)` of every row of all 29 tables — diagnoses, notes,
prescriptions, in full. Nothing reads `audit_logs` yet, so nothing is exposed
today, and the first thing that does read it must not be written before this is
settled. The policy it needs is not the standard one: `tenant_id IS NULL` on
this table means "the tenant was deleted", so making null rows visible to
everyone is as wrong as hiding them. Flagged for the founder rather than
guessed at. **Resolved immediately after, in D17 — do not read this paragraph
as still open.**

### Writing an audit_logs row: use `injectedIdOnly()`, never `injected()`

**Added 2026-08-25.** `audit_logs` is registered `"nullable"` in the tenant
scoping registry (`src/prisma/tenant-scoped-models.ts`), not `"scoped"`. The
Prisma extension therefore supplies its `id` and deliberately does **not**
supply its `tenantId`: on this table a null tenant is a meaningful value, not
an omission — it is what an audit row looks like after the tenant it describes
has been deleted (D18) — so the extension refuses to guess one and the caller
must choose.

That makes `injected()` the wrong helper here, and wrong in the quiet
direction. `injected()` exists to remove `id` and `tenantId` from a create
input, because for a `"scoped"` model those are the two fields the extension
fills in and a caller must never pass. Reach for it on `audit_logs` and the
compiler stops you from writing `tenantId` at all — and the obvious way to
make that error go away is to delete the field, which produces a NULL-tenant
audit row. RLS then rejects the write, so it fails rather than corrupting
anything, but the failure arrives as a policy violation some distance from the
line that caused it.

Use **`injectedIdOnly()`** (`src/prisma/injected.ts`) for the `"nullable"`
models — `AuditLog` and `MessageTemplate` today. It supplies the id and leaves
`tenantId` in the type exactly as the schema declares it, so the choice stays
visible at the call site.

The rule generalises: **the helper follows the registry.** `"scoped"` →
`injected()`. `"nullable"` or `"none"` → `injectedIdOnly()`. If you add a model
to `TENANT_POLICY` with anything other than `"scoped"`, its writes use
`injectedIdOnly()`.

---

## D17 — RLS on audit_logs: the unprotected mirror

D16 left the product with 29 tables under row-level security and one
unprotected copy of all of them. `audit_logs` holds `to_jsonb(NEW)` of every
row of every protected table — every diagnosis, examination note, and
prescription line in the system — and was the one tenant-carrying table with
no policy on it. Closed here, before anything is written that reads the table.

D15's stated obstacle turns out to be the answer rather than a problem to work
around. The concern was that the standard predicate would make nullable-tenant
rows invisible to everyone. It does, and that is correct:
`tenant_id = <bound tenant>` is never true when `tenant_id` is NULL — ordinary
SQL NULL semantics, no special case in the policy — and `tenant_id IS NULL` on
this table means **the row is not part of any tenant's history**. No tenant
session has any business reading one. (This entry originally said NULL meant
"the tenant was deleted". That was wrong, and D18 explains why: the FK action
that would have produced such a row could never fire. The policy is unaffected
— it was always the population, not the cause, that mattered — but the wording
described rows that could not exist.) So `audit_logs` gets the same policy shape
as the other 29, verbatim, with ENABLE + FORCE, and the D5 append-only trigger
stays. RLS governs which rows a session may see and write; the append-only
trigger governs which operations exist at all. They are orthogonal and both
apply.

**The failure mode worth naming, because it is not obvious and it is not
confined to `audit_logs`:** `audit_row_change()` is a SECURITY INVOKER
function, so it runs as `clinic_os_app`, which is `NOBYPASSRLS` (D12). Its
`INSERT` into `audit_logs` is policed by `WITH CHECK` exactly like any other
application write. A policy that rejected it would not fail visibly on this
table — it would fail on **every mutation in the entire product**, because the
trigger is part of the writing statement. It passes because the trigger stamps
the audit row with the *source row's* `tenant_id`, and the source row was only
writable in the first place because it matched the same bound session tenant.
The two agree by construction, not by luck: if they ever disagreed, the source
write would have been rejected first. This is the first assertion in
`audit-logs-rls.integration.spec.ts` and should stay first.

**Orphaned rows get one door, and it is audited.** `read_orphaned_audit_logs()`
in `prisma/sql/08-audit-logs-rls.sql`, the same narrowly-scoped SECURITY
DEFINER pattern as D15's membership lookups and for the same reason — an
escape hatch for exactly one operation, rather than a bypass grant that would
undo the policy for every other query on the table. Three properties make it a
door rather than a hole: it returns only `tenant_id IS NULL` rows, so it cannot
be turned on a live tenant; it refuses any caller who is not an ACTIVE platform
admin, reading the actor from `app.current_actor_id` rather than taking it as a
parameter, so a caller cannot name someone else as the reader; and every call
writes its own `BREAK_GLASS_ACCESS` row before returning anything, in the same
transaction, so there is no ordering in which the data is disclosed but the
disclosure is not recorded. Reading a closed clinic's history is itself part of
the record.

That `BREAK_GLASS_ACCESS` row is NULL-tenant and therefore invisible to every
ordinary session, by the same policy that made the function necessary. That is
consistent, not circular: the record exists, is append-only, and is reachable
by the same audited door as everything else in that population. As of D18 it is
also the *only* population member the product currently produces — the door is
built ahead of the rows it is for, deliberately, because the alternative is
building it during the incident that needs it.

**Considered and not done:** reclassifying `AuditLog` from `"nullable"` to
`"scoped"` in `tenant-scoped-models.ts`, which would add Layer 2 filtering on
top of the new Layer 3 policy. Rejected because `"scoped"` also auto-injects
`tenantId` on write, which would take away the NULL that this whole entry is
built around — and because no application code writes to `audit_logs` at all
any more, since D16. The classification still describes the table accurately.

**Consequence for existing tests, worth knowing before writing new ones:** any
read of `audit_logs` now needs a bound tenant session, and any test that
inserts a row directly needs one too. Two specs had to change, and both were
correct changes rather than accommodations — an unbound read silently returned
zero rows instead of everything, which would have made assertions vacuous
rather than failing loudly.

### Applied

- `prisma/sql/08-audit-logs-rls.sql` — ENABLE + FORCE + `tenant_isolation`
  policy on `audit_logs`, identical in shape to the other 29, plus
  `read_orphaned_audit_logs(integer)`.
- `test/integration/audit-logs-rls.integration.spec.ts` — 7 tests. The
  trigger-can-still-write proof first; tenant A cannot read tenant B's audit
  rows (with the converse asserted too, so the test cannot pass against a
  policy that merely hides everything); orphaned rows invisible to both a bound
  and an unbound session, verified against a superuser connection that *can*
  see them; break-glass refused for a non-admin and for an unbound actor;
  break-glass returning rows and writing its own record; and ENABLE/FORCE plus
  the append-only trigger still in place.
- `test/integration/audit-triggers.integration.spec.ts` — reads now go through
  `withTenant()`, and the structural trigger-coverage check excludes
  `audit_logs`, which carries RLS but deliberately has no audit trigger of its
  own.
- `test/integration/sql-guarantees.integration.spec.ts` — the `audit_logs`
  append-only test binds a tenant for its insert and for both rejection
  assertions. Unbound, the row is invisible and Prisma reports "record not
  found" instead of the append-only rejection, which would have quietly stopped
  proving the trigger.

## D18 — ON DELETE SET NULL on an append-only table is a contradiction

`audit_logs.tenant_id` carried `ON DELETE SET NULL`. Setting a column to NULL
is an UPDATE, and D5's append-only trigger refuses UPDATE on `audit_logs`
unconditionally, for every role, with no override. Both guarantees were in the
schema at once and they cannot both hold.

Found while writing D17 and initially noted as a loose thread. It is not one.
It made D17's orphaned-row design describe a population that could not exist,
and it turned an ordinary operation into an unexplainable error.

**Observed, not theorised.** A tenant whose scoped tables are empty but whose
audit history is not — a clinic that registered a patient and later deleted
them — fails deletion with:

```
P0001  Table audit_logs is append-only
```

No constraint name, no table, because it is a bare `RAISE EXCEPTION` from
`forbid_mutation()` rather than a foreign-key violation. Whoever ran the delete
is told the audit table is append-only, which says nothing about what they did
wrong or what they should do instead. The 29 other `tenant_id` foreign keys are
`RESTRICT` and would normally block first, but audit rows outlive the rows they
describe, so a tenant can reach a state where they have nothing left to block
on and `audit_logs` is what the delete actually reaches.

**Decision: `ON DELETE RESTRICT`**, matching the 29 others.

Of the three options considered, this is the only one that does not weaken an
existing guarantee. Permitting the trigger to allow exactly this one UPDATE
(tenant_id going from a value to NULL, nothing else changing) would put a hole
in a guarantee whose entire value is being unconditional — and D5's reasoning
is that application-level *anything* is a comment, not a guarantee; a
narrowly-conditional trigger is a step back toward that. Dropping the nullable
`tenant_id` would discard a column that is still meaningful. And the guarantee
being changed here is the weakest of the three by a wide margin: `SET NULL` was
Prisma's default for an optional relation, never a decision anyone made. D14
had already concluded that deleting a tenant is not the mechanism for
offboarding one; this makes the schema say what D14 concluded instead of
carrying an FK action that contradicted it and could never fire.

`RESTRICT` rather than `NO ACTION`, which is what was first proposed. They
differ only in that `NO ACTION` defers its check to end of statement, which
exists so a statement can delete the referencing rows itself — precisely what
append-only forbids here. `NO ACTION` would buy nothing and would make this the
one `tenant_id` foreign key in the schema shaped differently from its siblings.

**`tenant_id` stays nullable, and D17's framing of NULL is corrected rather
than its design.** NULL on this table means "not part of any tenant's history".
That covers platform-level events — `read_orphaned_audit_logs()`'s own
`BREAK_GLASS_ACCESS` rows are the live example, and are currently the only
rows in that population — and whatever future anonymisation process D14 calls
for. What it never meant, and now cannot be read as meaning, is "a tenant row
was deleted out from under this one".

**The generalisable lesson, which is why this is its own entry rather than a
footnote to D17:** a referential action is a write. Every `ON DELETE SET NULL`
and `ON DELETE CASCADE` in this schema is an UPDATE or DELETE that some trigger
or policy may refuse, and Prisma picks those actions by default from the
nullability of the relation, not from anything the schema author decided. Any
table protected by an append-only trigger or a restrictive RLS policy must have
every foreign key *pointing at it* and *pointing out of it* checked against
that protection. The check that catches this is not code review, it is asking
of each FK: what statement does this action actually run, and is that statement
allowed here.

### Applied

- `prisma/sql/09-audit-logs-tenant-fk.sql` — drops and recreates
  `audit_logs_tenant_id_fkey` with `ON DELETE RESTRICT`.
- `prisma/schema.prisma` — `onDelete: Restrict` made explicit on
  `AuditLog.tenant`, with a comment saying why, so a future `prisma migrate
  dev` does not silently regenerate `SetNull` from the relation's optionality.
  `prisma migrate diff` reports no drift between datamodel and database beyond
  the known, deliberate `payments.remaining_minor` generated column (D7), which
  Prisma cannot express.
- `test/integration/audit-logs-rls.integration.spec.ts` — asserts the delete
  now fails as SQLSTATE `23503` naming `audit_logs_tenant_id_fkey`, and
  explicitly asserts the message does *not* match `/append-only/`. The fixture
  is built from scratch rather than from `seedClinic()`, whose leftover
  membership, doctor and service block on their own foreign keys first and
  would hide the case under test.

### Sweep for the same bug elsewhere

Every foreign key on the four append-only tables (`audit_logs`,
`appointment_events`, `visit_revisions`, `payment_adjustments`) was checked
against `pg_constraint` for a delete action that would write to them. After
this change: **zero**. All eleven are `ON DELETE RESTRICT`. `audit_logs ->
tenants` was the only instance.

One latent case is left in place knowingly. All eleven are `ON UPDATE CASCADE`,
Prisma's default, and a cascading update of a parent's primary key would be an
UPDATE on an append-only table — the identical contradiction, reached by the
other referential action. It is unreachable in practice because every primary
key in this schema is a UUID assigned once at creation and never changed (D6),
and nothing in the product offers a way to change one. Recorded rather than
"fixed" because changing eleven foreign keys to guard against an operation the
schema does not permit would be churn, and because the next person to consider
a mutable natural key anywhere in this database needs to find this paragraph
before they do it.

---

## D19 — Bilingual patient names, and how search finds them

**Decided 2026-08-24. Migration `20260824100000_patient_bilingual_names` applied;
the seed rewrite is still outstanding.**

Patients get `full_name_ar` and an optional `full_name_en`. The question that
drove the design was not storage, it was search: what happens when a
receptionist types Latin letters and the patient has no English name recorded.

**Why this is a safety decision, not a search-quality one.** If `mohamed`
returns nothing for محمد أحمد, the receptionist does not conclude that search
is imperfect — she concludes the patient is not registered, and creates a
second record. Duplicates split a medical history permanently, and since
medical records are never hard-deleted (`CLAUDE.md`), the split is repaired
only through the merge path that `patients.merged_into_patient_id` already
models. Preventing the duplicate is much cheaper than merging it.

**This is a correctness problem, not a performance one.** A clinic holds
hundreds to a few thousand patients; a sequential scan over that is
sub-millisecond, so no index is what makes search fast. What is expensive to
change later is the *semantics* — whether Latin input can match an Arabic-only
patient at all — because that decision is what forces a derived column, and
derived columns are what you cannot cheaply retrofit once tenants hold real
data.

**Two derived columns, split by volatility:**

| Column | Contents | Maintained by |
|---|---|---|
| `name_search_ar` | Arabic normalisation of `full_name_ar` | Postgres `GENERATED ALWAYS … STORED` |
| `name_search_latin` | transliteration of the Arabic name, plus normalised `full_name_en` | application, with a backfill script |

They are split because they change at different rates. Arabic normalisation is
a fixed set of character equivalences that will not change; transliteration is
a table we will improve repeatedly. Splitting them means improving
transliteration rebuilds one column and leaves the other untouched. The stable
half is `GENERATED`, so it cannot drift from its source — the same reasoning as
every other invariant in this schema that lives in the database rather than in
application code.

Note the standing constraint on `GENERATED` columns: the expression cannot be
altered in place, so changing it means dropping and re-adding the column. That
is acceptable precisely *because* the volatile half was kept out of it.

**Arabic normalisation earns its place independently of the bilingual
question.** Staff type أحمد and احمد interchangeably, and محمّد with and without
shadda. Unifying alef forms (أ إ آ → ا), ى → ي, ة → ه, stripping tashkeel and
tatweel is the single largest cause of "patient not found" in Arabic systems,
and it would be needed even if English names never existed.

### The nine normalisation rules, and what each one wrongly merges

Implemented in `normalize_arabic_name()`
(`prisma/sql/10-patient-bilingual-names.sql`). Listed with false positives
rather than intent alone, because a rule that collapses two different names is
the expensive kind of mistake here.

| # | Rule | Merges (wanted) | Wrongly merges | Risk |
|---|---|---|---|---|
| 1 | strip tashkeel U+064B–U+065F, U+0670 | محمّد → محمد | nothing realistic — tashkeel is almost never typed | none |
| 2 | strip tatweel ـ U+0640 | محـمـد → محمد | nothing — purely presentational | none |
| 3 | strip zero-width / bidi U+200B–U+200F, U+061C | names pasted from WhatsApp with invisible marks | nothing — invisible by definition | none |
| 4 | Farsi yeh ی → ي, keheh ک → ك | non-Arabic keyboard artifacts | nothing — unused in Arabic text | none |
| 5 | collapse and trim whitespace | `"محمد  سيد"` → `"محمد سيد"` | nothing | none |
| 6 | alef forms أ إ آ ٱ → ا | أحمد/احمد, إبراهيم/ابراهيم | no realistic Egyptian collision could be constructed; theoretically lossy since أ and إ merge | low |
| 7 | ؤ → و, ئ → ي, standalone ء dropped | عائشة/عايشة, رؤوف/رءوف | **سماء / سما** — both used as names | low |
| 8 | teh marbuta ة → ه | فاطمة/فاطمه, حمزة/حمزه | **عبده (m) / عبدة (f)** | low–medium |
| 9 | alef maksura ى → ي | على/علي, مصطفى/مصطفي, يحيى/يحيي | **حسني (m) / حسنى (f)**, **يسري (m) / يسرى (f)** | medium |

**Rule 9 applies everywhere, not only at the end of a word**, and the reason is
orthographic rather than pragmatic: alef maksura has no medial form in Arabic —
it occurs only word-finally — so there is no legitimate mid-word ى for a global
rule to damage. Where it does appear mid-word it is a mistyped ي, which we want
merged anyway. The practical argument points the same way: a full name is
several words, so ى routinely sits at the end of a word that is not the end of
the string, and a positional rule would need word-boundary matching inside an
expression that can never be altered in place.

**Rules 8 and 9 are kept on frequency.** ى is the *native* final spelling of
مصطفى, يحيى, منى, ليلى and على — in Egypt على is the ordinary way to write Ali.
Dropping rule 9 would fail to find the most common Egyptian names, constantly,
which is the failure that produces duplicates. The collisions it causes are
rarer and, given the two constraints above, surface as two adjacent rows rather
than one wrong one.

**Explicitly rejected as too aggressive:** stripping the definite article ال,
and stripping the particle عبد. Both would collapse genuinely distinct names.

**Transliteration is a hand-rolled table, not a dependency.** Roughly fifty
lines covering Egyptian given names. A library would be a permanent dependency
for a table we would end up overriding anyway, and we want to own it at the
moment it is wrong.

**Phone is the real lookup key.** It is E.164, effectively unique, and the
receptionist usually has it. Making phone the primary search affordance in the
UI is what keeps imperfect transliteration from being harmful.

**Indexing:** `pg_trgm` GIN on both derived columns, giving substring matching
and similarity ranking. Requires enabling the extension in the migration.

### The two constraints that make over-merging survivable — load-bearing, not notes

Rules 8 and 9 of the normalisation (see below) knowingly collapse genuinely
different names: عبده (m) with عبدة (f), and حسني (m) with حسنى (f), يسري (m)
with يسرى (f). They are accepted only because of these two properties, which
are part of the design and not incidental details of a first implementation:

1. **`name_search_ar` carries no `UNIQUE` constraint and never drives an
   automatic merge.** It is a retrieval key only.
2. **Search results display `full_name_ar`, never the normalised form, and show
   it alongside phone number and date of birth.**

**If either is removed, rules 8 and 9 become unsafe.** This is worth stating
plainly because both look like things a later change would remove without
noticing. Adding a unique index on the search key looks like ordinary
tidying-up; it would instead turn every one of those collisions into a write
that fails against a real patient. Rendering the normalised name in a result
list looks like a simplification; it would instead show two different patients
as the same string, at the exact moment a receptionist is choosing between them.

The ranking that drives this is the founder's, and it is the opposite of the
naive one: **a rule that collapses two genuinely different names is worse than
one that misses.** A missed match causes a duplicate record, which is
recoverable through the merge path `patients.merged_into_patient_id` already
models. An over-merged result list invites selecting the *wrong* patient, and
clinical data attached to the wrong person is not recoverable. Over-merging is
therefore tolerable only while a human can still see the difference — which is
precisely what constraint 2 preserves.

`test/integration/arabic-name-normalisation.integration.spec.ts` asserts both
constraints directly, alongside the known collisions themselves.

**Sorting — decided: patient lists are not sorted by name.** They sort by
appointment time, arrival order, or last visit; search results rank by trigram
similarity. This is recorded so nobody builds an alphabetical directory by
reflex. The reason it matters: under code-point ordering, Latin (U+0041–007A)
sorts entirely before Arabic (U+0600+), so a mixed list does not interleave —
it pins the handful of English-named patients to the top and reads as a bug.
Fixing that properly means ICU collation (`ar-x-icu`), and column collation is
fixed at creation and needs a reindex to change. Avoiding the screen avoids the
question.

**Not additive.** `patients.full_name` was a *single* column, so the migration
renames it to `full_name_ar` in place rather than adding beside it. No data
moves — every existing patient name is already Arabic. `users.full_name` is
staff and is deliberately untouched; bilingual staff names are not in scope.

**Resolved 2026-08-26.** Both remaining items are done: seeded patients carry English names
at a realistic minority rate (~22%), and the transliteration table and backfill exist. The
decisions and their measurements are recorded below.

### The transliteration table — decided 2026-08-26, with measurements

**A letter-level table cannot work, and it fails in a way that looks like it works.** Arabic omits
short vowels, so a faithful character mapping returns consonant skeletons:

| Arabic | Letter mapping gives | What a receptionist types |
|---|---|---|
| محمد | `mhmd` | Mohamed |
| محمود | `mhmwd` | Mahmoud |
| شريف | `shryf` | Sherif |
| طارق | `tark` | Tarek |
| نرمين | `nrmyn` | Nermeen |

The vowels are not in the source to map — they have to be known per name. So
`src/modules/patients/domain/transliterate.ts` is a **word-level dictionary with no letter-level
fallback**, which is what "roughly fifty lines covering Egyptian given names" above always meant in
practice. It is worth stating plainly: the fifty lines are the mechanism, not a lookup table
accelerating a general algorithm. There is no general algorithm.

#### Decision 1 — an unrecognised name stores NULL, never a skeleton

`nrmyn` would be unfindable by any Latin input a human would type, and indistinguishable in the
column from a row the dictionary handled well. That is a guarantee that looks total and is not.

NULL is an honest "no Latin key": `full_name_en` and the phone number remain the routes in, and an
unrecognised name is distinguishable from a well-handled one. **A skeleton would make that
unknowable.**

A name where *some* components resolve keeps them — محمد مصعب الشناوي yields a key covering Mohamed
and El Shennawy, with the unknown middle name contributing nothing. Dropping the whole name to NULL
because one component is rare would throw away a working search key and cause the duplicate this
decision exists to prevent.

#### The health signal is the PARTIAL rate, not the NULL count

This correction matters more than it looks, and the first version of this section got it wrong.

`SELECT count(*) FROM patients WHERE name_search_latin IS NULL` counts only the names where
**nothing at all** was recognised. That is close to a floor, and it is not where the dictionary will
actually fail. Egyptian **given** names are effectively a closed set — a few hundred names cover
almost every patient, and the table already holds them. **Family names are not a closed set.** New
surnames arrive continuously, and a patient with a known given name and an unknown surname produces
a perfectly non-NULL key that is missing the part a receptionist most often searches by.

So the dictionary degrades as a **rising `partial` rate**, with the NULL count sitting near zero
throughout. Someone watching only the NULL count would conclude the dictionary is fine while it is
quietly getting worse — which is the same shape as every other problem recorded in this document: a
guarantee that looks total.

**The admin view tracks the `partial` share reported by `latinKeyCoverage()`**
(`src/modules/patients/domain/transliterate.ts`), which classifies a name as `full`, `partial` or
`none`. The NULL count is still worth showing beside it, but as the smaller number and not as the
signal. `npm run backfill:name-search-latin` prints all three per tenant on every run.

#### Decision 2 — the column holds every plausible spelling, space-separated

Measured with `pg_trgm` at the 0.3 threshold, over 81 cases where a receptionist types a real
spelling other than the stored one, and over all 4,005 pairs of distinct names:

| `name_search_latin` holds | Recall | False matches across 4,005 name pairs |
|---|---|---|
| One spelling | 63/81 (78%) | 14 |
| **All spellings** | **81/81 (100%)** | **13** |

Recall reaches 100% and the false-match count does not rise, so this is not a trade-off. The misses
a single spelling produces are not exotic: `Mohamed`/`Muhammad` scores 0.13, `Nevine`/`Niveen` 0.08,
`El Kady`/`El Qadi` 0.23, `Guirguis`/`Girgis` 0.25. **76 of the 90 seeded name components have more
than one spelling in real use** — 14 have one, 71 have two, 5 have three.

The first spelling of each entry is the Egyptian convention, not the scholarly transliteration.
MSA `u` is Egyptian `o` and the article is `El`, not `Al`, so a rule-based transliterator that got
the vowels right would still produce the wrong answer for this country:

| Arabic | Egypt writes | A defensible transliteration |
|---|---|---|
| محمد | Mohamed | Muhammad |
| جرجس | Guirguis | Girgis |
| مصطفى | Mostafa | Mustafa |
| هدى | Hoda | Huda |
| القاضي | El Kady | El Qadi |

#### Decision 3 — the similarity threshold stays at 0.3

Raising it trades recall for a false-match reduction we do not need. Constraint 2 above already
makes over-merging survivable — results display `full_name_ar` alongside phone and date of birth —
while a miss creates a duplicate record, which splits a medical history permanently.

#### The false matches, known and measured

Recorded the same way as the normalisation collisions, because someone will find these and think
they are a bug. These are pairs of **genuinely different names** that score at or above 0.3 and can
therefore appear in the same result list:

| Pair | Stored keys | Similarity |
|---|---|---|
| عماد / إيمان | Emad Imad / Eman Iman | **0.60** |
| خالد / خليل | Khaled Khalid / Khalil Khaleel | 0.42 |
| سيد / السيد | Sayed Sayyed / El Sayed Elsayed Al Sayed | 0.38 |
| سامح / سماح | Sameh / Samah | 0.33 |
| صلاح / سلمى | Salah / Salma | 0.33 |
| مريم / مارينا | Mariam Maryam / Marina | 0.31 |
| عبد العزيز / عبد الحميد | Abdelaziz… / Abdelhamid… | 0.30 |
| الشناوي / الشربيني | El Shennawy… / El Sherbiny… | 0.30 |

Thirteen such pairs exist across 4,005 comparisons. They are accepted for the same reason rules 8
and 9 of the normalisation are: the key is never displayed and never drives an automatic merge, so
a human choosing between two adjacent rows sees two different Arabic names, two phone numbers and
two dates of birth. **Remove either constraint and this list becomes unsafe.**

#### The nine rules now exist twice, and that is guarded

`normaliseArabicName()` in `src/modules/patients/domain/normalise-arabic.ts` reimplements
`normalize_arabic_name()` in TypeScript, because the dictionary lookup has to normalise before
matching — otherwise أحمد and احمد are two different keys — and the SQL function cannot be called
without a database round trip. Duplication without a guard is not acceptable here, so
`test/integration/arabic-normalisation-parity.integration.spec.ts` runs both implementations over
every seeded name and the edge cases of all nine rules and asserts they agree character for
character. Verified by breaking it: dropping the teh-marbuta rule from the TypeScript side alone
fails the test and prints each disagreement.

#### Maintenance

`name_search_latin` is the volatile half by design, so nothing recomputes it when the dictionary
changes — unlike `name_search_ar`, which Postgres recomputes because it is `GENERATED`. **Run
`npm run backfill:name-search-latin` after any change to the table.** It is idempotent, goes
through `withTenant()` per tenant rather than connecting as the migration superuser, and leaves an
audit row per changed patient attributed to the system actor.

#### Every write path that touches a name must recompute `name_search_latin`

The two derived name columns are maintained by **different things**, and that asymmetry is the trap
in this decision:

| Column | Maintained by | On an `UPDATE` |
|---|---|---|
| `name_search_ar` | **Postgres.** `GENERATED ALWAYS … STORED` from `normalize_arabic_name(full_name_ar)` | Recomputed automatically. Nothing can forget it — the scoping extension rejects writing it at all |
| `name_search_latin` | **The application.** `latinSearchKey(full_name_ar, full_name_en)` | **Nothing happens unless the write path does it** |

**The trap is that the Arabic key working looks like proof the pair is handled.** Change a name
through a path that forgets the Latin key and Arabic search keeps finding the patient perfectly,
because Postgres maintained that column itself. Only Latin search is wrong — and wrong in the worst
available direction: the patient stays findable under the **old** spelling and stops being findable
under the **corrected** one. A receptionist searching the name as it is now written finds nothing,
concludes the patient is not registered, and creates exactly the duplicate this decision exists to
prevent. Nothing errors. The symptom surfaces months later as a split history.

Stated as a rule: **any write path that sets `full_name_ar` or `full_name_en` must also set
`name_search_latin`, computed from the post-update value of *both* fields.** Computing it from the
incoming patch alone is the same bug in miniature — changing only the English name would drop the
Arabic half out of the key.

**Historical accuracy, because a decision document that overstates is as damaging as one that goes
stale.** No update path has ever shipped without the recompute. `PATCH /patients/:id` did not exist
at all until 2026-09-02 — Q24 recorded *"patients has a POST and no PATCH and no DELETE at all"* —
and `updatePatient()` arrived in `9bf01c8` with the recompute in the same commit. **This is a trap
anticipated, not a bug that happened.**

It is written down because the next write path is where it bites, and several are coming: a patient
merge, a bulk import, an admin correction screen, and the AI tool layer's own `update_patient`. Each
is a fresh chance to see Arabic search working and conclude the pair is fine.
`patient-detail.integration.spec.ts` holds the rule for the one path that exists — proven by
breaking it, where removing the recompute fails exactly the three name tests and nothing else — and
a new write path should extend that block rather than trust the column.

#### The two GIN trigram indexes are not used by the search query — measured 2026-09-03

`prisma/sql/10-patient-bilingual-names.sql` creates `patients_name_search_ar_trgm_idx` and
`patients_name_search_latin_trgm_idx`, both `USING gin (… gin_trgm_ops)`. **Neither can be used by
`searchPatients()` as written, so "we have a trigram index" must not be read as a performance
guarantee.**

Two independent causes, each proven with `EXPLAIN` under `enable_seqscan = off` — which prices a
sequential scan at ten billion, so a planner that *could* use the index would:

| Query form | Plan |
|---|---|
| `word_similarity(q, coalesce(col,'')) >= 0.3` — what the code does | **Seq Scan**, even at cost 1e10 |
| `q <% col` — the operator form | **Bitmap Index Scan** on the trigram index |
| `q <% coalesce(col,'')` — operator, but column wrapped | **Seq Scan** |

**The operator is what determines whether the index is used**, and wrapping the column in
`coalesce()` defeats it independently. A function call is opaque to the index; only `%` (similarity)
and `<%` (word_similarity) have GIN trigram operator classes. Anyone adding a similarity query later
needs both facts, which is why they are recorded here rather than left in a commit message.

**No measured cost today** — 200 seeded patients, where the planner would choose a sequential scan
regardless — so this is a latent cost, not a bug to rush. But note the trap in the obvious fix:
**`<%` takes its threshold from `pg_trgm.word_similarity_threshold`, a session GUC defaulting to
0.6, not from a literal in the query.** Moving to the operator therefore moves the threshold into
session state, which on a pooled connection is the same class of hazard as `app.current_tenant_id`:
it would have to be set transaction-locally by `withTenant()`, and a connection that missed it would
silently search at 0.6 instead of D19's 0.3 — a stricter match, failing closed into exactly the
missed-patient duplicate this decision exists to prevent. That is a schema-level change and deserves
its own numbered ruling rather than a quiet refactor.

#### The 0.7 relative floor was tuned on 200 synthetic names — re-measure on real data

`RELATIVE_FLOOR = 0.7` in `patients.service.ts` suppresses any match scoring below 70% of the best
match for that query. It exists because `احمد` returned five محمد patients and no أحمد
(`word_similarity(احمد, محمد) = 0.400`, above the 0.3 threshold), and the value was chosen against a
measured separation: true matches at **1.000**, false ones at **0.400–0.600** in the Arabic branch
and **0.333** in the Latin one, with no overlap in either.

**That measurement was taken against `clinic_os_review`: 200 generated patients drawn from a fixed
list of Egyptian names.** It is not real clinic data, and the gap it relies on may be narrower in
practice — a real register carries misspellings, inconsistent transliterations, compound names and
near-duplicate rows that a generator does not produce, any of which could put a *genuine* match
below 70% of another genuine match.

**Re-measure against the pilot clinic's real patients before the register passes a few thousand
rows, and record the numbers here.** Written down because a threshold tuned on synthetic data is a
number nobody revisits unless a document tells them to — and the failure mode is silent, since a
suppressed true match looks exactly like a patient who was never registered, which is the thing this
decision records as creating duplicates.

What to measure, so the re-run is comparable: for a sample of real first names, the score
distribution of true matches against false ones **in both branches**, and whether any true match
falls below `0.7 × best`. If the distributions overlap, the answer is not a different floor — it is
that raw trigram similarity is the wrong tool for short names, and that needs its own ruling.

---

## D20 — Interface language and document language are different settings

**Decided 2026-08-24. Not yet implemented.**

Two settings that look like one and must not be merged:

**Interface language** — per-tenant default with a per-user override. The
override lives on the user row, not on `memberships`: a doctor holding
memberships in two clinics wants one language, not one per clinic. Store the
`locale` (`ar` / `en`) and derive text direction from it; never persist
direction as its own field, or the two drift and an Arabic interface renders
left-to-right.

Resolution order at load is URL, then a locally cached value, then the user
row, then the tenant default, then Arabic. The cache exists because direction
must be stamped onto the document before first paint, and a value from the
database arrives after login — too late. **The cached value is cleared on
logout**, because reception commonly shares one workstation and one browser
profile: without clearing, a doctor's English preference persists into the next
person's session.

**Document language** — the language of printed prescriptions and other
clinic-issued documents. This is a **tenant-level setting defaulting to
Arabic**, not a user preference: the prescription is the clinic's legal
document, and consistency across it matters more than whoever happens to print
it. Two doctors in one clinic must not issue differently-shaped legal
documents.

**Drug names are a separate axis and one setting must not govern both.**
Egyptian pharmacists read Latin brand names; the patient's name and the
medication list have genuinely different language requirements on the same
page. Whatever governs the patient name must not silently govern the
prescription items.

### Reconciling a cached locale with the user row — added 2026-08-26

**This was a gap, not a decision that was always here.** D20 as originally
written specified a resolution *order* — URL, cache, user row, tenant default,
Arabic — which says which value wins at load, and said nothing about what
happens when two of them disagree afterwards. The next person reading this
should know the difference: the order below the gap was designed; the rule in
this subsection was added when the frontend could not be built without it.

**The cached value is a bootstrap hint, not a preference store. The user row is
authoritative for the session.**

| Moment | What is available | What governs |
|---|---|---|
| First paint, login page | cache only — there is no user and no tenant yet | cache, else Arabic |
| Immediately after login | the user row has arrived | **the user row**, and the cache is overwritten with it |
| The user changes the setting | an explicit action | the user row is written, and the cache with it |

The cache exists for exactly one reason, stated above: direction must be
stamped before first paint and a database value arrives too late. That is a
rendering concern, not a statement of preference, and treating it as
authoritative past first paint is what creates a leak.

**Why the precedence has to flip after login.** The dangerous case is not a user
with two devices — it is the shared reception workstation, where the cache
survives *without* a logout: a browser crash, a closed tab, a session that
expired. Clearing the cache on logout handles the tidy path and looks like it
is working, while the untidy path quietly carries one person's language into
the next person's session. A partial guarantee that looks total, which is the
failure this document keeps recording.

**The accepted cost is one visible transition.** The login page paints from the
cache, the shell paints from the user row, and those are different screens with
a full navigation between them — so a disagreement shows up as "the next screen
is in Arabic", not as a mid-screen lurch. It happens only on a machine where
somebody did not log out, and it self-heals.

**Two alternatives, rejected — both will be proposed again:**

1. **Block first paint until the locale is known.** Trades a visible flip for a
   visible blank, and defeats the only reason the cache exists. The cache is
   there *because* nothing else can answer before paint.
2. **Key the cache by user id.** There is no user to key on at the login screen,
   which is precisely where the cache is the only available signal. Keying by
   the *last* user id makes the first paint after any user change wrong instead,
   which is the same flip with more machinery.

**The cached value is untrusted input.** It is `localStorage` — hand-editable,
corruptible, and older than any deploy. Anything that is not exactly `ar` or
`en` resolves to Arabic silently, at the boundary, the same discipline as the
CHECK constraint on `users.locale`. An unrecognised value must never reach the
direction stamp, or the document renders in an undefined direction.

**Open legal question — see `ARCHITECTURE.md` §"Parallel non-engineering
track".** Whether Egyptian regulation mandates Arabic on prescriptions is
unknown to us and is a question for the healthcare lawyer, not something to
resolve by picking the likelier answer. The design absorbs either result: if
Arabic turns out to be mandatory, that is a changed default and a removed
option, not a rebuilt document pipeline.

---

## Standing instruction

Continue stopping at ambiguities rather than assuming. Four of the nine questions above were real defects in the architecture document; guessing at them would have cost a migration against live patient data. Flagging beats guessing every time, even when it feels slow.

---

## D21 — Password reset: OTP to the user, notification to the clinic admin

**Designed 2026-08-27. NOT IMPLEMENTED. Nothing in this section exists in code.**
This is a proposal for the founder to accept, amend or reject. It is written up
rather than built because the security properties differ sharply depending on
answers that look like details, and picking one quietly would be the expensive
kind of mistake.

### The question that has to be settled first

**Is the clinic admin's email a second factor, or a notification?** The founder
asked for both an OTP to the user's phone and an email to the clinic admin.
Those are two different systems:

| | **Notification** (recommended) | **Second factor** |
|---|---|---|
| Reset completes when | the user enters the OTP | the user enters the OTP **and** the admin approves |
| Protects against | a stolen phone being used *unnoticed* | a stolen phone at all |
| Fails when | nothing — the reset works, the email is a record | the admin is asleep, on leave, or the mailbox is wrong |
| Receptionist locked out at 8am | back in within a minute | waits for the clinic owner to wake up |

**Recommendation: notification, not a second factor.** The threat it defends
against is an attacker holding the user's phone. Requiring admin approval does
stop that — but it converts every ordinary forgotten password into a two-person
workflow, in a clinic where the person who forgot is the receptionist and the
approver is a doctor currently seeing a patient. The predictable outcome is that
the admin approves without reading, which is a second factor in form and not in
substance, or that staff route around the system by sharing accounts. Shared
accounts destroy the audit trail D16 and D17 exist to produce, so a control that
encourages them is worse than the risk it removes.

The email is therefore a **detection** control rather than a preventive one: it
makes an illegitimate reset visible, quickly, to somebody who would notice —
which is what actually catches a stolen phone. It must say what happened, when,
from which IP, and how to revoke the session. Not merely "a password was reset".

**One exception worth accepting:** require approval for OWNER and ADMIN resets.
Those accounts can add users, change permissions and read the audit log; the
population is tiny; and the people who must approve are each other. The cost
falls on the two roles least likely to be locked out mid-clinic.

### The attack that matters is not the money

Read this before the cost table, because somebody reading only the money will
under-protect this endpoint.

An unlimited reset endpoint lets an attacker **spam a real person's phone until
they block the clinic's WhatsApp number.** That is worse than any bill. A
blocked number breaks appointment reminders for *every patient of that clinic*,
it is the clinic's own WABA so the block is against their brand, and the clinic
cannot easily undo it — the patient has to unblock, one patient at a time.

Making the clinic pay for messages is the second attack and the cheaper one to
recover from: an invoice can be credited. A destroyed messaging channel cannot.
The rate limits below exist for the first reason; the spend cap is a bonus.

### Delivery cost, and who pays

Checked 2026-08-27. Rates move — Meta updates its card quarterly.

| Channel | Cost per OTP | Notes |
|---|---|---|
| WhatsApp authentication template, Egypt | **$0.0130** | Meta's Egypt authentication rate, billed per delivered template message since July 2025 |
| SMS via an Egyptian A2P provider | **$0.009 – $0.012** (~EGP 0.10 – 0.13) | Direct routes to Vodafone/Orange/Etisalat/WE, NTRA-registered, volume discounts |

They are within a fraction of a cent of each other, so **cost does not decide
this** — which is itself the useful finding. What decides it:

- **WhatsApp is the clinic's own WABA.** ARCHITECTURE.md §11 has each clinic
  connect its own number through Embedded Signup, so a WhatsApp OTP is **billed
  to the clinic**, lands on their Meta invoice, and is a message from their own
  brand to their own staff.
- **SMS would be billed to us**, on our provider account, unless we build
  per-clinic SMS billing — a commercial subsystem nobody has asked for.
- WhatsApp needs an approved authentication template per language, and it fails
  for a staff member who does not use WhatsApp. Uncommon in Egypt, not zero.

**Recommendation: WhatsApp first, SMS as fallback, and we absorb the SMS.**
Fallback volume is a rounding error — only staff without WhatsApp, only when
they forget a password — and metering it per clinic would cost more to build
than the messages cost to send. Revisit if fallback exceeds a few percent.

**This is a cost the clinic did not previously carry.** At ~$0.013 a reset and a
handful of staff it is cents per year, but it belongs in the contract anyway: a
surprise line on a Meta invoice is a support conversation.

### Rate limiting — the part with real money attached

An unlimited reset endpoint is two attacks at once: **make a clinic pay for
messages**, and **spam a real person's phone until they block the clinic's
WhatsApp number**. The second is worse. A blocked number breaks appointment
reminders for every patient of that clinic, and the clinic cannot easily undo it.

Reuse the two-bucket design already built for login (`auth-throttle.ts`), plus a
third bucket login does not need:

| Bucket | Limit | Why |
|---|---|---|
| Per identifier | 3/hour, 5/day | Somebody who has forgotten a password does not need a fourth code within the hour |
| Per IP | 20/hour | Catches enumeration across many identifiers from one host |
| **Per tenant** | 20/day | **The spend cap.** Neither other bucket bounds what one clinic can be made to pay; this does, and it is what makes the billing risk finite |

Four details that matter more than the numbers:

- **Resend is a separate, slower limit** — one per 60 seconds — and it must
  re-send the *existing* code rather than mint a new one. Minting on resend
  turns an impatient user into a message generator.
- **Single-use code, 5-minute TTL, 5 verification attempts**, then dead. A
  long-lived code is a standing credential sitting in a chat history.
- **Identical response whether or not the identifier exists**, on the same
  reasoning as login — otherwise password reset becomes the account-enumeration
  oracle that login deliberately refuses to be. An unknown number therefore
  consumes rate-limit budget and sends nothing.
- **The reset endpoint MUST NOT ship on the in-memory throttler.** Not "should
  use Redis eventually" — must not ship. `@nestjs/throttler`'s default store is
  per-process, so a second API replica gives each process its own counters: the
  per-tenant cap of 20/day silently becomes 40/day at two replicas, 60 at three.
  Nothing errors and no log line appears. **A cap that looks total and is not is
  exactly the failure this project keeps finding**, and here it is attached to
  somebody else's phone number and somebody else's invoice.

  Redis is already a locked decision for BullMQ (Phase 6); this pulls it
  earlier, and DEPLOY.md §9 records the same limitation for login. Login can
  live with it because its limit protects a password, which does not get more
  guessable when the bucket doubles. A spend cap does.

### When the clinic admin's email is wrong, or that person has left

A recovery path depending on one mailbox has a single point of failure, and in a
small clinic that mailbox belongs to somebody who may have resigned.

1. **The address is a property of the tenant, not of a user.** Set by the
   platform admin at contract time, changeable only by the platform admin
   through an audited action. On a user row it would leave with that user.
2. **Bounce handling is not optional.** A hard bounce marks the address
   unverified and raises an operational alert on our side. Silently failing to
   notify is the failure that looks like everything working.
3. **A reset does not block on the notification.** If the email fails the reset
   still completes, and the failure is recorded on the audit row. Blocking would
   let a stale mailbox lock a clinic out of its own accounts, which is worse
   than a delayed notification.
4. **Two addresses, not one.** The contract should capture a second contact.
   Storing it costs nothing and removes the single point of failure.
5. **If both are dead, the path is the platform admin** — below — not a support
   inbox making a judgement call about who is entitled to a clinic's data.

### Platform-admin reset: break-glass, audited like one

Yes, the platform admin can reset for a clinic. There is no alternative: a
clinic whose only OWNER has lost their phone has no other route, and "lose your
patient records" is not one.

D17 already establishes the pattern — a privileged, audited function reachable
only through a named path, never through ordinary application code. Reuse it:

- **The platform admin issues a recovery link. They never set a password.**
  Not a policy — a capability the code must not have. The link is single-use and
  short-lived, goes to the tenant's registered address, and the user chooses
  their own password, which the platform admin never sees and never sets.

  This is what keeps **"our staff cannot read your records"** honestly true. It
  is a sentence the founder will have to say in sales conversations and in a
  PDPL conversation, and it stops being true the moment a platform admin can set
  a password and log in as a doctor. Any future convenience feature that would
  let them do so — "just reset it for them, they are on the phone right now" —
  is this decision being reversed, and must be argued as such.
- **A written reason is required**, stored on the audit row — the same
  discipline as `payment_adjustments.reason`, not free text nobody reads.
- **`AuditAction` already has `BREAK_GLASS_ACCESS`**, currently emitted by
  nothing. This is its first genuine use.
- **The clinic is told, on both addresses, at the time.** Not in a monthly
  report: a break-glass action the customer discovers later is indistinguishable
  from one they were never meant to see.
- **Rate-limited to the point of friction**, and surfaced on an internal
  dashboard. This path should be used a handful of times a year; more is either
  an attack or a product failure to fix instead.

### What this needs before anyone writes code

1. The founder's answer on **notification versus second factor** — recommendation
   above is notification, with approval required for OWNER/ADMIN only.
2. **Redis**, so the rate limiter is genuinely a spend cap. Already a locked
   decision for Phase 6; this pulls it earlier.
3. An **approved WhatsApp authentication template** per language. Review lead
   time, not an engineering task.
4. A **contract change** capturing two admin addresses and the reset-cost note.
5. **Phase placement.** Not Phase 1 — PHASE-1.md §2 puts MFA and public signup
   out of scope for the same reason. This belongs with the users management
   screen.

---

## D22 — `tenants` is scoped by neither layer, and an unfiltered read inside `withTenant()` looks correct

**Date:** 28 August 2026
**Status:** Decided and implemented — `prisma/sql/14-tenants-rls.sql`, `tenants-rls.integration.spec.ts`.

D15 extended RLS to every tenant-scoped table and deliberately excluded three, `tenants` among them, with this reasoning:

> Tenant, User, and RefreshToken are NOT included here. They are genuinely cross-tenant by design (Tenant IS a tenant …)

That is a correct explanation of why the **scoping extension** cannot filter this table: there is no `tenant_id` column to filter on, which is exactly why `tenant-scoped-models.ts` classifies `Tenant` as `"none"`. But it silently also answered a question nobody had asked — *may a session bound to tenant A read tenant B's row?* — and the answer it implied was wrong.

### The dangerous part is not the missing policy

It is that **an unfiltered read inside `withTenant()` looked correct.**

`withTenant()` is the one construct in this codebase that is supposed to make scoping automatic, and for every other table it does: reach for `tx.patient.findMany()` with no `where` and you get your own clinic's patients, because the extension injects the filter and RLS enforces it underneath. Reach for `tx.tenant.findMany()` in exactly the same place, in exactly the same style, and you got **173 rows** — every clinic in the test database. Nothing in the type, the wrapper, or any comment distinguished the two calls.

The near-miss was concrete. `appointments.service.ts` reads `slot_granularity_minutes`, both booking lead times and `no_show_grace_minutes` from this row. A `findMany` followed by `[0]` — the obvious way to write it — would have applied a stranger's scheduling policy to a clinic. It would have produced numbers that still look like numbers: no assertion about slot counts, no cross-tenant 404 test, and no isolation test would have caught it. It surfaced only because the code asserted the row count instead of trusting it, and threw.

### Decision: yes, `tenants` gets a policy — an inverted one

```sql
CREATE POLICY tenant_self_isolation ON tenants
  USING (
    NULLIF(current_setting('app.current_tenant_id', true), '') IS NULL
    OR id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  )
  WITH CHECK ( … same … );
```

**This is inverted relative to every other policy in the schema and that must not be "tidied up" later.** All the others fail *closed* when the session variable is unset — `tenant_id = NULL` is never true, so an unbound session sees nothing. Correct for those tables, because no legitimate operation on them is unbound. This one permits an unbound session and constrains a bound one.

Three operations are structurally unbound, not sloppily so:

1. **Creating a tenant.** There is no tenant to bind before the row exists. No session variable can solve that ordering — the same shape of problem D15 hit with membership lookup.
2. **`prisma/backfill/name-search-latin.ts`**, which walks every tenant by design.
3. **The seed** — `index.ts` lists existing clinics to decide whether to re-run, `seed-staff.ts` creates them.

### The login path was the suspected blocker and is not one

Worth recording because it is the first thing anyone will ask. `list_active_memberships_for_user()` and `resolve_active_membership()` both `JOIN tenants`, and both are `SECURITY DEFINER` owned by the migration superuser (`04-membership-lookup-functions.sql`). They execute with the owner's privileges and bypass RLS on every table they touch, this one included. Adding this policy does not narrow them, and login, `/auth/me` and tenant switching are unaffected.

The alternative — fail closed, plus a fourth `SECURITY DEFINER` function for tenant creation — was considered and rejected as more machinery than the exposure justifies. This row holds clinic directory data (name, phone, address, timezone, scheduling policy), not clinical or financial records.

### What is still true after this

An unbound code path can still read every tenant. That weakness is stated rather than hidden, and it is bounded: **every request-serving path in this application runs inside `withTenant()`**, so for anything reachable by an authenticated request the variable is always bound. What is closed is the case that actually occurred.

Proven by disabling the policy and watching 3 of the 5 assertions fail, then re-enabling.

---

## D23 — Prisma does not surface `23P01` where the obvious check looks for it

**Date:** 28 August 2026
**Status:** Recorded. Implemented in `appointments.service.ts`.

`no_double_booking` is the arbiter of every booking (§9), so the application must recognise its violation and turn it into an ordinary "that slot was taken" answer rather than a 500. The obvious way to write that check does not work, and fails in a way nothing routine would reveal.

**Prisma 7 with the `pg` adapter raises a `PrismaClientKnownRequestError` whose own `code` is `P2039`.** The Postgres SQLSTATE is nested two levels down:

```
{ code: "P2039",
  meta: {
    modelName: "Appointment",
    driverAdapterError: {
      cause: {
        code: "23P01",
        originalCode: "23P01",
        message: 'conflicting key value violates exclusion constraint "no_double_booking"'
      } } } }
```

So the path is **`error.meta.driverAdapterError.cause.code`**. Anyone writing `error.code === '23P01'` — which is what the documentation and every search result suggest — writes a branch that never fires.

### Why this is worse than an ordinary bug

The branch is only reachable when two bookings genuinely race. Nothing in a normal test suite reaches it; nothing in manual testing reaches it. A wrong check therefore passes CI, passes review, and passes a founder clicking through the app — and then, in a real clinic with two receptionists, every loser of a race becomes an unhandled 500 that says the system is broken when the world merely moved on.

It was caught here only because ARCHITECTURE.md §20 makes "double-booking verified under concurrency" a phase gate. Without that test the first version of this check would have shipped.

### Match the constraint name too, not just the SQLSTATE

`23P01` means "*some* exclusion constraint refused this row". Today `appointments` has one, but a later one — a treatment room, a device — would raise the same code, and reporting that to a patient as "that time was just taken" would be a confident lie. The check requires both the code and `no_double_booking` in the message; anything else is rethrown.

### The general rule

**Do not guess a driver's error shape from documentation — provoke the error and read it.** The shape above was obtained by deliberately inserting two conflicting rows and printing the caught object. That took two minutes and replaced an assumption that had already been written into code twice.

---

## D24 — Patient transfers: expiry is computed, and the request has a fourth terminal state

Ruled by the founder on 2026-09-01. This is the first deliberate exception to the doctor-only
clinical rule in `CLAUDE.md`, which is why it is a numbered decision rather than a service detail.

**Not D22.** D22 is `tenants` is scoped by neither layer. Transfers were cited as D22 three times in
conversation and are recorded here, at the next free number, so the next reader looking for the
transfer rationale finds it where the numbering says it should be.

### Expiry is computed at read time. There is no stored state that says "expired"

A grant is active when its request is `ACCEPTED` **and** `now < decided_at + window`. That
comparison happens on every read. Nothing writes an `EXPIRED` status, and no job exists to write
one.

**The founder's reasoning, and it is the whole decision:** *"a column updated by a job that doesn't
exist yet would have meant access never expiring, and nothing would have told us. Computing it at
read time means the guarantee holds from day one."*

That is this project's recurring failure shape stated exactly. A `status` column flipped by a
nightly sweep looks like expiry, tests green against it, and grants access forever if the sweep is
never written, is misconfigured, or silently dies — and the symptom is *absence*, so nothing reports
it. A comparison cannot fail to run, because the read cannot happen without it.

**Someone will later propose a nightly job to "clean up expired grants" as an optimisation. This
paragraph is for them.** The job is not an optimisation; it is a reintroduction of the failure mode
this decision exists to remove. If a materialised `expired` flag is ever genuinely needed for a
query plan, it may be added **only** as a derived column that no code path trusts for
authorisation — the read-time comparison stays the authority, and the flag is a hint. Deleting or
archiving lapsed rows is separately forbidden: medical records are never hard-deleted, and a revoked
or lapsed grant is part of who-saw-what.

**Consequence, stated rather than discovered.** Because the deadline is derived from `decided_at`
plus a window constant rather than frozen per grant, **changing the window retroactively re-dates
every existing grant** — lengthening it would silently resurrect grants that had already lapsed.
Recommended before the constant is ever changed: freeze the deadline per grant at acceptance and
keep comparing it at read time, which preserves the no-job property while making old grants
immutable. Not done now because the founder ruled computed, and a window that has never changed
cannot yet have caused the problem.

### The request state machine has four terminal states, and the fourth is deliberate

`PENDING` → `ACCEPTED` | `REJECTED` | `LAPSED`.

`LAPSED` is the founder's *"case nobody thinks about"*: the appointment is cancelled or completed
while a request is still open. **The patient left, and there is still a request waiting for an
answer.** It is recorded here so that a later reader can tell it was designed rather than fallen
into — an unhandled fourth case and a deliberately handled one look identical in a state diagram,
and only one of them is safe to refactor.

Two rules follow from it, and both come from the founder's requirement that *"a rejection that
silently reverts is how a patient gets forgotten in a waiting room"*:

- **`LAPSED` notifies reception, exactly as `REJECTED` does.** A request that closes itself quietly
  is worse than one that stays open, because the open one is visible.
- **`LAPSED` is terminal and is never re-opened.** A new occasion is a new request. Re-opening would
  make the audit trail say a decision was pending during a period when nobody could have answered
  it.

### The invariant the whole design serves

The founder's wording, and the reason the pending appointment stays with the original doctor
(`PHASE-3.md` Q16): **a patient physically present must appear in exactly one queue at all times.**
Not zero — a patient nobody is expecting is a patient nobody calls. Not two — two queues showing the
same person is two receptionists each assuming the other has them. A transfer therefore changes who
is answerable for future care, and changes nothing about a row already on a screen.

---

## D25 — Bookings take an advisory lock per doctor-day, so the exclusion constraint cannot deadlock

Ruled by the founder on 2026-09-06: *"Prevent the deadlock, don't only survive it."*

**Not D24.** D24 is patient transfers. This was asked for as D24 in conversation and is recorded
here, at the next free number, so that neither decision has to be renumbered and the next reader
finds each where the numbering says it should be — the same correction D24 itself carries about D22.

### The measurements

Every number below was produced by `booking-deadlock.integration.spec.ts`, whose crossed-insert
apparatus is identical in both columns except for the lock.

| | Deadlock spec, 10 runs | Concurrency spec, 10 runs | Slowest whole-suite time |
|---|---|---|---|
| Without the lock | **0 passed, 10 failed**, every failure a real `40P01` | needed a 30 s budget; 1 of 3 full runs timed out | — |
| With the lock | **10 passed, 0 failed** | **10 passed** at jest's 5 s default | **3.2 s** for three tests plus fixture setup |

`deadlock_timeout` on this cluster is **`1s`**, read with `show deadlock_timeout`. That is what the
lock buys back: Postgres does not begin looking for a cycle until a transaction has been blocked
that long, so each avoided deadlock is about a second that nobody waits.

The eight-way concurrency test has been returned to the default timeout. The 30-second budget it
briefly carried was compensating for detection time, and there is no detection time left to
compensate for.

### The decision

`pg_advisory_xact_lock`, keyed on `(tenantId, doctorId, day)` hashed with `hashtextextended`, taken
inside the booking transaction **before** the write the constraint arbitrates. Both writers take it:
`bookAppointment` and `rescheduleAppointment`.

- **`tenantId` is part of the key and is not optional.** Advisory locks live in a cluster-wide space
  that Row-Level Security does not reach — the one place in this API where tenant isolation is not
  free. Without it, two clinics sharing a doctor id would block each other.
- **The day, not the slot.** Contention arrives as "this morning with Dr Hisham", and two
  receptionists on *adjacent* slots deadlock exactly as readily as two on the same one. A
  slot-keyed lock would have left that case untouched. The cost of the coarser key is that
  bookings for one doctor on one day serialise, and the work inside the lock is a few millisecond
  inserts.
- **`_xact_`**, so commit or rollback releases it. No unlock to forget, no leak on an early return.
- **A hash has collisions**, so two unrelated doctor-days can occasionally queue behind each other.
  That is a performance footnote and never a correctness one: the exclusion constraint remains the
  arbiter of what may be booked, and this only decides who waits.

### `retryOnDeadlock` stays

Ruled explicitly. The lock closes the collision this project has actually observed; it is not a
proof that no transaction anywhere can ever deadlock with a booking, and the retry costs nothing
when nothing deadlocks. Belt and braces, where the braces were measured and the belt is cheap.

### Where `deadlock_timeout` could be changed — reported, not changed

Ruled on 2026-09-06: *"Do NOT change deadlock_timeout. Just report."* So this is a record of what
was measured, and the decision remains open.

**The cluster is self-hosted.** The official `postgres:16` Docker image (running 16.15, Debian
build), started by `docker compose` from `docker-compose.yml` locally and `docker-compose.server.yml`
on the server, with a `postgres_data` volume. There is no managed provider anywhere in the stack.
Neither compose file passes a `command:` or mounts a `postgresql.conf`, so **every setting is the
image default** — which is why `deadlock_timeout` reads `1s` with `source = default`. Nobody has
ever set it.

**It cannot be changed from application code**, and this was tested rather than assumed:
`deadlock_timeout` has `context = superuser`, the application connects as `clinic_os_app`, and
`SET deadlock_timeout` on that connection fails with `42501 permission denied to set parameter`.
A `SET LOCAL` inside `withTenant()` is therefore not an option. (`lock_timeout` is different — it is
`user` context, currently `0`, and the app role *can* set it.)

The four places it could be set, in increasing blast radius:

| Where | How | Reaches |
|---|---|---|
| Role | `ALTER ROLE clinic_os_app SET deadlock_timeout = '…'` | The application only, on new connections. Narrowest option that changes anything. |
| Database | `ALTER DATABASE clinic_os SET deadlock_timeout = '…'` | Everything on that database, including migrations and `psql` sessions |
| Cluster, at start | `command: ["postgres", "-c", "deadlock_timeout=…"]` on the `postgres` service | Every database in the cluster, `clinic_os_test` included |
| Cluster, by file | mount a `postgresql.conf` into the container | The same, with more to keep in step |

**Corrected 2026-09-06.** The first version of this paragraph said lowering it "costs CPU on every
lock acquisition rather than only on contended ones". That is wrong, and the founder caught it.
Postgres does not run the deadlock detector on acquisition at all: a lock request that is granted
immediately costs nothing extra, and the check runs **only when a wait has already exceeded
`deadlock_timeout`**. Lowering the setting therefore makes the check run sooner and more often
*among waits that are already blocked* — the cost falls on contention, not on ordinary traffic.

That makes lowering it cheaper than the original sentence implied, and the decision is still the
founder's. D25 removes the collision rather than tuning the detector because a lock that is never
contended costs nothing at all, which is a smaller number than any timeout.

### The invariant this rests on

**One transaction takes at most one doctor-day lock.** A lock queue cannot form a cycle while that
holds, and that is the whole reason this works. Two transactions each taking two of these locks in
opposite orders would deadlock on the locks themselves — the same shape as before, moved one level
down and *harder* to diagnose, because a lock wait carries no constraint name to recognise it by.

Both callers satisfy it: a booking locks the day it books into, a reschedule locks the day it moves
*to*. The day it moves *from* needs no lock, because removing an old index entry conflicts with
nothing — an exclusion constraint only checks the value being written.

**The rule, stated so it survives the first operation that needs two: if a transaction ever needs
more than one doctor-day lock, it acquires them in sorted key order.** Not "in a sensible order",
and not "in the order the days appear in the request" — sorted, on the same key the lock is derived
from, every time. A bulk move or a doctor's day shifted wholesale is where this arrives.

The reason it has to be written as a rule rather than left to whoever meets it: a consistent global
ordering is what makes a cycle impossible, and *any* two transactions disagreeing about the order is
enough to reintroduce one. Two callers each choosing their own reasonable order is the failure, and
neither of them looks wrong in review.

---

## D26 — Date of birth and gender are required at intake, reversing the 21 August ruling

**Ruled 2026-09-07.** They were made nullable on 21 August 2026 with the reason recorded in
`schema.prisma`: *"a walk-in registration will not have a date of birth, and a required field here
means staff invent one."*

That prediction was wrong in a specific way, and the pilot showed how. **Reception was not inventing
values — reception was skipping the fields.** An optional field on a busy desk is an empty field,
and the result is a patient record that cannot answer the questions it exists to answer: no age for
a paediatric dose, no gender for a reference range, and no way to tell one رانيا السيد from another.
Inventing a date would at least have been visible as a suspicious birthday; skipping is invisible.

So date of birth and gender are **required at intake**, along with full name (Arabic), phone, and
nationality.

**The columns stay nullable.** Requiring them in the schema would mean backfilling every patient
already recorded without them, and the only values available are guesses — which is the falsification
this project already refused for `appointments.quoted_price_minor`. `NULL` means "nobody recorded
this", which is the truth about those rows.

The gap between "required at intake" and "nullable in the column" is carried by a **derived
incomplete flag**, not a stored one: a patient missing any required field is shown with a
*"ملف ناقص"* badge, which clears when the record is completed. Derived on read, so it cannot go
stale and no job maintains it.

---

## D27 — The Egyptian national ID is parsed, never trusted, and is unique per tenant when present

**Ruled 2026-09-07.** A 14-digit Egyptian NID encodes century, birth date and governorate, so
entering one can fill date of birth, gender and governorate.

**It auto-fills; it does not overwrite silently.** Staff may correct any filled field, and a
correction that disagrees with the ID shows a warning rather than being rejected. The ID is evidence,
not authority: a mistyped digit that changes a birth year must not be able to overwrite a date
somebody read off a passport.

**Optional, and Egyptian-only.** A patient with no ID to hand is registered without one, and for a
non-Egyptian patient the field is not shown at all — a passport number takes its place, which is what
that patient actually carries.

**Unique per tenant when present, enforced by a partial unique index** rather than by a service
check, because two receptionists registering the same walk-in seconds apart is exactly the race a
service-layer check loses. `NULL` is not constrained, which is why the index is partial.

---

## D28 — A household phone is a contact, and a child may have neither phone nor ID

**Ruled 2026-09-07, extending D24's household reasoning to intake.**

`contacts` already carries `UNIQUE (tenant_id, phone_e164)` and is the household. So a phone typed at
intake may already belong to one. When it does, intake offers two honest choices — **add a new member
to this household**, with a relationship, or **open the patient who already holds it** — and never
silently creates a second patient on the same number.

**A child has no phone and no national ID of their own.** The household phone is the parent's, and
that is not a data-quality problem to be worked around: it is how families arrive at a clinic. The
phone is required on the *contact*, not on each patient individually.

---

## D29 — `visit_procedures`, and the price that is written down rather than looked up

**Ruled 2026-09-08 by Q25, which is the ruling `PHASE-4.md` §5 anticipated when it said "no new
table. If one appears, a ruling went the other way."**

`PHASE-5-DESIGN.md` builds the invoice at COMPLETE from recorded procedures and there was nowhere to
record one. So: one row per line, with `quantity` and `unit_price_minor` snapshotted at insert.

**`unit_price_minor` is nullable and means "no price was recorded", never zero** — the same reading
`appointments.quoted_price_minor` carries. Reception's own consultation line is priced from that
column, not from `services.price_minor`, so a re-priced catalogue cannot re-quote a conversation that
already happened. A partial unique index allows exactly one RECEPTION line per visit.

**Rejected: deriving reception's line on read from the appointment.** It avoids a duplicate row and
gives the Phase 5 invoice two sources for one list, which is the shape that drifts. Rejected also:
`NOT NULL DEFAULT 0`, which makes "not recorded" indistinguishable from "free".

**A line is removable only while the visit is a draft.** That is not an exception to "medical and
financial records are never hard-deleted": nothing is recorded until the visit completes, so removing
a mistyped line is the same act as deleting a mistyped sentence.

## D30 — A follow-up books the first free slot on the day asked for, or reports that there was none

**Ruled 2026-09-08 with Q24, which says the follow-up "creates the next appointment on completion".**

The day comes from an explicit date or from an interval counted in the clinic's own zone. The slot
comes from the same engine every other booking path uses, so there is no second notion of what is
free, and the exclusion constraint stays the arbiter.

**When the day has no free slot the visit still completes and the response says the follow-up was not
booked.** A doctor mid-consultation cannot be made to negotiate a diary, and a silent failure here
would be a follow-up nobody knows is missing.

**Rejected: searching forward until something is free.** It needs an arbitrary window, and it books a
date the doctor did not choose. Rejected also: refusing the completion, which would hold a finished
consultation hostage to a full diary.

---

## D31 — The clinical profile is append-only entries, and the old row was copied, not dropped

**Ruled 2026-09-08 by Q22**, replacing the single mutable `patient_clinical_profiles` row PR 7b built
the day before. Any doctor may add an entry; nobody edits or deletes one, enforced by a
BEFORE UPDATE OR DELETE trigger (D5) rather than by the service — a service check passes on a
database that never got the trigger.

**Every existing row was copied first.** Each non-empty `family_history` and `risk_factors` became
the first entry for its field, authored by its `updated_by_user_id` at its `updated_at`, and only
then was the table dropped. The migration's own INSERT statements are read out of the file and run
against a fixture row by `visit-orders.integration.spec.ts`, because a migration nobody exercised is
a guess.

**Height is not an entry.** Q22 lists it among the standing facts; it is already measured every visit
in `visits.vitals`, so the profile reads the most recent one instead of storing a second copy. Two
places to record one number is how a stale value gets trusted — the reason allergies were never
duplicated here either.

**Rejected: keeping the mutable row and adding a history table beside it.** Two sources for one fact,
and the mutable one is the one a screen would read. Rejected also: soft-deleting entries, which is an
edit wearing a different word.

## D32 — A finished appointment answers the wrong question about presence

**Ruled 2026-09-08 while building Q6's amendment path.** `resolveAccess` answers presence from the
appointment being viewed, which is correct while that appointment is the thing in front of the
caller. For a **finished** visit — an amendment, its procedures, its orders — that appointment is
`COMPLETED` by definition, so the same phrasing silently asks about a record instead of about a
patient.

Those paths therefore ask `isPresentWithDoctor(patientId, doctorId)`: does this doctor have this
patient with them **now**, on any appointment. That is the helper's stated purpose, and it adds no
door — Q18's rule is unchanged, current care or an active grant, never authorship.

**The consequence, flagged rather than absorbed:** completion ends the appointment, so in the minutes
right after finishing a visit its author cannot reach the amendment path at all. Q6 already names the
possible fix — *"a short grace window after COMPLETE during which edits are still edits"* — and calls
itself the ruling most wanting a sanity check. It is the founder's call, not mine.

---

## D33 — Branding images are storage keys, and their key shape is its own allow-list

**Ruled 2026-09-09 with Q28**, which pulls clinic identity and the doctor's print fields forward from
Phase 5 because printing needs them.

**Columns hold storage keys, never URLs.** `StorageProvider` has no `url()` by design (Q11), and a
column named `_url` invites a caller to hand a doctor's signature to a browser, which makes the
capability gate decoration. `doctors.signature_url` — present since Phase 1 and never written — was
renamed rather than left beside its replacement.

**A second key shape, and a second validator.** `isSafeBrandingKey` is separate from
`isSafeStorageKey` rather than a widening of it: they guard different reads, and the day a third
shape arrives, one loose validator would be deciding for all of them. The provider's path check
accepts either, which is the last-resort check underneath both. The extension set is `ACCEPTED` minus
`pdf`, derived rather than spelled again — a letterhead logo is an image, and a lab report is not a
logo.

**Rejected: reusing the attachment key shape with the tenant id in the patient slot.** It reads as a
patient record that is not one, and it would put branding under a validator whose job is patient
attachments. Rejected also: deleting the previous image on replace, which `StorageProvider` cannot do
and should not learn to — a fresh key per upload means replacing a logo cannot destroy the one a
printed sheet was made with.

**Clinic phone numbers are normalised when they parse and kept as typed when they do not.** Landlines
parse; the five-digit hotlines and extensions a letterhead also carries do not, and refusing those
would make one of the numbers a clinic actually prints the one number that cannot be stored. The same
fallback `auth.controller.ts` already makes at the login boundary.

---

## D34 — The print stylesheet hides the application by allow-list

**Ruled 2026-09-09 with Q9 and Q29.** One rule — `body > *:not(#print-root) { display: none }` —
hides everything the application renders and shows only the sheet, so a panel added to the visit
screen later is hidden by default.

**Rejected: a list of selectors to hide.** It is a deny-list that has to be updated every time a
panel is added, and what escapes when somebody forgets is a patient's diagnosis printed on a
prescription handed across a counter. Rejected also: rendering the sheets into a separate window,
which loses the application's fonts and RTL setup and adds a popup blocker to the failure modes.

**The sheets are kept off-screen rather than `display: none`.** An undisplayed subtree is not laid
out, and the print dialog opens before the browser measures it — which shows up as the first print
of a session coming out unstyled.

---

## D35 — Q6's amendment grace window: twenty-four hours, the completing doctor only

**Ruled by the founder on 2026-09-09**, closing the uncertainty Q6 flagged about itself when it was
written and which D32 raised again on delivery.

Completion ends the appointment, so under Q18's rule the doctor who has just finished writing a visit
loses access to it — and "I forgot a sentence" is exactly the minute after. For **24 hours from
`completed_at`**, the doctor who completed the visit may amend it without the patient being present.

**It relaxes presence and nothing else.** A reason is still required, a `visit_revisions` row is still
written, and the original is still preserved. **A second doctor is refused inside the window exactly
as outside it**, which is the guard the ruling came with: the thing being avoided is permanent access
accumulated on the strength of having once written a note, and that is Q18's whole point.

The window is a pure function taking `now` as a parameter, so its boundary is testable without moving
the clock. It also applies to *reading* a finished visit's orders and procedures, which is what lets a
prescription be printed in the minute after the visit ends — the same situation, and splitting it
would have left printing broken for the doctor who just prescribed.

**Rejected: an authored-by-me exception with no expiry.** That is the design the founder rejected on
2026-09-05, and a window is the difference — access that ends on its own, rather than a fact about the
past that never expires. Rejected also: relaxing it for any doctor in the clinic, which would make the
window a second door into Level 2 rather than a delay on closing the first.

---

## D36 — PAUSED is a status on the state machine, not a flag beside it

**Ruled by the founder on 2026-09-09 as Q34.** A patient who steps out for imaging is neither waiting
nor finished, and before this the board had no way to say so.

It is an `AppointmentStatus` with its own edges — `PAUSE` from IN_CONSULTATION, `RESUME` back to it —
rather than a boolean column. The state machine already owns "which moves are legal from here", every
screen already asks it, and a flag beside the status would have been a second thing deciding the same
question. `COMPLETE` is legal from PAUSED as well: the patient came back, the doctor read the film and
finished, and requiring RESUME first would be a click that records nothing.

**PAUSED counts as present for that doctor** (`clinical.access.ts`), which is what stops the record
closing underneath its author mid-consultation. It does **not** widen presence for anyone else, and a
test asserts a colleague is still refused — a status that relaxes an access rule is exactly the shape
that relaxes it too far.

**The reason is optional and lands on `appointment_events`, never on the queue row.** Q14's line is
authorship: a pause reason is written by a clinician, so it is content, and reception sees the status
alone. The colour is blue rather than a grey or a green — `status-colour-separation.spec.ts` measured
the first attempt at deltaE 0.0 against IN_CONSULTATION and refused it.

**Rejected: a boolean `is_paused` column.** Two sources for one question, and the state machine would
not know about it. Rejected also: leaving the patient IN_CONSULTATION and showing a note, which is
what reception already cannot see.

## D37 — One autosaver per draft, outside React

**Ruled by the founder on 2026-09-09 as Q35**, and the shape follows from the guard he attached to it:
two drafts open, one save failing, the other still reporting saved.

The screen used to own the debounce timer and the save state, so unmounting it — which is what
switching tabs does — cleared the timer and the queued text went nowhere. `draft-autosave.ts` keys a
saver by visit id in module state: two drafts have two timers, two pending patches and two states.
Q17 had already said this about the local copy — per draft, never a single slot — and this is the same
rule applied to the thing that actually sends.

**A shared indicator could not have failed this test**, because with one state there was no wrong
answer to give. Making the wrong answer expressible is what made the guard possible.

**Rejected: flushing the other draft on a tab switch.** It turns navigation into a write, and a save
that fails then does so while the doctor is looking at a different patient. Rejected also: React
context, which dies with the tree it is mounted in and would have kept the original bug.

---

## D38 — `doctorProfile.manage`, because "admin and the doctor themselves" had no capability

**Added 2026-09-09 with Q36.** The founder ruled that a doctor's print fields are editable by an admin
*and by the doctor themselves*, and no existing capability expresses that shape: `users.manage` is
NONE for DOCTOR, so a doctor is refused at the guard before any own-scoping could run, and
`doctorSchedules.manage` has exactly the right shape under a name about something else.

`doctorProfile.manage` is `full` for OWNER and ADMIN and `own` for DOCTOR. `own` is enforced the way
`doctorSchedules.manage` already is: **the scope is applied to the lookup**, so a colleague's row is
"no such thing" rather than a refused authorisation, and a 404 cannot be read as confirming the row
exists. It is registered in `own-capability-enforcement.ts` as enforced, with the spec that proves it.

**The upload routes moved onto it too.** Leaving them on `users.manage` would have made the fields
editable by their owner while the signature filed onto their record was not — and the signature is the
half that matters.

**Rejected: reusing `doctorSchedules.manage`.** Right shape, wrong name; a capability whose name
describes one thing and gates another is how `appointments.write` came to decide the queue read.
Rejected also: relaxing `users.manage` to `own` for DOCTOR, which would have handed a doctor every
other route that capability guards, including creating and deactivating staff.

**"Remove" clears a pointer and never a file.** `StorageProvider` has no `delete()` (Q11), and this
does not reach around it: `logo_storage_key` becomes NULL and the object stays. A sheet printed last
week was made with that file, and destroying it to clear a logo would be the one irreversible action
on the screen. The screen says so in as many words rather than leaving "remove" to be read the usual way.

---

## D39 — The letterhead's remaining fields are nullable free text, and working hours are not a schedule

**Ruled 2026-09-09 as Q37.** Six columns on `tenants`: tax registration number, commercial register
number, email, WhatsApp number, printed working hours, tagline. All nullable, all free text, and the
sheet **prints what is filled and omits what is not** — a letterhead carrying "السجل التجاري: —" is
worse than one without the line, and a clinic that has no commercial register must still be printable.

**Working hours are deliberately text.** `schedule_templates` already holds when each doctor works,
per weekday, with breaks and validity windows. What a letterhead carries is a phrase covering the
clinic as a whole, and deriving one from the other would be a second calendar that disagrees with the
first the day one doctor changes a shift.

**Rejected: reusing `schedule_templates` to compose the line.** It reads as the tidy answer and it is
the one that goes wrong silently. Rejected also: `NOT NULL DEFAULT ''`, which makes "not recorded"
indistinguishable from "recorded as empty" for six fields at once.

## D40 — A doctor's printed identity lives on the doctor, not on a screen of its own

**Ruled 2026-09-09 as Q38**, withdrawing the separate «بيانات الطبيب المطبوعة» page added the same
day by Q36.

The fields are properties of a doctor and now sit in the doctor's form on the Doctors screen, beside
the licence number and the room. A doctor edits their own from the **account menu** — a person's own
record is not a section of the clinic, so it does not belong in a sidebar listing Services, Doctors
and Settings.

`doctorProfile.manage` is unchanged and still `own` for DOCTOR: what moved is where the fields are
reached, not who may write them.

**Rejected: keeping both.** Two screens editing one record is two places to look and two to keep in
step. Rejected also: putting the doctor's own edit in the sidebar behind an `own` capability, which
is what Q36 did and is the thing this reverses.

---

## D41 — The consultation moves belong to the appointment's own doctor

**Ruled 2026-09-09 as Q40**, extending to `START_CONSULTATION` and `COMPLETE` the rule Q34 had
already applied to pause and resume.

Two layers, and they answer different questions. `visits.write` is DOCTOR-only, so the
`PermissionGuard` refuses reception before any handler runs. `moveOwn` then compares the caller's
doctor row with the appointment's, so a colleague is refused too. Reception keeps check-in, transfer
and no-show — the desk facts: who is here, who has gone, who is being handed on.

**Rejected: leaving start on `appointments.queueActions`.** It reads as a desk action because the
desk used to press it, but which patient a doctor starts seeing is a clinical sequencing decision and
the doctor is the only person who knows when they are ready.

**A consequence worth recording:** the queue spec's doctor token had been issued against a membership
id that did not exist, which was invisible while these moves needed only a role. Once they resolved a
doctor row from the membership, that token stopped being a doctor at all. Fixed to the fixture's real
membership; a token whose membership does not exist is not a doctor, and tests should not pretend
otherwise.

## D42 — Reception edits the patient record, and the boundary is asserted from outside

**Ruled 2026-09-09 as Q42.** Patient detail is editable where `patients.write` allows — personal,
contact, insurance and family — and the «ملف ناقص» badge clears by itself because it is derived from
what is stored (D26).

The clinical boundary already holds structurally: `patients` carries no clinical column, and
diagnosis, examination, the profile and the allergy list live in their own tables behind
`visits.readContent`. **That is a good design and a poor guard on its own**, because it is true only
until someone adds a column. So the guard asserts it from the outside: a receptionist naming a
clinical field on the patient PATCH is **refused by the whitelist**, not quietly ignored — and the
quiet ignore is the dangerous half, since the request succeeds, nothing lands, and nobody is told.

---

## D43 — The print sheet is portalled to `body`, because the stylesheet's allow-list says so

**Found 2026-09-09 by the founder: printing produced blank pages.** Every element the layout guard
checked was present in the DOM, and the paper was empty.

`print-styles.ts` hides the application with `body > *:not(#print-root)`. `index.html` mounts React
into `<div id="root">`, so the sheet was a **descendant** of `#root` rather than a child of `body`:
the rule hid `#root`, and the sheet inside it. `display: none` on an ancestor removes the whole
subtree, and no `!important` on a descendant can bring it back — which is why the existing guard,
which asserted the markup and the selectors separately, stayed green.

The fix is a **portal to `document.body`**, and the host element *is* `#print-root` — a wrapper
around it would put the sheet one level too deep and reproduce the bug exactly one generation down.
That happened while writing the fix and the new structural guard caught it.

**Rejected: widening the selector to name `#root` as well.** It makes the stylesheet depend on the
shape of the host page, so the next person to wrap the app in a provider div breaks printing again
with nothing failing. Making the markup match the selector puts the invariant in one place.

**The guard asserts the two halves agree** — the stylesheet says "direct child of body", and
`#print-root`'s parent is `document.body` — and that exactly one print root exists, since two would
both satisfy the allow-list and print everything twice.

---

## D44 — An open consultation is not a lasting fact, so the tab bar asks about today

**Ruled 2026-09-09 as Q44**, after the founder found a doctor with three tabs.

`listOpenVisits` had no date filter. The cause was reproduced before it was fixed, and it was both
halves of the question: the query was wrong, **and** the data held several — the review database had
three `IN_CONSULTATION` rows for one doctor spanning fifteen days.

The data half is not a seeding artefact. **An `IN_CONSULTATION` row that nobody completes stays open
forever**, so a consultation interrupted last Tuesday is still open on Friday, and any real clinic
accumulates them. A tab bar without a date grows for the life of the practice.

The day is the clinic's own, from `clinicDayBounds` — the same function the queue uses, because
PHASE-3.md Q12 rules that "which day is this appointment on" has one implementation, and a clinic
running past midnight has patients whose day is yesterday's date.

---

## D45 — The printed sheet does not go through the translator

**Ruled 2026-09-09 as Q45.** Printed documents are English whatever the interface language is.

The implementation follows from where the bug would otherwise hide. The sheets could have kept
calling `t()` with English strings added to the catalogue — but the catalogue answers in the
*reader's* language, so a sheet built that way follows the screen, and in an Arabic-first project
run by Arabic-reading staff nobody would see it happen. `print-english.ts` holds the labels as
plain constants instead, and the guard asserts the contrast: the interface catalogue is Arabic, the
same words are English on the sheet, and the Arabic ones are absent from it.

**Rejected: a `printLocale` setting.** It makes the paper's language a per-clinic preference, which
is one more thing to get wrong and re-support later; the ruling is that the paper is English, and a
setting would be a way of not deciding.

**The English columns are nullable and the sheet falls back to the Arabic value.** A clinic that has
not been through the settings screen still prints. Refusing would make a settings box a precondition
for handing a patient a prescription, which is a worse failure than an Arabic name on an English
form.

**Dates are formatted here rather than by `Intl`.** `toLocaleDateString("en-GB", { month: "short" })`
returns "Sept" on Node's ICU and "Sep" in some browsers. A visit that prints differently depending
on which engine rendered the page is not acceptable on a document a patient carries to an employer.

## D46 — Sick leave lives on the visit, and its three fields move together

**Ruled 2026-09-09 as Q46.** One visit issues at most one certificate, and every field is about that
visit, so `visits` carries `sick_leave_days`, `sick_leave_from`, `sick_leave_note` and
`sick_leave_printed_count` rather than a table of certificates.

**Rejected: a `sick_leave_certificates` table.** It buys a history of certificates per visit, which
is not a thing an Egyptian outpatient clinic issues, and costs a join on every print.

Three CHECK constraints, in SQL rather than only in the DTO, because the database is the layer that
cannot be bypassed: days is positive; days and the start date are both present or both absent; and a
note cannot exist without leave. The middle one is the load-bearing one — half a certificate cannot
be printed and would sit in the record looking like a decision. Verified by trying all five
refusals and the acceptance against the database.

`sick_leave_printed_count` mirrors `prescriptions.printed_count` so both answer the same question
the same way (Q9: a count of sheets produced, recorded before the modal dialog opens because a
browser reports nothing about whether paper came out).

**The certificate is the one sheet that is dropped when empty.** The other three print their
letterhead and say "nothing prescribed", because a doctor choosing what to hand over should not
discover a missing document at the counter. An unissued sick note is different in kind: an empty
prescription is a statement, an empty certificate is not a document.
