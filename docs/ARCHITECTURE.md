# AI Clinic OS — Architecture

**Version:** 0.1 (Draft for Product Owner Review)
**Date:** 18 August 2026
**Status:** Pending approval. No production code to be written until sections marked ⚠️ are resolved.
**Primary market:** Egypt
**Strategy:** Pilot-first. Ship a working clinic product to 3–5 pilot clinics, then layer WhatsApp, AI, and SaaS commercialisation on top of the same foundation.

---

## 0. Guiding Decisions (Read This First)

Five decisions shape everything below. If any of these are wrong, the rest needs revisiting.

| # | Decision | Rationale |
|---|---|---|
| 1 | **Pilot scope = Phases 1–5 only** | The pilot answers one question: will a paper-based clinic actually switch? That is answered by Reception + Doctor screens, not by AI. |
| 2 | **NestJS + PostgreSQL + Prisma**, not a BaaS | Data must be relocatable (Egypt PDPL cross-border rules), the product is orchestration-heavy, and core business rules must be unit-testable. |
| 3 | **Multi-tenant from day one, even in the pilot** | Retrofitting `tenant_id` after real medical data exists is a migration nightmare. Cost of doing it now ≈ 3 days. |
| 4 | **WhatsApp and AI are deliberately deferred** | Per-clinic Meta verification takes weeks; Meta pricing changes 1 Oct 2026. Do not couple pilot timing to an external dependency. |
| 5 | **Data hosted in Egypt** | Avoids cross-border transfer licensing under PDPL Executive Regulations (Decree 816/2025), enforceable from 31 Oct 2026. |

---

## 1. Recommended Architecture

A **modular monolith**, not microservices.

```
┌──────────────────────────────────────────────┐
│  Web Client (React + TS + Vite, PWA)         │
│  Reception · Doctor · Admin · Super Admin    │
└───────────────────┬──────────────────────────┘
                    │ HTTPS / REST + SSE
┌───────────────────▼──────────────────────────┐
│  API (NestJS)                                │
│  ┌────────────────────────────────────────┐  │
│  │ Guards: Auth → Tenant → Permission     │  │
│  └────────────────────────────────────────┘  │
│  Modules: auth · tenants · users · patients  │
│  doctors · services · schedules · appts      │
│  queue · visits · prescriptions · payments   │
│  reports · audit                             │
│  Deferred: messaging · ai · followups        │
└──────┬──────────────────────┬────────────────┘
       │                      │
┌──────▼──────┐        ┌──────▼──────────────┐
│ PostgreSQL  │        │ Redis + BullMQ      │
│ (RLS on     │        │ (jobs, scheduling,  │
│ sensitive)  │        │  retries)           │
└─────────────┘        └─────────────────────┘
```

**Why a modular monolith:** one clinic generates trivial load. The scaling axis is number of tenants, not requests per tenant. Microservices here would add distributed-transaction complexity for zero benefit. Module boundaries are enforced in code (each module exposes a service interface; no cross-module repository access), so extraction later is mechanical if ever needed.

---

## 2. Recommended Stack

| Layer | Choice | Justification |
|---|---|---|
| Frontend | React 18 + TypeScript + Vite | Dashboard, not a public site. No SEO need. PWA is simpler than Next.js here, and hosting is provider-agnostic. |
| UI | Tailwind + Radix primitives + custom design system | RTL via CSS logical properties, not a mirrored stylesheet. |
| State/Data | TanStack Query + Zustand | Server state and UI state kept separate. |
| Backend | NestJS + TypeScript (strict) | Enforced module boundaries, DI, first-class testing, mature guard/interceptor model. |
| DB | PostgreSQL 16 | `btree_gist` for exclusion constraints, RLS, JSONB for flexible clinical fields. |
| ORM | **Prisma** | Best-in-class migrations and type safety; Client Extensions give us automatic tenant scoping. |
| Jobs | BullMQ + Redis | Reminders, follow-up recall, WhatsApp retries, report pre-computation. |
| Realtime | **Polling. Not SSE, not WebSocket** | Corrected 2026-08-29: this row said Server-Sent Events, while `CLAUDE.md` and the Reception row below both said polling. Two of three agreed and **this table is the one people read first**, so it was the stale line that mattered. Notifications poll at 15s; the queue at 5s while the tab is visible, paused when hidden (`PHASE-3.md` Q1). SSE is reconsidered only against a measurement, not a preference. |
| Auth | Custom JWT + rotating refresh tokens | Needed for the multi-clinic membership model; off-the-shelf auth does not model it well. |
| Files | S3-compatible (MinIO self-hosted option) | Keeps attachments in-country if required. |

### ORM Justification: Prisma over TypeORM

- Prisma migrations are declarative, diffable, and reviewable — critical for medical data where every schema change needs a paper trail.
- Full type inference across relations; TypeORM's typing degrades on complex joins.
- **Client Extensions** allow a single global tenant-scoping layer — the single most important safety mechanism in this product.

**Known trade-off:** Prisma + connection pooling + Postgres RLS is awkward, because RLS needs a per-connection session variable. Mitigation in §6.

---

## 3. Repository Structure

```
clinic-os/
├── apps/
│   ├── api/                      # NestJS
│   │   ├── src/
│   │   │   ├── common/           # guards, decorators, filters, pipes
│   │   │   ├── prisma/           # client, tenant extension, RLS helper
│   │   │   ├── modules/
│   │   │   │   ├── auth/
│   │   │   │   ├── tenants/
│   │   │   │   ├── users/
│   │   │   │   ├── patients/
│   │   │   │   ├── doctors/
│   │   │   │   ├── services/
│   │   │   │   ├── schedules/
│   │   │   │   ├── appointments/
│   │   │   │   │   └── domain/   # PURE slot engine, no I/O
│   │   │   │   ├── queue/
│   │   │   │   ├── visits/
│   │   │   │   ├── prescriptions/
│   │   │   │   ├── payments/
│   │   │   │   ├── reports/
│   │   │   │   └── audit/
│   │   │   └── jobs/
│   │   ├── prisma/schema.prisma
│   │   └── test/
│   └── web/                      # React + Vite
│       └── src/
│           ├── design-system/
│           ├── features/         # mirrors API modules
│           ├── lib/
│           └── i18n/             # ar (default) + en
├── packages/
│   ├── shared-types/             # DTO types shared api ↔ web
│   └── config/                   # eslint, tsconfig bases
├── docs/
│   ├── ARCHITECTURE.md
│   ├── DEPLOYMENT.md
│   └── COMPLIANCE.md
└── docker-compose.yml
```

**Rule:** `modules/appointments/domain/` contains the slot engine as pure functions with no database access. It is the most heavily tested code in the system.

---

## 4. Database Entities

All tenant-scoped tables carry `tenant_id UUID NOT NULL`. All tables use UUID v7 primary keys, `created_at`, `updated_at`.

### Identity & Tenancy

**tenants** — `id, name, slug, phone, address, timezone (default Africa/Cairo), locale, status (trial|active|suspended), settings JSONB, created_at, updated_at`

**users** — global identity, NOT tenant-scoped
`id, email UNIQUE NULL, phone_e164 UNIQUE, password_hash, full_name, is_platform_admin BOOL, last_login_at, status`

**memberships** — the multi-clinic join
`id, user_id, tenant_id, role, permissions_override JSONB NULL, status, created_at`
`UNIQUE (user_id, tenant_id)`

> This solves the doctor-works-at-two-clinics problem cleanly. A JWT is scoped to a single active membership; switching clinics issues a new token.

### Clinic Configuration

**doctors** — `id, tenant_id, membership_id, specialty, license_number, title, signature_url, is_active`

**services** — `id, tenant_id, name_ar, name_en, type (new|followup|procedure), duration_minutes, price, is_active`

**schedule_templates** — `id, tenant_id, doctor_id, weekday (0-6), start_time, end_time, valid_from, valid_to NULL`

**schedule_breaks** — `id, tenant_id, schedule_template_id, start_time, end_time, label`

**schedule_exceptions** — `id, tenant_id, doctor_id, date, type (blocked|holiday|extra_availability), start_time NULL, end_time NULL, reason`

### Patients

**contacts** — ⚠️ solves the shared-phone problem
`id, tenant_id, phone_e164, whatsapp_opt_in BOOL, verified_at NULL`
`UNIQUE (tenant_id, phone_e164)`

**patients** — `id, tenant_id, contact_id NULL, full_name_ar, full_name_en NULL, name_search_ar (GENERATED), name_search_latin NULL, phone_e164 (normalised), secondary_phone, gender, date_of_birth NULL, national_id NULL, email, address, emergency_contact JSONB NULL, notes, relationship_to_contact (self|spouse|child|parent|other), status (active|archived|merged_into), merged_into_patient_id NULL`
`INDEX (tenant_id, phone_e164)` — for duplicate detection, **not** a unique constraint
`GIN trgm INDEX (name_search_ar)`, `GIN trgm INDEX (name_search_latin)` — search, never uniqueness

> One phone number can own multiple patient records (a father booking for his children). Duplicate detection surfaces a suggestion; merging is always an explicit human action and is fully audited. Records are never deleted, only archived or marked merged.

> **Names are bilingual, and search is what makes that hard** (`SCHEMA-DECISIONS.md` D19). `full_name_ar` is the name of record; `full_name_en` is optional. The two `name_search_*` columns are derived search keys, split by how often they change: `name_search_ar` is pure Arabic character normalisation and is computed by Postgres as a `GENERATED` column, while `name_search_latin` holds a transliteration and is maintained by the application because we expect to improve it. Neither is ever `UNIQUE`, and neither ever drives an automatic merge — the normalisation knowingly collapses a small number of genuinely distinct names, and D19 records why that is acceptable and what makes it survivable.

> `date_of_birth`, `gender` and `emergency_contact` are nullable, per founder instruction of 21 Aug 2026: a walk-in registration will not have a date of birth, and a required field means staff invent one.

### Appointments

**appointments**
`id, tenant_id, patient_id, doctor_id, service_id, scheduled_start TIMESTAMPTZ, scheduled_end TIMESTAMPTZ, status, source (whatsapp|reception|doctor|online|walkin), complaint_summary, booking_notes, cancellation_reason NULL, reschedule_count INT DEFAULT 0, created_by, updated_by`

Queue timestamps live on the same row:
`arrived_at, waiting_started_at, consultation_started_at, consultation_ended_at`

**appointment_events** — append-only history
`id, tenant_id, appointment_id, event_type, from_status, to_status, from_scheduled_start, to_scheduled_start, reason, actor_user_id, created_at`

### Clinical

**visits** — `id, tenant_id, patient_id, doctor_id, appointment_id, complaint, medical_history, examination, diagnosis, treatment_plan, doctor_notes, follow_up_date NULL, follow_up_interval_days NULL, status (draft|completed), completed_at, revision, vitals JSONB NULL, created_by`
`UNIQUE (appointment_id) WHERE status = 'COMPLETED'` — partial, so several drafts may coexist and only one may finish. See §4's relationship notes.
`revision` is the compare-and-set counter for concurrent edits (`PHASE-4.md` Q7), not a timestamp.

**visit_revisions** — append-only
`id, tenant_id, visit_id, changed_fields JSONB, previous_values JSONB, actor_user_id, reason, created_at`

> A completed visit is never silently edited. Any change writes a revision row and the UI displays an edit history to the doctor.

**prescriptions** — `id, tenant_id, visit_id, patient_id, doctor_id, issued_at, printed_count, notes`

**prescription_items** — `id, tenant_id, prescription_id, medication_name, dose, frequency, duration, instructions, sort_order`

### Finance

**payments** — `id, tenant_id, patient_id, appointment_id NULL, visit_id NULL, service_price, discount_amount, discount_reason, amount_due, amount_paid, remaining, method (cash|card|other), status (unpaid|partial|paid|refunded), collected_by_user_id, paid_at, notes`

**payment_adjustments** — append-only, for corrections. Payments are never edited in place.

### Governance

**audit_logs** — `id, tenant_id NULL, actor_user_id, actor_role, action, entity_type, entity_id, previous_state JSONB NULL, new_state JSONB NULL, ip_address, user_agent, created_at`

**consents** — PDPL requirement
`id, tenant_id, patient_id, purpose, granted BOOL, granted_at, withdrawn_at NULL, captured_by_user_id, evidence JSONB`

**access_grants** — break-glass support access
`id, tenant_id, granted_to_user_id, reason, expires_at, approved_by_user_id, created_at`

### Deferred (schema designed, not implemented in pilot)

`conversations`, `messages`, `message_templates`, `followup_tasks`, `subscriptions`, `invoices`, `usage_records`

---

## 4b. Schema Additions — AGREED AFTER v0.1

These came out of product-owner discussion after the first draft. **All of them are created in the Phase 1 migration**, even though most are not used until Phase 4 or later. Adding them to an empty database is free; adding them to one holding patient records is not.

### Treatment plans

Reinstated after being cut. Even a general-practice clinic has courses of treatment spanning several visits.

**treatment_plans** — `id, tenant_id, patient_id, doctor_id, title, diagnosis_ref, total_sessions, completed_sessions, status (active|completed|abandoned), started_at, notes`

**treatment_plan_sessions** — `id, tenant_id, treatment_plan_id, session_number, visit_id NULL, planned_date, status (planned|completed|skipped), notes`

A session links to a visit once performed. Plans do not create appointments automatically — reception books them — but the plan surfaces the next due session on the patient profile.

### Payment confirmation — the InstaPay problem

Money never flows through the platform. The clinic is paid directly, either through its own licensed gateway or to its InstaPay handle or mobile wallet.

The gateway case is verifiable by webhook. **The InstaPay/wallet case is not.** The patient says "I paid" and may send a screenshot; a screenshot is not proof and forging one takes minutes.

Therefore `payments.status` gains a state, and the system must never treat a patient's claim as payment:

```
unpaid → pending_confirmation → paid
              │
              └─→ unpaid (reception rejects)
```

Additional columns: `confirmation_method (gateway_webhook|manual_reception|cash)`, `patient_claim_at`, `patient_claim_evidence_url`, `confirmed_by_user_id`, `confirmed_at`.

`pending_confirmation` renders distinctly in reception's queue — never as paid. Only a gateway webhook or an explicit reception action reaches `paid`.

### Prescription delivery over WhatsApp

Prescriptions may reach the patient, but the clinical content is never placed in a WhatsApp message body. The number may be shared across a family, and health data is a sensitive category under PDPL.

**prescription_access_tokens** — `id, tenant_id, prescription_id, token_hash, contact_id, expires_at, max_views, view_count, first_viewed_at, revoked_at`

The message carries a one-time link. Opening it requires a short verification step. Tokens expire, are view-capped, and every access is written to `audit_logs`. Consent for this delivery method is captured in `consents` and is revocable.

This is the only exception to the "no clinical content over WhatsApp" rule in §18, and it exists because the content never travels through WhatsApp — only a pointer does.

### Subscription and usage metering

Pricing is per doctor plus a message bundle, with equal feature access for every clinic. There is no feature-entitlement matrix; there are quantity limits.

**subscriptions** — `id, tenant_id, doctor_count, base_message_allowance, per_doctor_allowance, price_base, price_per_doctor, overage_price, currency, billing_period (monthly|annual), status (trial|active|past_due|suspended|cancelled), trial_ends_at, current_period_start, current_period_end`

**usage_records** — `id, tenant_id, period_start, period_end, message_type, quantity, unit_cost, recorded_at`

**usage_alerts** — `id, tenant_id, period, threshold_pct, sent_at`

Three rules that are not optional:

1. **Quota alerts at 80% and 100% of allowance.** Surprise invoices are the practice this product is positioned against. The meter is visible in-app at all times.
2. **Suspension blocks access; it never deletes data.** A clinic that stops paying must not lose patient records — that is a PDPL problem, not a commercial one.
3. **Doctor identity is bound to clinical records.** The prescribing doctor is recorded on the prescription, the signature, and the audit trail. This makes shared logins produce wrong records, which is a stronger deterrent than enforcement.

### Message bundling

Outbound message types are combined where possible: reminder with confirmation, prescription link with payment request. This halves per-visit message volume and is a cost requirement, not a preference.

`message_templates` therefore carries `bundles (string[])` listing the notification purposes a single template satisfies. **A new outbound message type must justify why it cannot ride along with an existing one.** Every template is registered under Meta's *utility* category; the registry rejects operational templates submitted as marketing.

---

## 5. Entity Relationships

```
tenants ─┬─< memberships >─ users
         ├─< doctors ──< schedule_templates ──< schedule_breaks
         │        └──< schedule_exceptions
         ├─< services
         ├─< contacts ──< patients
         └─< patients ─┬─< appointments ─┬─< appointment_events
                       │                 ├─< visits ───┬─< visit_revisions
                       │                 │            └─< prescriptions ──< prescription_items
                       │                 └─── payments ──< payment_adjustments
                       └─< consents
```

**Cardinality notes:**
- `contacts 1:N patients` — one WhatsApp number, many patient files.
- `appointments 1:0..N visits`, of which **at most one may be `COMPLETED`** — a walk-in still creates an appointment row (source = `walkin`), so every visit has an appointment. This keeps the queue model uniform.

  **Corrected 2026-09-07. This line read `appointments 1:0..1 visits`, and that was wrong twice.**
  It was never enforced — checked on 2026-09-02, `visits` carried no unique index on
  `appointment_id` at all — and after `PHASE-4.md` Q15 it is not the relationship we want. A
  transfer gives the receiving doctor their own empty draft while the originating doctor's draft
  still exists, so several `DRAFT` rows against one appointment is the ordinary case rather than an
  edge one. What must never happen is two *finished* clinical records for one visit.

  The distinction is now carried by a partial unique index on `(appointment_id) WHERE status =
  'COMPLETED'` — `20260907120000_visit_revision_and_completed_index`, mirrored at
  `prisma/sql/22-visit-revision-and-completed-index.sql`, proven at the database in
  `sql-guarantees.integration.spec.ts`. A plain unique constraint would have satisfied the old
  sentence and forbidden the drafts, which is why the correction is to the *relationship* and not
  only to its enforcement.
- `visits 1:0..N prescriptions` — a visit may produce more than one prescription.

---

## 6. Multi-Tenant Design

**Model:** shared database, shared schema, `tenant_id` discriminator.
Rejected: schema-per-tenant (migration cost across thousands of schemas) and database-per-tenant (operationally impossible at target scale).

### Three enforcement layers

**Layer 1 — Request context.** `TenantGuard` extracts `tenantId` from the validated JWT membership claim and populates a request-scoped `TenantContext`. **A `tenantId` appearing anywhere in a request body or query string is ignored and logged as a security event.**

**Layer 2 — Prisma Client Extension.** A global extension intercepts every query on tenant-scoped models and injects `where.tenantId` on reads and `data.tenantId` on writes. A model registry marks which models are tenant-scoped; forgetting to register a new model throws at boot, not at runtime.

```ts
// Sketch — full implementation in Phase 1
prisma.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!isTenantScoped(model)) return query(args);
        const tenantId = tenantContext.getOrThrow();
        return query(injectTenant(operation, args, tenantId));
      },
    },
  },
});
```

**Layer 3 — Postgres RLS** on `patients`, `visits`, `visit_revisions`, `prescriptions`, `prescription_items`, `payments`, `consents`.

⚠️ **Pooling caveat.** RLS requires `SET LOCAL app.current_tenant_id` inside a transaction. With a transaction-mode pooler this only works if every RLS-protected query runs inside an explicit `$transaction`. **Decision required:** either (a) route all clinical reads through a transaction wrapper — small performance cost, or (b) use session-mode pooling with a smaller connection ceiling. Recommendation: (a).

### Super Admin isolation

A platform admin has **no default read access to clinical data**. Access requires:
1. An `access_grants` row with a written reason and an expiry (max 24h).
2. An `audit_logs` entry at grant time and on every subsequent clinical read.
3. Notification to the clinic owner.

Platform admins retain unrestricted access to tenant metadata, subscription state, and aggregate usage — never to patient records.

---

## 7. Authentication Model

- **Access token:** JWT, 15 minutes, claims `{ sub, membershipId, tenantId, role, permissions }`.
- **Refresh token:** 30 days, opaque, hashed at rest, **rotating** — reuse of a consumed token revokes the entire family and forces re-login.
- **Transport:** refresh token in `httpOnly; Secure; SameSite=Strict` cookie. Access token in memory only, never `localStorage`.
- **Passwords:** Argon2id.
- **Clinic switching:** `POST /auth/switch-tenant` validates the membership and issues a new token pair. No token ever carries more than one tenant.
- **Rate limiting:** 5 login attempts per identifier per 15 min, then exponential lockout.
- **Session revocation:** clinic admin can terminate a user's sessions immediately (needed when reception staff leave).

⚠️ **Decision required:** MFA. Recommendation — not in pilot, mandatory for clinic owners before commercial launch.

---

## 8. Permission Model

Role-based, with a per-membership override for edge cases.

| Capability | Owner | Admin | Doctor | Reception |
|---|:--:|:--:|:--:|:--:|
| Clinic settings | ✓ | ✓ | — | — |
| Manage users | ✓ | ✓ | — | — |
| Manage doctor schedules | ✓ | ✓ | own | ✗ (configurable) |
| Manage services & prices | ✓ | ✓ | — | — |
| **Read a patient** (profile, history, balance, insurance) | ✓ | ✓ | ✓ | ✓ |
| Create/edit patients, record insurance | **—** | ✓ | ✓ | ✓ |
| Merge patient records | ✓ | ✓ | — | — |
| **Request / accept / reject a patient transfer** | **—** | ✓ | ✓ | ✓ |
| **Read the scheduling surface** (availability, schedules, queue board, no-shows, appointment detail, doctor roster, services, notifications) | ✓ | ✓ | ✓ | ✓ |
| Create/reschedule/cancel/confirm appointments | **—** | ✓ | ✓ | ✓ |
| Override slot conflict | **—** | ✓ | own | ✗ (configurable) |
| Check-in, start consultation, mark no-show | **—** | ✓ | ✓ | ✓ |
| **Complete a consultation** (`IN_CONSULTATION → COMPLETED`) | — | — | ✓ | — |
| Read visit **index** (dates, doctor, service, status) | ✓ | ✓ | ✓ | ✓ |
| Read visit **content** (diagnosis, plan, notes) | — | — | ✓ | — |
| Read prescription **existence** | ✓ | ✓ | ✓ | ✓ |
| Read prescription **items** | — | — | ✓ | — |
| Read follow-up due date | ✓ | ✓ | ✓ | ✓ |
| Write clinical records | — | — | ✓ | — |
| Write prescriptions | — | — | ✓ | — |
| Read the payments screen | ✓ | ✓ | own | ✓ |
| Record payments | — | **—** | **own** | ✓ |
| Adjust/refund payments | ✓ | ✓ | — | — |
| Financial reports | ✓ | ✓ | own | — |
| Audit log | ✓ | ✓ | — | — |

**The queue row was split on 2026-09-03.** It previously read "Check-in / queue actions ✓ ✓ ✓ ✓",
and `PHASE-3.md` Q13 matched it by putting every queue move on `appointments.write`. Reception
could therefore end a consultation, and both the screen and the API agreed on it.

**Completing a visit is a clinical assertion, not a scheduling act** — it says the doctor finished
and recorded their notes. Under `PHASE-4.md` Q6 it is also what finalises the record, so after it
the doctor adding a forgotten sentence must file a `visit_revisions` row with a reason. A
receptionist tidying the board could do that to a doctor who is mid-sentence.

So `IN_CONSULTATION → COMPLETED` is now `appointments.completeVisit`, `DOCTOR` only — including not
`OWNER` or `ADMIN`, because the assertion is about who saw the patient. **This is a revision of Q13,
not a correction of it**: Q13 anticipated a split for a different reason and said so.

**The owner left the queue row on 2026-09-06, and left transfers with it.**

The founder ruled it, reversed himself once, and the reversal is the reasoning worth keeping. His
first position was to leave the capability and hide the buttons, because in a single-doctor Egyptian
clinic the owner *is* the doctor and often the desk too — and a rule that makes the product unusable
for the most common clinic is not a rule either. He then withdrew it:

> *"The audit trail. An owner checking a patient in under the owner role records 'the owner did
> this' — which in a multi-doctor clinic makes accountability ambiguous. Under a receptionist
> membership it records what actually happened. And the product serves clinics and medical centres,
> not just single-doctor practices. A rule that only works because one person wears every hat is not
> a rule."*

**The owner keeps `appointments.write`.** The queue board stays visible and the sidebar link is
gated on that rather than on the action capability: *read-only* is the ruling, and hiding the board
would have been a stricter one nobody made.

**Transfers needed a capability of their own to express this, and that is `PHASE-3.md` Q25 coming
due.** All four transfer routes were guarded by `appointments.write`, which also guards the queue
read, the availability and schedule reads, and booking, rescheduling, cancelling and confirming.
Removing `appointments.write` from OWNER would have taken the queue board with it. Q25 recorded
`appointments.write` as "one capability doing two jobs" and left the split to the founder; a
transfer is a clinical hand-off between doctors rather than a scheduling act, and it is now
`patients.transfer`.

**Four more cells moved on 2026-09-06, and two could not.** The founder's rule is *"owner
administers, does not practise, does not run the desk"*, and the audit-trail argument above applies
to every operational act, not only to the queue.

- **`appointments.overrideSlotConflict` → OWNER none.** Forcing a booking past a conflict is a desk
  override. No route reads this capability yet, so it changes nothing today — which is the argument
  for fixing it now, while it is free.
- **`payments.record` → OWNER none.** The same argument as the queue, and money is where it matters
  most: an owner taking cash under the owner role records "the owner took this". **`payments.adjust`
  deliberately stays.** Approving a refund or a discount *is* administration; standing at the desk
  taking cash is not. The two rows differ on purpose.
- **R2, 2026-09-11 — `payments.read` is new, and `payments.record` lost ADMIN and gained DOCTOR at
  `own`.** The «المدفوعات» screen is one screen read three ways: reception works it, a doctor sees
  their own patients' half of it, and an admin reads the whole day and may take none of it. That is
  a separation of duties rather than a convenience, so the screen and the act became two
  capabilities. Two per-doctor settings decide the rest — `doctors.may_adjust_prices` (R1) and
  `doctors.collects_payments` — because "this doctor may move a price" is a fact about one person
  and the matrix describes roles. An owner or admin still authorises a discount above the ceiling,
  through `PUT /charges/:id/discount/authorised` on `payments.adjust`, which is the row that has
  always said exactly that.
- **`patients.write` and `appointments.write` were split the same day, and that is the more
  important half of this change.** Both bundled reads with writes, and the founder's objection was
  about naming rather than about the owner: *"`patients.write` guarding six reads means every future
  permission decision on those routes is decided by a capability whose name says the opposite of
  what it does. That's how `appointments.write` ended up gating `/queue/today`, which is a board."*

  `patients.read` and `appointments.read` now carry the reads, `FULL` for all four roles. The write
  halves carry only writes — four routes each — and are `—` for OWNER. Seventeen read routes moved.

  **`POST /notifications/read` sits on the read side deliberately.** Marking your own notification
  read is a personal act on your own inbox, not an operation on a patient or a booking, and an owner
  who could not dismiss their own notifications would be a worse answer than an imperfect capability
  name. Recorded rather than hidden: if notifications ever earn a capability of their own, that
  route belongs to it.

**The clinical half was never open.** `visits.write`, `prescriptions.write`, `visits.readContent`,
`prescriptions.readItems` and `appointments.completeVisit` have all been `—` for OWNER since before
this ruling — the last since Q13 on 2026-09-03, the rest since Phase 1. An owner has never been able
to author a diagnosis or a prescription through this matrix. `doctors.signature_url` is a column on
a **doctor record**, which hangs off a membership; an owner without one has no signature to attach.

**The escape hatch for a working owner exists: a second membership in the same clinic.** The ruling
says such an owner holds a second membership as DOCTOR or RECEPTIONIST and switches to it. That was
impossible until 2026-09-06, because `memberships` carried `@@unique([userId, tenantId])` — proven
against the database, one user could not hold two memberships in one clinic — so an owner who worked
the desk needed a second login. The constraint has been dropped
(`20260906120000_memberships_multiple_per_tenant`); the migration records why, and the absence is
documented in `schema.prisma` so nobody restores it as an oversight.

Nothing depended on it. The session is keyed on `membershipId`, not on `(userId, tenantId)`;
`switchTenant` validates that the target membership belongs to the caller rather than that it is the
caller's only one in that tenant; and `doctors.membershipId` stays `@unique`, so one membership is
still one doctor record and a person cannot accumulate two doctor rows in a clinic.

Three consequences, all shipped in the same change:

- **The tenant switcher is a membership switcher.** `/auth/me` returns every membership with its
  role, and the client picks. Where a user holds two memberships in one clinic the entries are
  labelled by role — `عيادة النيل — استقبال` and `عيادة النيل — مالك`; where they hold one, the
  label stays the plain clinic name, because a role suffix on an unambiguous entry is noise.
- **Doctor resolution keys on the membership.** `doctorIdForUser` looked up a doctor by `userId`
  with an unordered `findFirst`, which was already fragile and became wrong the moment one user
  could hold two memberships in a clinic. It is now `doctorIdForMembership(tx, membershipId)`, and
  every caller passes the membership from the validated JWT. A `CallerContext` must therefore
  describe **one** person: an actor from one membership and an id from another resolves to the
  wrong doctor.
- **The seed exercises it.** The single-doctor clinic's owner holds a second RECEPTIONIST
  membership, so the case a real one-doctor clinic lives in is represented in test data rather than
  only in prose.

### Clinical Visibility Split — APPROVED

The boundary is not "visits are private." It is **clinical metadata is operational; clinical content is confidential.** Reception and clinic management need the former to run the clinic, and must never see the latter.

| Tier | Fields | Visible to |
|---|---|---|
| **Metadata** (operational) | visit date, doctor, service, visit status, follow-up due date, prescription issued yes/no, print count, all payment data | Owner, Admin, Doctor, Reception |
| **Content** (confidential) | complaint, medical history, examination, diagnosis, treatment plan, doctor notes, vitals, prescription items | Doctor only |

Complaint *summary* captured at booking stays on `appointments`, not `visits` — reception writes it, so reception reads it. The clinical `complaint` field on the visit is a separate, doctor-only field.

**Implementation rule — this is enforced by endpoint separation, not field filtering:**

```
GET /patients/:id/visits        → VisitIndexDto[]   (metadata only, all roles)
GET /visits/:id                 → VisitDetailDto    (full content, doctor only)
GET /visits/:id/prescription    → PrescriptionDto   (items, doctor only)
```

Two separate DTOs and two separate endpoints. Filtering fields inside one response object is how leaks happen — one careless `select: *` or a forgotten serializer and the whole record goes over the wire. The metadata endpoint physically cannot return clinical content because it does not query those columns.

Every read of `VisitDetailDto` by a doctor who did not author the visit writes an `audit_logs` entry. In a multi-doctor clinic this matters.

Implementation: `@RequirePermission('visits.read.content')` decorator + `PermissionGuard`. Permissions resolve from role, then overlay `permissions_override`.

---

## 9. Appointment State Machine

```
                 ┌──────────┐
                 │  booked  │◄──── created (any source)
                 └────┬─────┘
          confirm     │      arrive
        ┌─────────────┼─────────────┐
        ▼             │             ▼
  ┌───────────┐       │       ┌──────────┐
  │ confirmed ├───────┼──────►│ arrived  │
  └─────┬─────┘       │       └────┬─────┘
        │             │            │ mark waiting
        │             │            ▼
        │             │      ┌──────────┐
        │             │      │ waiting  │
        │             │      └────┬─────┘
        │             │           │ start visit
        │             │           ▼
        │             │   ┌─────────────────┐
        │             │   │ in_consultation │
        │             │   └────┬────────────┘
        │             │        │ save & complete
        │             │        ▼
        │             │   ┌───────────┐
        │             │   │ completed │  (terminal)
        │             │   └───────────┘
        ▼             ▼
  ┌───────────┐  ┌──────────┐
  │ cancelled │  │ no_show  │   (both terminal)
  └───────────┘  └──────────┘
```

**Rules:**
- `cancelled` reachable from `booked`, `confirmed`, `arrived`, `waiting`. Requires a reason.
- `no_show` reachable from `booked`, `confirmed` only, and only after `scheduled_start + grace_period` (clinic-configurable, default 30 min). Auto-marked by a nightly job; reversible by reception the same day.
- `completed` is terminal. Re-opening requires admin permission and writes a `visit_revisions` row.
- **Reschedule is not a status.** It mutates `scheduled_start`/`scheduled_end`, increments `reschedule_count`, and appends an `appointment_events` row. History is never lost.
- Every transition writes to `appointment_events`. The state machine is a pure function `transition(current, event, actor) → next | Error`, tested exhaustively.

### Double-booking prevention

Enforced by the database, not application logic:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE appointments ADD CONSTRAINT no_double_booking
  EXCLUDE USING gist (
    doctor_id WITH =,
    tstzrange(scheduled_start, scheduled_end) WITH &&
  ) WHERE (status NOT IN ('cancelled', 'no_show'));
```

Application-level checks race under concurrency; this constraint cannot be bypassed. Authorised overrides use a separate `allow_overlap` flag on the appointment, excluded from the constraint predicate.

### Slot engine

Pure, deterministic, zero I/O. **Corrected 2026-08-28 — `PHASE-2.md` §4 and §7 are authoritative where this section is thinner.** The version below carried three errors: it omitted `timezone`, which `CLAUDE.md` requires to be a parameter; it left `date` as an unspecified type; and its last two steps described an algorithm that produces wrong results.

```
generateSlots(input: {
  timezone,                          // tenants.timezone. Never defaulted, never a literal
  date,                              // "YYYY-MM-DD", read in `timezone`
  templates, breaks, exceptions,     // covering `date` AND the day before it
  existingAppointments,              // each carrying its own service's buffer
  service, granularityMinutes, leadMinutes, now
}) → Slot[]
```

Order of operations: resolve the weekday of `date` in `timezone` → expand templates valid on `date` into wall-clock windows anchored to it, a window whose `end_time <= start_time` running past midnight but still belonging to that session → union `extra_availability` → subtract breaks → subtract `blocked`/`holiday`, which always win → keep windows anchored to `date` → **convert to instants through `timezone`** → subtract occupied ranges, in instant space → step by `granularityMinutes` from each window start, keeping `[t, t + duration]` only where it fits entirely inside that window → drop slots starting at or before `now + leadMinutes`.

The conversion sits **before** the occupancy subtraction, not after. Wall clock is ambiguous for one hour each autumn — two appointments an hour apart in real time read as the same local time — so subtracting occupancy in wall-clock space removes both occurrences when one is booked.

Three corrections worth naming, because the original wording invites the bug:

- **"Drop slots shorter than `service.duration_minutes`" describes nothing real.** Slots have no length before the service is applied. Chopping a window into granularity-sized pieces and discarding the short ones gives different results from the step above for any duration that is not a multiple of the granularity.
- **A template may cross midnight** (`end_time < start_time`), so generating one day requires the previous day's templates. Egyptian evening clinics running past midnight are ordinary, and refusing to represent them was considered and rejected (`PHASE-2.md` §4/Q8).
- **`Africa/Cairo` is not a property of this engine.** It appears in seed data only. Times are stored as `TIMESTAMPTZ`, computed in UTC, and rendered in the tenant's timezone — which is a column, not a constant. Egypt observes DST at **midnight**, which only a cross-midnight template can reach; the two 2026 transitions are pinned by test.

---

## 10. Visit State Machine

```
appointment.in_consultation
        │ auto-create
        ▼
    ┌───────┐  autosave every 30s
    │ draft │◄─────────┐
    └───┬───┘          │
        │ save & complete
        ▼
   ┌───────────┐  admin re-open (audited)
   │ completed ├──────────► draft
   └───────────┘
```

- A `draft` visit survives browser crashes — the doctor resumes from the queue.
- Completing a visit atomically: sets `visits.status = completed`, transitions the appointment to `completed`, stamps `consultation_ended_at`, and creates a `followup_task` if a follow-up was set. One transaction.
- Completed visits are read-only in the UI. Editing requires an explicit "correct this record" action with a reason, producing a `visit_revisions` row. The original values are never destroyed.

---

## 11. WhatsApp Architecture (designed, deferred to Phase 6)

**Onboarding model:** register Rahal Group as a **Meta Tech Provider** and use **Embedded Signup**, so each clinic connects its own WhatsApp number from inside our product in a few clicks rather than us brokering their verification. This converts the single biggest onboarding obstacle into a selling point.

```
Meta Cloud API
   │ webhook (signed)
   ▼
POST /webhooks/whatsapp/:tenantId
   │  1. verify X-Hub-Signature-256
   │  2. persist raw event, return 200 immediately
   ▼
BullMQ queue ── worker ──┬─ resolve tenant from phone_number_id
                         ├─ resolve/create contact
                         └─ route to handler
```

**Design constraints:**
- Webhook handler does nothing but verify, persist, and acknowledge. All processing is async — Meta retries aggressively on slow responses.
- `phone_number_id → tenant_id` mapping is the tenant resolution key. Never trust anything else in the payload.
- Message send is idempotent, keyed on a client-generated `idempotency_key`.
- Outbound sends are rate-limited per tenant and recorded in `usage_records` for cost attribution.

⚠️ **Commercial constraint:** from 1 October 2026 Meta charges for utility templates and service-window messages that are currently free. Every reminder and follow-up must be categorised as **utility**, never marketing — the price difference in Egypt is roughly an order of magnitude. Template category is a product decision enforced in code: the template registry rejects any operational template submitted under a marketing category.

**Privacy rule:** WhatsApp is for booking, scheduling, reminders, follow-up, and clinic information. **No clinical content is ever sent over WhatsApp in V1** — no diagnoses, no prescriptions, no results. This sidesteps the identity-verification problem entirely rather than half-solving it.

---

## 12. AI Tool Architecture (designed, deferred to Phase 7)

The AI never touches the database. It calls the same service layer the HTTP controllers use, through a constrained tool registry.

```
Patient message
      ▼
┌─────────────────┐
│ Intent + slots  │  LLMProvider (vendor-agnostic interface)
└────────┬────────┘
         ▼
┌─────────────────────────────────────┐
│ Tool Registry                       │
│  get_clinic_information()           │
│  get_doctor_information()           │
│  find_patient_by_phone()            │
│  find_available_slots()   ← truth   │
│  create_appointment()               │
│  reschedule_appointment()           │
│  cancel_appointment()               │
│  confirm_appointment()              │
│  create_followup_request()          │
└────────┬────────────────────────────┘
         ▼
   Same services · same guards · same audit
```

**Non-negotiable rules:**
1. `find_available_slots()` is the only source of availability. The model is never asked to reason about times; it selects from a returned list. Hallucinated availability is architecturally impossible.
2. Every tool call runs under a synthetic `AI_AGENT` actor with its own permission set — strictly narrower than a receptionist's. It cannot read clinical records, merge patients, or touch payments.
3. Every tool call **that writes** is written to `audit_logs` with the triggering message ID (`audit_logs.message_id`, added in Phase 2). **Reads are not audited, and that is a decision rather than a gap** — amended 28 August 2026, because the original wording said "every tool call" and was already false: D16's audit triggers fire on INSERT/UPDATE/DELETE, so `find_available_slots()` has never left a row and never would without an explicit application-level write. Auditing availability lookups would produce more rows than the appointments themselves, for a read that discloses nothing a patient could not learn by asking the clinic. The writes are the part worth having, and they carry the message that caused them.
4. `LLMProvider` is an interface. Swapping vendors is a config change.
5. **Medical safety:** a classifier runs before intent extraction. Anything resembling a medical question, symptom description requiring judgement, or urgency signal is routed to a configurable escalation template and handed to a human. The AI does not diagnose, does not advise on medication, and does not interpret symptoms — not even to reassure.

**Language:** Egyptian Arabic, MSA, English, and code-switched input. Arabic-Indic numeral normalisation (٧ → 7) happens in preprocessing, before the model sees the text — a classic silent failure point.

---

## 13. Follow-up Automation (Phase 8)

```
Doctor sets follow-up on visit completion
      ▼
followup_tasks row { due_date, patient, doctor, visit, status: pending }
      ▼
Daily job (per tenant, at clinic-local 09:00)
      ▼
Due tasks → outbound utility template → status: sent
      ▼
Patient replies → AI booking flow → status: booked | declined | expired
```

- Scheduling is **relative to clinic timezone**, not server time.
- A per-patient contact-frequency cap prevents follow-up spam when a patient has several open plans.
- Opt-out is honoured permanently at the `contacts` level and is irreversible without explicit re-consent.
- Tasks expire after a configurable window rather than retrying indefinitely.

---

## 14. Deployment Strategy

| Environment | Purpose | Data |
|---|---|---|
| Local | Development | Docker Compose: Postgres + Redis, seeded fixtures |
| Staging | Pre-release verification | Synthetic data only — **never a production copy** |
| Production | Pilot clinics | Real clinical data, Egypt-hosted |

- Containerised (Docker), reverse proxy with TLS termination, secrets from environment only.
- `.env.example` committed; `.env` never. Secret scanning in CI.
- Zero-downtime deploys: migrations run as a separate step before the new image goes live; all migrations must be backward-compatible for one release (expand → migrate → contract).
- CI gates: typecheck → lint → unit → integration → build. **No deploy on a failing gate, no exceptions.**

⚠️ **Decision required:** hosting provider. Needs an Egypt-based option evaluated for uptime and support quality before the pilot handles real patient data.

---

## 15. Backup Strategy

- Continuous WAL archiving + nightly full base backup.
- Retention: 30 days point-in-time recovery; monthly archives retained per the clinic's stated retention policy.
- Backups encrypted at rest, stored in a separate failure domain from the primary database.
- **Restore drills are mandatory and scheduled** — monthly, into a scratch environment, with the recovery time recorded. An untested backup is not a backup.
- Per-tenant logical export available on demand (PDPL data portability, and it removes the "am I locked in?" objection during sales).

---

## 16. Testing Strategy

Priority is inverted from the usual pyramid: correctness of clinical and scheduling logic matters more than UI coverage.

**Tier 1 — must be exhaustive**
- Slot engine: overlapping breaks, exceptions, DST-adjacent dates, back-to-back services, zero-availability days
- Appointment state machine: every legal transition, every illegal transition rejected
- Double-booking: concurrent booking attempts on the same slot must produce exactly one success
- Tenant isolation: for every tenant-scoped endpoint, a cross-tenant request returns 404 (not 403 — do not confirm existence)
- Permission matrix: table-driven, one case per role × capability cell

**Tier 2**
- Patient duplicate detection and merge, including audit trail correctness
- Visit completion transaction atomicity
- Payment arithmetic: discount, partial payment, remaining balance, refund
- Auth: refresh rotation, token-reuse family revocation, tenant switching

**Tier 3**
- Critical E2E flows: book → check-in → consult → prescribe → pay
- Component tests for the design system

Tenant isolation tests run on every commit and block merge. This is the one failure mode that ends the business.

---

## 17. Security Considerations

- Argon2id password hashing; no password ever logged.
- All input validated at the boundary with `class-validator` DTOs; `whitelist: true, forbidNonWhitelisted: true`.
- Prisma parameterises everything — no raw SQL except reviewed, parameterised reporting queries.
- Output encoding by default in React; `dangerouslySetInnerHTML` is lint-banned.
- CSRF: refresh cookie is `SameSite=Strict`; state-changing endpoints require the bearer token.
- Rate limiting: global, per-IP, and per-user tiers, with tighter limits on auth and search endpoints.
- Security headers: HSTS, CSP, `X-Content-Type-Options`, `Referrer-Policy`.
- Structured logging with automatic PII redaction — patient names and phone numbers must never reach log aggregation.
- Dependency scanning in CI; automated patch-level updates.
- **Data at rest:** disk encryption plus column-level encryption for `national_id`.

### PDPL Compliance Model (Egypt)

Health data is a sensitive category under Law 151/2020, and the Executive Regulations (Decree 816/2025) become fully enforceable on 31 October 2026. Architectural obligations:

| Requirement | Implementation |
|---|---|
| Explicit, purpose-specific consent | `consents` table, captured at patient registration, exportable |
| Data residency / cross-border | Egypt-hosted primary; no clinical data leaves the country without a licence |
| Breach notification within 72h | Incident runbook + alerting; `audit_logs` provide the forensic trail |
| Defined retention periods | Per-tenant retention policy in `tenants.settings`; archival job, not deletion |
| Data subject rights | Per-patient export and correction endpoints |
| Secure processing register | `audit_logs` + a documented processing inventory |
| Controller/Processor split | Clinic = Controller, platform = Processor. **Must be papered in the subscription agreement.** |

⚠️ **Non-engineering blockers** — must run in parallel with development, not after: PDPC licence/permit, DPO appointment, local representative if the contracting entity remains non-Egyptian, and legal review of the Data Processing Agreement.

---

## 18. MVP Boundaries — REVISED FOR ACTUAL CAPACITY

**Constraint that drives this section:** the product owner has roughly 10–15 hours per week (evenings and weekends). The original Phase 1–5 scope needs ~20–24 weeks at that pace. The scope below is cut to fit ~12–16 weeks without weakening the core promise.

The cut is not arbitrary. Every removed item fails one of two tests: *does a clinic abandon paper without it?* and *does it break if we add it in month four instead of month two?*

### Pilot scope — build this

| Module | Delivered | Deliberately thin |
|---|---|---|
| Auth & tenancy | Login, roles, permissions, tenant isolation | No MFA, no self-service signup — tenants seeded by script |
| Patients | Search, create, profile, visit history | Duplicate **detection** only; merge is a manual DB task |
| Doctors & services | Profiles, services, prices, durations | — |
| Schedules | Weekly template, breaks, blocked days | No recurring holiday rules, no waiting list |
| Appointments | Slot engine, book, reschedule, cancel | **Day view only** — no week or month calendar |
| Reception | Today dashboard, queue, check-in, walk-ins, no-show | Polling every 15s, not SSE |
| Clinical | Visit screen, history, diagnosis, plan, follow-up date | Free-text fields; no specialty templates |
| **Attachments** | Upload photo/PDF to patient file, view inline | No imaging viewer, no OCR |
| Prescriptions | Create, print A5/A4 | No drug database, no interaction checks |
| Payments | Record, discount, partial, remaining balance | No refunds screen — adjustments via admin |
| Numbers | Phase 3 ships the five the queue can answer: booked today, checked in, still waiting, completed, current longest wait. Today's revenue and outstanding balance join them in Phase 4, with payments (`PHASE-3.md` Q10) | A narrow payments report was reinstated by the founder 2026-09-13 (Phase 5 PR 14): day or month, by method, per doctor, outstanding, adjustments and above-ceiling discounts. Read-only, over data that already exists — no cohort analysis, no exports, no charts |
| Audit | Full server-side logging, and a read-only viewer — admin and owner, filterable by person, day and record type (Phase 5 PR 11, put back into scope by the founder 2026-09-09) | Field **names** only, never values: `audit_logs` mirrors every audited row, and the roles holding `auditLog.read` hold `visits.readContent: NONE` |

### Cut from the pilot — and why

| Cut | Why it is safe to cut |
|---|---|
| Reports screen | Three dashboard numbers answer 90% of what a small clinic asks. Reports are a month-four feature. |
| ~~Week/month calendar~~ **— reversed 2026-09-03, now Phase 5** | ~~Reception works one day at a time. Day view plus a date picker is enough.~~ **This reason was overturned by the founder on the day it was acted on: *"a real gap for reception, not a convenience — a patient calls asking «when is my appointment next week» and the day view makes that a hunt."* Struck rather than deleted, because an unqualified cut is what would re-cut the feature later. See `PHASE-4.md`.** |
| SSE realtime | 15-second polling is indistinguishable at clinic scale and costs a fraction of the effort. |
| Patient merge UI | Detection prevents the damage. Merging three duplicates by hand is faster than building the screen. |
| Users & permissions screen | Pilot clinics have 2–5 users. Seed them. |
| Super admin console | Create tenants with a script until there are more than ten. |
| Clinic settings screen | Ship a settings JSON edited by the operator; build the UI when a clinic asks twice. |
| PWA offline, dark mode | Neither affects paper displacement. |
| Public booking page + QR | High value, genuinely cheap — **build it only if Phases 1–4 land on schedule.** First cut if they slip. |

### Kept despite being "optional" — attachments

Originally deferred. Reinstated because Egyptian outpatient patients arrive holding X-ray films and lab printouts. If the doctor cannot photograph and attach them, the paper folder survives next to the system — and the core promise fails. Upload plus inline view is roughly two days of work. It stays.

### Still out of scope

WhatsApp integration · AI receptionist · automated reminders · subscription billing · multi-session treatment plans · lab integration · inventory · HR · multi-branch · telemedicine · native apps · insurance claims · drug interaction checking

### Specialty strategy

The product is built specialty-agnostic: free-text clinical fields, no templates. This is correct for V1 and cheap.

But **the pilot cohort should be drawn from one specialty**, even though the product is generic. Five clinics from five specialties produce five contradictory feature requests and no signal. Five clinics from one specialty produce a pattern worth acting on. Pick the specialty by which doors the product owner can actually open, not by market size.

---

## 18b. Multi-Country Portability

The model is intended to move outside Egypt later. Four things are cheap now and expensive in year two:

| Concern | Decision |
|---|---|
| Currency | `tenants.currency` (ISO 4217). **No amount column is ever labelled EGP.** Money stored as integer minor units, never float. |
| Timezone | `tenants.timezone` already exists. **No `Africa/Cairo` literal anywhere in code** — it is a seed default only. The slot engine takes timezone as a parameter. |
| Phone numbers | `libphonenumber` with the tenant's country as the parsing hint. Storage is always E.164. Never assume a +20 prefix. |
| Tax & invoicing | A `TaxProvider` interface with an `EgyptTaxProvider` implementation. Egyptian e-invoicing rules live behind it, not scattered through the payments module. |

Deliberately **not** done now: multi-currency within one tenant, FX conversion, or per-country legal document variants. Those wait for a real second market.

---

## 19. Future Module Extension Strategy

Every deferred module has a defined seam already present in the design:

| Module | Seam |
|---|---|
| Attachments | `visits` + S3 adapter behind a `StorageProvider` interface |
| Inventory | New module; consumes `services` and `visits` via events, no schema coupling |
| HR | Separate `employees` table, deliberately **not** joined to `users` — employment and system access are different concerns |
| Multi-branch | `branches` table; `tenant_id` stays the isolation boundary, `branch_id` becomes a filter. Designed now, unpopulated. |
| Advanced finance | `payments` is already append-only with adjustments — a ledger can be layered on without restructuring |
| AI Copilot | `LLMProvider` interface plus a mandatory doctor-approval step on any generated clinical text |
| Subscription billing | `subscriptions`, `invoices`, `usage_records`; must support Egyptian e-invoicing, VAT reverse-charge, and TRN/UIN validation |

**Rule:** an event bus (in-process, NestJS `EventEmitter`) publishes domain events — `VisitCompleted`, `AppointmentCancelled`, `PaymentRecorded`. Future modules subscribe rather than reaching into other modules' tables.

---

## 20. Implementation Roadmap

**Capacity assumption: 10–15 hours per week, evenings and weekends.** Estimates are in calendar weeks at that pace, not engineering weeks. The bottleneck is the product owner's review and testing time, not code generation speed.

| Phase | Scope | Calendar est. | Gate |
|---|---|---|---|
| **0** | This document, approved | done | ✅ |
| **1** | Repo, Docker, full Prisma schema, auth, tenancy, roles | 2–3 wk | Tenant isolation tests green |
| **2** | Doctors, patients, services, schedules, slot engine, day view | 3–4 wk | Slot engine suite exhaustive; double-booking verified under concurrency |
| **3** | Reception dashboard, queue, check-in, walk-ins, no-show | 2–3 wk | **A real receptionist reaches competence in under 10 minutes** |
| **4** | Visit screen, patient history, attachments, prescriptions, print | 3–4 wk | A real doctor completes a full visit unaided |
| **5** | Payments, balances, three dashboard numbers | 1.5–2 wk | Financial arithmetic suite green |
| **Total to pilot-ready** | | **12–16 weeks** | ≈ mid-November to mid-December 2026 |
| **PILOT** | Deploy, seed, train, run 3–5 clinics | 4–6 wk | Daily active use; measured paper displacement |
| 6+ | WhatsApp → AI → automation → reports → hardening | — | Sequenced after pilot findings |
| After 6 | Specialty modules, dental first — see below | — | Order set by the first pilot clinics' specialties |
| After pilot | **Framework majors** — React 19, NestJS 12 — see below | — | Ruled 2026-09-19: not before a clinic is live |

### Framework majors are a post-pilot item (ruled 2026-09-19)

**React 19 (#154) and NestJS 12 (#155) wait until after the pilot**, labelled `after-pilot` and left
open rather than closed, so the work is visible and the decision is not re-taken every Monday.

The reason is what a major costs at this moment rather than what it costs in general. A framework
major is a day of unknown length: React 19 changes how effects and refs behave in ways a test suite
does not always catch, and NestJS 12 moves the ground every guard, interceptor and module in this
codebase stands on. Spending that day *before* a clinic is using the product buys nothing a pilot
needs, and spending it *during* a pilot risks the one thing the pilot is for — a receptionist and a
doctor getting through a clinic day.

Security advisories are not covered by this deferral. They arrive through the weekly audit job and
carry their own deadlines (`docs/SECURITY-REVIEW.md` A06: critical within 7 days, high within 30),
and an advisory that can only be fixed by a major bump is a decision taken then, on its merits.

Patch and minor updates keep flowing: `.github/dependabot.yml` groups them separately from majors
exactly so that the small, safe group can merge weekly while these two sit still.

### Specialty modules — after Phase 6, dental first (recorded 2026-09-17)

Backlog, not scheduled work. **Dental first:** an interactive tooth chart in FDI notation, tied to
`VisitProcedure` and the service catalogue (`Service`); treatment plans in phases, with cost and a
printable quote; x-rays attached per tooth; lab orders; recall reminders.

**Then, in an order the first pilot clinics' specialties decide:**

| Specialty | Module |
|---|---|
| Dermatology / aesthetics | Before/after photo timeline on a body map; session packages |
| Ophthalmology | Exam fields; optical prescription |
| Paediatrics | WHO growth charts; the Egyptian vaccination schedule |
| OB/GYN | Pregnancy timeline |
| Internal medicine | Lab trend charts |
| Physiotherapy | Session packages |

**Two rules, fixed before any of it is built:**

1. **Clinical parts are English-only.** Doctors chart in English, so a tooth chart, an exam form or a
   growth chart is an LTR island inside the RTL screen — the same treatment as a phone number. The
   surrounding screen stays Arabic-first.
2. **A specialty is a property of the clinic that enables screens and fields, never a separate copy
   of the product.** One codebase, one schema, one deploy; a dental clinic is a clinic with the
   dental module switched on.

**What exists today, because it changes the design:** specialty is `doctors.specialty`, free text on
the doctor, and nothing on `tenants` records it. The clinic-level property in rule 2 does not exist
yet, and a polyclinic (dental and dermatology under one roof) means it is a set, not a single value.

### Working rules that protect this timeline

**One phase at a time, no parallel work.** Half-finished phases are how solo projects with limited hours die.

**Nothing is added mid-phase.** Requests from pilot clinics go into a log and are triaged between phases, never during. Pilot clinics reliably ask for their old paper workflow reproduced on screen; agreeing is how the product becomes a worse version of the notebook.

**Batch review.** Rather than reviewing continuously, the product owner reviews at defined checkpoints within each phase. This matches the owner's stated preference and suits limited evening hours far better than constant context switching.

**A slipping phase cuts scope, not quality.** If Phase 4 runs long, the public booking page goes first, then prescription A4 layout, then attachment inline preview. Tests are never the thing that gets cut.

### Parallel non-engineering track — starts now, not later

PDPL enforcement begins **31 October 2026**, before this product reaches pilot. These run alongside development and are not on the critical path of any phase, but they are on the critical path of the business:

1. PDPC licence/permit application
2. DPO appointment
3. Data Processing Agreement drafted and reviewed
4. Egyptian entity decision, or local representative appointed
5. Hosting provider selected and contracted
6. One real doctor validates the typing-during-consultation assumption — **before Phase 4 starts**
7. **Prescription language and mandatory content** — does Egyptian regulation require prescriptions to be in Arabic, and does it mandate particular fields (prescriber licence number, clinic registration)? Unknown to the team and not answerable by engineering judgement. Needed before Phase 4's prescription printing. The schema absorbs either answer — `SCHEMA-DECISIONS.md` D20 makes document language a tenant setting defaulting to Arabic, so "Arabic is mandatory" becomes a changed default and a removed option rather than a rewrite — but the answer determines whether the option may exist at all.

Item 6 is free, takes one conversation, and can invalidate three weeks of work if skipped.

---

## 21. Risks & Assumptions

### Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Clinics revert to paper after week two | Fatal to the thesis | Weekly on-site observation during pilot; measure actual usage, not stated satisfaction |
| Reception staff turnover erases training | High | The 10-minute-competence bar is a hard requirement, not an aspiration |
| PDPL licensing delays commercial launch | High | Start the legal track now, in parallel |
| Meta pricing change (1 Oct 2026) breaks unit economics | High | Model costs before building Phase 6; utility-only template policy |
| Egypt hosting reliability below expectation | Medium | Evaluate providers during Phase 1; keep deployment provider-agnostic |
| Slot engine edge cases in production | Medium | Exhaustive tests; every production bug becomes a permanent regression test |
| Scope creep from pilot clinic requests | High | Log every request; change nothing mid-phase. Pilot clinics always ask for their old workflow back |

### Assumptions requiring confirmation

1. Pilot clinics are single-doctor or small multi-doctor outpatient practices in Egypt.
2. Reception has a desktop or tablet with reliable internet during clinic hours.
3. Doctors are willing to type notes during consultation — **the single largest adoption risk.** ⚠️ If they will not, the visit screen needs rethinking (voice, or a reception-assisted model) before Phase 4.
4. Printed prescriptions are acceptable; no legally recognised e-prescription signature is required in the pilot.
5. Pilot clinics are not charged, so no billing infrastructure is needed yet.
6. Arabic is the default interface language; English is secondary.

---

## Decisions Requiring Product Owner Approval

| # | Decision | Status |
|---|---|---|
| 1 | Clinical **content** restricted to the authoring doctor's role | ✅ **Approved** |
| 2 | Clinical **metadata** (visit dates, follow-ups, payments) visible to owner, admin, and reception | ✅ **Approved** |
| 3 | RLS transaction strategy (§6) — clinical reads routed through explicit transactions | Proceeding with recommendation; revisit if latency measurable |
| 4 | MFA deferred past the pilot (§7) | Proceeding; mandatory before commercial launch |
| 5 | Hosting provider (§14) | ⏳ Open — not blocking; needed before real patient data |
| 6 | Doctors typing during consultation (§21) | ⏳ Open — **must be validated before Phase 4** |
| 7 | Pilot clinic count and selection | ⏳ Open — recommend 3–5, mixed single- and multi-doctor |

Items 5–7 do not block Phase 1. Item 6 is the only one that can force a redesign, and it has three phases of runway.

---

*Document version 0.4 — 19 August 2026. Adds §4b (treatment plans, payment confirmation, prescription tokens, usage metering, message bundling). Phase 1 cleared to begin.*
