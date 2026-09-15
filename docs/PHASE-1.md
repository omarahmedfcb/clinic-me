# Phase 1 — Foundation

**Goal:** a running project with a complete database schema, working authentication, and provably watertight tenant isolation. No clinic features yet.

**Estimate:** 2–3 calendar weeks at 10–15 hrs/week.

**Why the full schema now:** every table in `ARCHITECTURE.md` §4 is created in this phase, including tables for features not built until Phase 4 or later. Adding columns to a database that already holds real patient records is slow and risky; adding them to an empty one is free. Tables may be empty. They may not be missing.

---

## 1. Scope

### Project setup
- Monorepo per `ARCHITECTURE.md` §3
- `docker-compose.yml`: PostgreSQL 16 (with `btree_gist`) + Redis
- TypeScript strict mode, ESLint, Prettier, shared configs
- `.env.example` complete and current
- CI: typecheck → lint → test → build
- Git initialised, `develop` branch, `.gitignore` covering `.env`

### Database
- Complete Prisma schema — every entity in `ARCHITECTURE.md` §4 **and §4b**
- §4b tables are mandatory in this migration: `treatment_plans`, `treatment_plan_sessions`,
  `prescription_access_tokens`, `subscriptions`, `usage_records`, `usage_alerts`,
  and the extended `payments` status/confirmation columns
- Initial migration
- Seed script: 2 tenants, users across all roles, ~200 patients with realistic Arabic names, 3 months of appointments, visits, payments
- Two tenants in the seed is deliberate — isolation cannot be tested with one

### Authentication
- Register (admin-created only, no public signup), login, logout
- Argon2id password hashing
- JWT access token, 15 min, claims `{ sub, membershipId, tenantId, role, permissions }`
- Rotating refresh token, 30 days, `httpOnly; Secure; SameSite=Strict`, hashed at rest
- **Token-reuse detection revokes the whole family**
- `POST /auth/switch-tenant`
- Rate limiting on auth endpoints
- Session revocation by clinic admin

### Tenancy & permissions
- `TenantGuard` populating request-scoped `TenantContext`
- Prisma client extension injecting `tenantId` on all tenant-scoped models
- **Boot-time failure if a model is not registered as scoped or unscoped** — no silent default
- RLS policies on all 29 tenant-scoped tables (SCHEMA-DECISIONS.md D4, extended by D15) — every tenant-scoped table gets Postgres-level enforcement as a second layer, not just the clinically/financially sensitive ones
- RLS on `audit_logs` too (D17), which is not itself tenant-scoped in the registry sense but holds a full copy of every row of those 29 — orphaned (deleted-tenant) rows are reachable only through an audited platform-admin function
- Transaction wrapper setting `app.current_tenant_id`
- `PermissionGuard` + `@RequirePermission()` decorator
- Permission matrix from `ARCHITECTURE.md` §8 as data, not scattered conditionals
- **`Membership.permissionsOverride` is unimplemented by decision, not oversight.** `PermissionGuard` checks the role's base matrix entry only. ARCHITECTURE.md calls it "an override for edge cases" without specifying a shape; the founder will specify one when a real case needs it.

### Audit
- Audit interceptor writing to `audit_logs` on all mutations
- Actor, tenant, action, entity, before/after state, IP, timestamp

### Frontend
- Vite app, routing, Arabic + RTL layout shell
- Login page
- Authenticated shell: sidebar, header, tenant switcher, logout
- Token refresh interceptor
- **Component gallery page** — every design-system primitive (button, input, select, modal, drawer, card, status badge, table, search field, confirm dialog, empty state, spinner) in Arabic RTL on one page

The component gallery is not optional and is not decoration. It is reviewed once so styling problems are found in one sitting rather than rediscovered on twelve screens.

---

## 2. Out of scope

Patients CRUD · doctors · services · schedules · appointments · queue · visits · prescriptions · payments UI · reports · clinic settings screen · users management screen · super admin console · WhatsApp · AI · attachments · MFA · public signup

Tables for these exist. Endpoints and screens do not.

---

## 2b. Notes carried forward to Phase 2

No `PHASE-2.md` exists yet — this section exists so these aren't lost before it does, not to pre-plan Phase 2's scope.

- **The cross-tenant-returns-404-not-403 HTTP mapping.** Proven at the data layer in Phase 1 (`test/integration/tenant-isolation-invariants.integration.spec.ts`: a cross-tenant lookup by id resolves to `null`, never another tenant's record, never an error) — but there is no real resource endpoint yet to demonstrate the actual HTTP status against (Patients CRUD and everything else in §2 is out of scope here). The convention the first real controller must follow: a tenant-scoped lookup returning `null` maps to `NotFoundException` (404); never add a separate ownership check that would produce `ForbiddenException` (403) instead — by the time a controller has the record, RLS and the tenant-scoping extension have already made a cross-tenant record indistinguishable from one that never existed.

---

- **What clinics actually run, and what that means for the PWA.** Clinic staff use a **browser** —
  Chrome or Safari, on Windows, macOS, iPhone or Android. Nothing is installed at a clinic, and
  patients install nothing at all. Linux appears throughout `docs/DEPLOY.md` because it is the
  *server's* operating system; no clinic ever sees it. Reception is typically a Windows desktop;
  the founder expects doctors on **iPhone first**, Android later.

  **No install prompt will ever appear on iPhone, and that is Apple's decision, not a gap in our
  work.** Safari does not implement `beforeinstallprompt` — there is no event to intercept and no
  button we can render that triggers installation. On iOS the user taps **Share → Add to Home
  Screen**, by hand. On Android Chrome the prompt does fire and can be handled normally, so the two
  platforms will behave differently forever and no amount of engineering closes that.

  **So iPhone installation is an onboarding and training step, not an engineering one.** It belongs
  on the pilot onboarding checklist — a person showing a doctor the three taps, once — alongside
  the WhatsApp number connection. Treating it as a bug to be fixed later would mean waiting for
  something that is never going to arrive.

  **The manifest still matters on iOS, even with no prompt.** Once a page is added to the home
  screen, the manifest controls the icon, the short name under it, and whether it opens standalone
  or inside browser chrome. Without one, a doctor gets a screenshot-thumbnail icon, the `<title>`
  as a label, and Safari's address bar on every launch — which reads as "a bookmark", not "an app".

  **We deliberately have neither a manifest nor a service worker today**, and the reason is the
  service worker rather than the manifest. **A service worker can serve stale application code**,
  and in a clinical system that is a design decision rather than a plugin default: a cached bundle
  from before a fix means a doctor sees old behaviour with no indication that they are looking at
  yesterday's build. Adding one requires deciding the cache strategy first — what may be served
  stale, what must never be, and how a client is forced forward — and that is a Phase 2+ decision
  with a review, not a `vite-plugin-pwa` line. The manifest alone is small and could ship earlier;
  it just buys little on its own until installation is part of onboarding.

- **The super admin console is deferred on purpose, and this is the decision rather than the
  omission.** It appears in §2's out-of-scope list, which reads like everything else there —
  something that has not been reached yet. It is not: it is something we have decided not to build
  for a while, for reasons that will still hold when somebody next asks.

  **Tenant creation stays a script until there are more than ten clinics.** ARCHITECTURE.md §18
  already says so ("create tenants with a script until there are more than ten"); restating it here
  is to make it read as a choice. Ten clinics is perhaps twenty minutes of running a script in
  total, against a screen that needs a form, validation, an audit path and a review. The script is
  also the safer instrument while the shape of a tenant is still moving.

  **The console's real job is subscription state** — who is trialling, who is active, who is past
  due, and what plan limits apply. `subscriptions`, `usage_records`, `usage_alerts` and `invoices`
  all exist and are all empty (PHASE-1 §1 creates them deliberately). **A console built today would
  show two clinics and a create button**, which is a screen that looks like a product and answers no
  question anybody has.

  **It is scheduled after Phase 5, not before.** It serves the founder; the clinic-facing work
  serves the customer, and the customer is what stands between this and a pilot. Building the
  founder's dashboard before the clinic's queue board is the kind of ordering that feels productive
  and delays revenue.

  **Two things it must have on the day it is built**, from ARCHITECTURE.md §6's Super Admin
  isolation — both are stricter than "we will be careful":

  1. **A platform admin has no read access to clinical data at all.** Not "should not" — does not.
     Metadata, subscription state and aggregate usage are unrestricted; patient records never are.

     **Amended 2026-09-14, and the amendment is a closing rather than a loosening.** This paragraph
     used to describe a door: reaching clinical data required an `access_grants` row carrying a
     written reason and an expiry of at most 24 hours, an `audit_logs` entry at grant time *and on
     every subsequent clinical read*, and notification to the clinic owner. **The founder ruled that
     door SHUT, not unbuilt** — there is no grant path, and there is no impersonation.

     The distinction is the point. An *unbuilt* door invites the next person to build it, and they
     would be implementing a design this document had already blessed. A *shut* one does not.
     `AccessGrant` stays in the schema as a table nothing writes, and this paragraph is the record of
     why — so that finding an unused table is not read as finding an unfinished feature.

     What this buys is the sentence below, sayable without qualification.
  2. **`BREAK_GLASS_ACCESS` already exists in `AuditAction` and is still emitted by nothing.** It
     was added for exactly this and remains unused, which is the correct state today and would be a
     defect the moment a support path exists without it. The same applies to D21's platform-admin
     password recovery, which is the other user of that action.

  Both belong to a broader property the founder needs to be able to state honestly in a sales or
  PDPL conversation: **our staff cannot read your records.** A console that quietly makes that false
  is a worse outcome than not having a console.

- **Any route granted at `"own"` ships with a test that the QUERY is scoped, not that the guard
  allowed the request.** `@RequirePermission(capability, "own")` is an authorisation *floor*: it
  decides whether the request may proceed, and it structurally cannot know which rows belong to the
  caller. `PermissionGuard` reads a role from a token; it has never seen a `doctorId`.

  So a doctor granted `"own"` access to schedules passes the guard for *every* schedule in the
  tenant, and only the route's own `where` clause stops them reading a colleague's. If that clause
  is missing, every test still passes: the guard allows the request because it is supposed to, the
  response is a 200 because nothing errored, and the rows are somebody else's.

  The assertion must therefore be **"the query returns nothing"**, not "the guard rejects". Two
  actors, each with their own rows, and actor A's request for actor B's data comes back empty --
  the same shape as `tenant-isolation-invariants.integration.spec.ts` uses one level up. Recorded
  here now, while the reasoning is fresh, because the first such route does not exist yet: this is a
  note for whoever writes it in Phase 2, and a comment on the decorator is the weakest guard this
  project has used.

## 3. Endpoints

```
POST   /auth/login
POST   /auth/refresh
POST   /auth/logout
POST   /auth/switch-tenant
GET    /auth/me
POST   /users              (admin only)
GET    /users              (admin only)
PATCH  /users/:id/status   (admin only)
GET    /tenants/current
PATCH  /tenants/current    (owner/admin only)
GET    /health
```

---

## 4. Required tests

**Tenant isolation — blocks the phase if red**
- Every tenant-scoped endpoint: a token for tenant A requesting a tenant B record returns 404
- Prisma extension injects `tenantId` on create, findMany, findUnique, update, delete
- A model missing from the scoping registry fails at boot
- RLS blocks a direct query with the wrong session variable set

**Auth**
- Login success and failure
- Expired access token rejected
- Refresh rotation issues a new pair
- **Reusing a consumed refresh token revokes the family**
- Rate limit triggers on repeated failures
- Tenant switch requires a valid membership; a revoked membership fails

**Permissions**
- Table-driven: one case per role × capability cell in `ARCHITECTURE.md` §8

**Audit**
- A mutation writes an audit row with correct before/after state

---

## 5. Definition of Done

Phase 1 is complete when **all** of these are true. Not most.

- [ ] `docker compose up` then one command starts API and web from a clean clone — **still false, and now for a different reason than before.** `apps/web` exists, and `docker-compose.server.yml` does start Postgres, migrations, the API and Caddy-serving-the-SPA together. But it is **not one command**: the first `up` is *expected* to fail, because `clinic_os_app` is created by migration with no password (D12/D13) and nothing sets one — so the API cannot authenticate, its health check fails, and Compose reports `dependency failed to start`. `docs/DEPLOY.md` §3 documents that as the normal path rather than a fault. Closing this item honestly means either a first-run provisioning step inside the compose flow, or accepting that the item as written describes something we chose not to build.
- [x] `npm test` passes with zero skipped tests — **228 unit + 113 integration, 0 skipped.** The auth, permissions and audit specs the earlier note said did not exist now do. Both suites also pass with `.env` stripped (`npm run test:no-dotenv`, `npm run test:integration:no-dotenv`), which is what proves they do not depend on a file CI does not have.
- [x] CI green on `develop` — workflow written (`.github/workflows/ci.yml`) and running on GitHub Actions against the real repo. **The earlier claim here that the pipeline had been "verified locally (env-vars-only, no `.env`, matching CI exactly)" was not accurate and has been removed.** That local verification still had `apps/api/.env` loaded via `dotenv/config` in `test/integration/setup-env.ts`, so it could not have caught a variable the workflow fails to set — and it didn't: the first three Actions runs failed on exactly that class of gap (an incomplete lockfile, then a missing `JWT_SECRET`). The claim is now a command rather than an assertion: `npm run test:integration:no-dotenv` (`apps/api/scripts/run-without-dotenv.mjs`) strips every `.env`-declared variable from the environment, blocks `dotenv` from loading the file at all, and puts back only the variables `ci.yml` provides. It reproduced the `JWT_SECRET` failure locally, identically to CI. Run it before pushing a change that touches environment handling.
  **Closed 2026-08-27.** CI has been green on every merge to `develop`, and since 2026-08-25 it runs on *every* branch push, not only `develop` — the earlier trigger could only report after the shared branch already carried a change, which is a report rather than a gate. It now also runs `npm run seed` against a real migrated database as its last step, after a migration broke the seed and nothing noticed for a day.
- [x] Seed produces 2 tenants with realistic Arabic data — `npm run seed` (`apps/api/prisma/seed/`). Two clinics, 7 staff across OWNER/ADMIN/DOCTOR/RECEPTIONIST, 200 patients with Egyptian Arabic names — 45 of them (22.5%) also carrying an English name, the rest NULL, which is the ratio a real Egyptian clinic has — 1,234 appointments over three months of history plus two upcoming weeks, 736 visits and 736 payments. Every tenant-scoped row is written through `withTenant()` as the seeded system actor — there is no seed-only bypass, and none was needed. Re-runnable (it detects existing clinics and stops). One doctor holds memberships in both clinics, which is what the tenant-switcher item below needs.

  **On the counts, and on "deterministic".** This line read 731 visits and payments until 2026-08-25.
  A first correction that day changed it to 720 and explained it as a figure that had drifted at some
  earlier commit — that explanation was wrong, and the real one is worse. The seed had a fixed PRNG
  seed but also read the wall clock, in two places that both feed the data: the 104-day window is
  relative to "now", so which days inside it are working days depends on what weekday a run starts on,
  and an appointment is past or future depending on the instant it is compared against. **The seed
  produced different data on different days and always had.** Fixed by pinning `SEED_REFERENCE_DATE`
  (`apps/api/prisma/seed/blueprint.ts`); `apps/api/test/unit/seed-determinism.spec.ts` fails if the seed
  reads the clock again, and separately fails if the reference date ever stops changing the output.

  **730** is the figure at the pinned reference date `2026-08-25T09:00:00Z` — 532 in the Nile clinic,
  198 in Shifa. Verified by seeding two throwaway databases from scratch and comparing MD5 content
  digests of appointments, patients and payments, not just row counts: identical across both runs.
  **This number changes if `SEED_REFERENCE_DATE` is bumped, and it must be re-measured in the same
  commit.**

  It read 721 for the length of one pull request. Adding `full_name_en` costs one extra PRNG draw
  per patient, which shifts the whole downstream stream — so appointments moved 1,213 → 1,224 and
  visits 721 → 730 without a single line of appointment logic changing. That is the pinned seed
  working as intended, not a regression: any change to what is generated, or to the order it is
  generated in, moves these numbers. **Re-measure them in the same commit rather than carrying the
  previous figure forward** — carrying it forward is how this line came to claim 731 for months.

  It happened again on 2026-09-03, and the rule above is what made it cheap. Adding a seeded
  `CONSULTATION` service — one line in the blueprint, to close the gap where a live enum value had
  no rows exercising it — changed the modulus of the per-appointment service draw, and with it the
  durations that decide where a doctor's shift runs out. Appointments moved **1,224 → 1,234**,
  visits and payments **730 → 736**, `audit_logs` **5,469 → 5,527**. No appointment logic changed.
  Re-measured against two independently seeded throwaway databases whose content digests were
  identical, so the new numbers are deterministic in the same way the old ones were.

  Determinism means the *shape* of the world — how many appointments, on which days, in which state,
  for which patient and doctor — not byte-identical databases. Row ids are UUIDv7 (D6), which encodes
  a timestamp plus randomness, so they differ on every run by design. Making them reproducible was not
  attempted: nothing needs it, and it would mean a second id scheme alongside the one D6 mandates.
- [ ] Founder can log in as each role and see the correct shell — **the only item left that nobody but the founder can tick.** The shell exists and the four roles genuinely differ: `test/unit/shell-navigation.spec.ts` asserts the sidebar against the §8 matrix (reception sees Payments and not Visits; the doctor the reverse, which is CLAUDE.md's doctor-only rule), and all four seeded accounts were exercised through the API. What has not happened is the founder sitting in front of it as each role. That is the whole point of the item — frontend correctness requires his eyes — so it stays open until he does it, not because anything is known to be wrong.
- [x] Tenant switcher works for a user with two memberships — دينا كريم القاضي (`+201001234567`) holds memberships in both seeded clinics. Exercised end to end through the browser's own path: `/auth/me` reports عيادة النيل لطب الأسرة before the switch and مركز الشفاء للجلدية والتجميل after it. The header reads that value, so if the clinic name does not change the switch did not happen.
- [x] Cross-tenant access returns 404 — **verified manually, not only by test.** Deliberately still open, and it is the *404* half that is missing, not the manual half. See the two parts below.
  - [x] **Manual verification at the data layer — done 2026-08-23, against seeded data.** Connected with `psql` as `clinic_os_app` (confirmed `rolsuper = f`, `rolbypassrls = f`), bound `app.current_tenant_id` to clinic A, and went after clinic B's real seeded rows by their actual ids. Control first: bound to B, all three ids resolve — so the ids are genuine, and a later empty result cannot be a typo. Then, from inside A: reading B's patient, appointment and visit each returned **0 rows**; counting B's rows by `tenant_id` returned **0 / 0 / 0** while A's own 120 patients stayed visible; `UPDATE` on B's patient and on B's visit diagnosis returned **UPDATE 0**; `DELETE` of B's patient and of all 315 of B's appointments returned **DELETE 0**; and `INSERT` of a patient carrying B's `tenant_id` was refused outright with `new row violates row-level security policy for table "patients"`. Re-checked afterwards as the superuser: B's patient name, B's diagnosis and all 315 appointments unchanged, zero planted rows. A session with **no** tenant bound sees 0 patients, 0 appointments, 0 visits — it fails closed, not open.
  - [x] **The HTTP 404 itself — CLOSED 2026-08-27, by the first patients controller.** Proven over real HTTP in `test/integration/patients-http.integration.spec.ts`: a request for another tenant's real patient and a request for a UUID that never existed return **identical** responses — same status, same body — and no route in the surface returns 403. There is no ownership check in the controller, because writing one would first require reading a row the caller is not entitled to see. Verified by breaking it: swapping the `NotFoundException` for a `ForbiddenException` fails two tests. The original note follows, kept because its reasoning is what the implementation had to satisfy.

  - [ ] **The HTTP 404 itself — closing in Phase 2, first patients controller.** This is the last thing carried out of Phase 1 into Phase 2, and it is deliberately the *first* requirement on the patients backend rather than something to retrofit: the convention in §2b (a tenant-scoped lookup returning `null` maps to `NotFoundException`, never a separate ownership check producing `ForbiddenException`) has to be in the first controller that could get it wrong, proven over real HTTP. Original note follows.

  - [ ] **The HTTP 404 itself — cannot be verified yet.** There is no controller to verify it against: the API serves only `GET /health`, and Patients/appointments/visits CRUD is explicitly out of scope for Phase 1 (§2). The behaviour proven above is the necessary foundation — a cross-tenant row is *indistinguishable from one that never existed*, which is exactly what makes 404 the truthful status and 403 impossible to return by accident — but "returns 404" is a statement about an HTTP response, and there is no HTTP response to observe. Ticking this now would record a claim nobody has seen. It stays open until Phase 2's first real resource controller exists, at which point §2b's convention applies: a tenant-scoped lookup returning `null` maps to `NotFoundException`, never a separate ownership check producing `ForbiddenException`.
- [x] A test asserts the runtime connection role has `rolsuper = false` and `rolbypassrls = false` — `connection-security.integration.spec.ts`
- [x] Every RLS isolation test connects as `clinic_os_app`, not `clinic_os` — enforced structurally: `test/integration/setup-env.ts` overrides `APP_DATABASE_URL` before any spec imports `client.ts`
- [x] A deliberately wrong database password is REJECTED — `connection-security.integration.spec.ts`
- [x] Component gallery reviewed and RTL issues fixed — reviewed by the founder; two real bugs came out of it and were fixed (the `Select` chevron on a hardcoded physical side, and a minor-unit exponent derived from a hardcoded 100 rather than from the currency). `test/unit/web-logical-properties.spec.ts` now fails the build on any physical `left`/`right` in `apps/web`, because that class of bug is *accidentally correct* while direction is frozen and only appears in the language nobody was testing.
- [x] `.env.example` matches every variable the code reads
- [x] No secret in Git history — checked against every real credential generated this session, zero matches
- [x] Setup is documented and reproducible on a machine that has never seen the project — `docs/SETUP.md`, linked from `README.md`. Ten numbered steps, rehearsed end to end on 2026-08-23 against commit `a3aaf1e` from a fresh clone, an empty Postgres volume and no `.env` files; four items it could not exercise on this machine are marked UNVERIFIED in §9 rather than presented as tested. Ticked for the documentation itself, which exists and has been rehearsed; **independent validation — someone else running it on a second machine — is still outstanding**, and if it fails this box comes back off. Written as `docs/SETUP.md` rather than inside `README.md` because it outgrew a readme section; `README.md` is the short front door that points at it.
- [x] Every table in §4 AND §4b exists in the migration
- [x] Commits are small and logical, not one large commit

---

## 5b. Known loose ends — real, not blocking

Recorded here rather than silenced. A suppressed problem and an undocumented one decay the same way: the next reader cannot tell either apart from "working fine."

### Jest does not exit cleanly after the integration suite

`npm run test:integration` prints `Jest did not exit one second after the test run has completed` after all 52 tests pass. That means a handle is still open — most likely a Prisma connection a spec never closed. The suite passes and the process does eventually exit, locally and on CI.

**Untriaged.** Nobody has yet run `--detectOpenHandles` to find which connection leaks.

**Not fixed with `forceExit`, deliberately.** That flag would delete the warning without closing the connection, turning the only evidence of a real leak into silence. The warning stays loud until someone closes the handle.

**Escalation condition:** if this ever hangs a CI run to its job timeout, it stops being a loose end and becomes urgent. Until then it costs nothing but noise.

### ESLint is blocked upstream by TypeScript 7

§1 lists ESLint and Prettier in scope, and §5's CI line describes a lint stage. Neither exists: there is no ESLint config, no `lint` script, and no lint step in `ci.yml`.

This was attempted on 2026-08-23 and **could not be done**. It is not a matter of effort or of writing the config — that part was finished. `typescript-eslint` refuses to load at all against this project's TypeScript:

```
Error: typescript-eslint does not support TS 7.0.
```

That is a deliberate runtime guard in the package, not a peer-dependency warning to be waved through with `--legacy-peer-deps` (which was tried: the install succeeds, then ESLint dies on the first run). `typescript@7.0.2` is the current stable release and is what this project pins; every published `typescript-eslint`, including its canary channel, declares `typescript ">=4.8.4 <6.1.0"`. Upstream tracks TS 7 support in typescript-eslint issue **#10940**.

Without `typescript-eslint` there is no usable TypeScript parser for ESLint, so a partial "lint the JavaScript only" step would cover nothing.

**Decision (2026-08-23): wait for upstream. Option 1 below. Do not re-litigate this.**

The founder's reasoning, recorded so the same three options are not weighed again in three weeks:

> Option 2 adds permanent complexity for a temporary problem. Option 3 gives up `no-floating-promises`, which is the one rule that matters here — it's what catches an unawaited `withTenant()`.

So ESLint stays out until `typescript-eslint` ships TypeScript 7 support (issue #10940), at which point it is a small, self-contained task: the flat config written during the attempt was correct, and the codebase is still small. **Revisit when #10940 closes** — not before, and not by reopening the choice between these three.

Until then this is a known, accepted gap, not an oversight: `npm run typecheck` and the test suites are what stand in for it, and neither can catch a floating promise.

---

The three options as they were assessed, for whoever reads #10940's resolution:

1. **Wait for upstream.** Costs nothing, no date. The codebase stays small enough that adding a linter later is still cheap.
2. **Install TypeScript 6 side by side, for the linter only.** Microsoft's own documented path for this exact situation. Puts two TypeScript versions in the tree — the build and typecheck stay on 7, ESLint reads 6.
3. **Use a linter that does not depend on the TypeScript compiler** (oxlint, Biome). Works today and is fast, but gives up type-aware rules — which is most of the value here, since `no-floating-promises` is what would catch an unawaited `withTenant()` silently skipping a tenant-scoped write.

Recorded rather than left as a silent gap in §1. The install was reverted and the lockfile restored, so `npm ci` remains clean.

---

## 6. Checkpoints

Stop and wait for review at each:

1. **Schema** — Prisma schema and migration, before any service code
2. **Auth + tenancy backend** — with tests passing
3. **Component gallery** — before any real screen is built
4. **Login and shell** — end of phase

---

## 7. Open question to resolve during this phase

Before Phase 4 begins, one real doctor must confirm he will type clinical notes during a consultation. This costs one conversation and can invalidate three weeks of Phase 4 work. Phase 1 is the right time to ask, because nothing depends on the answer yet.

---

## 8. Phase 1 closing summary — 2026-08-27

### What shipped

**Database.** All 35 tables from ARCHITECTURE.md §4 and §4b, in 13 migrations. RLS on 30 tables,
33 append-only and audit triggers, 2 Postgres `GENERATED` columns, UUIDv7 ids with no `@default`,
money as integer minor units throughout.

**Tenant isolation, in three independent layers.** A Prisma client extension injecting `tenantId`
from request context; Postgres RLS reading a session variable the extension knows nothing about;
and a model registry that fails at boot if a model is classified as neither scoped nor unscoped.
Verified by hand against seeded data with `psql` as `clinic_os_app`, and by
`tenant-isolation-invariants.integration.spec.ts`.

**Audit as a database guarantee (D16/D17).** Triggers, not an interceptor, so a write leaves a
trail whether or not it came through the application. `audit_logs` carries its own RLS.

**Auth.** Five endpoints, Argon2id, rotating refresh tokens with family revocation on reuse, JWT
with permissions derived at the guard rather than carried in the token, and rate limiting in two
independent buckets — per identifier and per IP, because either alone fails.

**Frontend.** Component gallery, login screen, authenticated shell with tenant switcher, Arabic
RTL throughout with English on the two screens that carry the language toggle.

**Deployment artefacts.** Multi-stage Dockerfiles with a separate migrator image, a server compose
file, Caddy for TLS and same-origin proxying, and `docs/DEPLOY.md` as a contractor brief.

**341 tests** (228 unit, 113 integration), zero skipped, green on CI on every branch push.

### The honest part: what has only ever run on two Windows machines

Everything above was built and verified on Windows, against Docker Desktop, in Chrome. That is one
operating system, one container runtime, and one browser engine. The following are **marked done and
have never run anywhere else**:

| Marked done | Never actually run on |
|---|---|
| `docs/SETUP.md`, "reproducible on a machine that has never seen the project" | A non-Windows machine. Rehearsed twice, both times on Windows |
| The three Docker images | A Linux host. Built and run only on Docker Desktop for Windows |
| The server compose stack, `/health` through Caddy | A real server, a real hostname, or a real certificate. `SITE_ADDRESS=:80`, no TLS ever obtained |
| The restore drill (§7 of DEPLOY.md) | A cron schedule. Run by hand, once, on a laptop |
| The whole frontend | Safari, any iPhone, any Android device. Chrome on Windows only |
| The Arabic RTL layout | Any WebKit browser. Blink only |

**Two of those are load-bearing for the pilot.** The founder expects doctors on iPhone, and no line
of this application has been rendered by WebKit. And a deployment brief that has never met a Linux
host is a document, not a procedure — DEPLOY.md's own status table says so, row by row.

Nothing here is known to be broken. The point is that "done" in this phase means "done on Windows,
in Chrome", and the next phase should not inherit the assumption that it means more than that.

### Carried into Phase 2

1. **The cross-tenant 404 over HTTP** — the last open DoD item with a technical cause. §2b's
   convention lands in the first patients controller.
2. **`own`-scoped routes ship with a test that the query is scoped**, not that the guard allowed
   the request. The guard has never seen a `doctorId`.
3. **ESLint**, still blocked upstream on TypeScript 7 (typescript-eslint #10940).
4. **Jest does not exit cleanly** after the integration suite. Still untriaged.
5. **The super admin console**, deferred after Phase 5, for recorded reasons.
6. **PWA manifest and service worker**, deliberately absent; no install prompt will ever exist on
   iPhone.
7. **D21 password reset**, designed and approved, not built — needs Redis and an approved WhatsApp
   template.
8. **Hosting provider**, still ARCHITECTURE.md §14's open decision, waiting on quotes.
