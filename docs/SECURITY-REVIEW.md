# Security review — the OWASP Top 10, walked

Pilot-readiness 4a. Each of the ten, with **the mechanism that answers it and the test or policy that
proves the mechanism is live**. An item nobody can point a test at is listed as unanswered rather
than reasoned away — the unanswered ones are the value of this document.

Dated 2026-09-19, against `develop`. It is a snapshot of *mechanisms*, not of status: every citation
below is a file that exists in this repository, and `test/unit/security-review-citations.spec.ts`
fails the build when one stops existing.

**Scope.** The API and its database. The WhatsApp bot's own conversation layer is somebody else's
repository and is governed by `docs/WHATSAPP-BOT-CONTRACT.md` §9, not by this walk.

---

## A01 — Broken access control

**Three independent layers, and the third does not trust the first two.**

1. `tenantId` comes only from a validated JWT claim — never a body, a query string or a header
   (`CLAUDE.md`). `TenantGuard` refuses a request whose body carries one.
2. The Prisma tenant extension injects `where.tenantId` on every scoped model, from
   `tenantContext`, and throws on a caller-supplied mismatch rather than silently overwriting it.
3. **Postgres row-level security** with `FORCE ROW LEVEL SECURITY` on 46 tables: the application
   role is subject to the policy, so a query that escaped both layers above still returns nothing.

Capabilities are a matrix, not a role check: `apps/api/src/common/permissions.ts`, enforced by
`PermissionGuard` on every route. A cross-tenant read answers **404, not 403** — a 403 confirms the
row exists.

| Proved by | What it drives |
|---|---|
| `apps/api/test/integration/tenant-isolation-invariants.integration.spec.ts` | the three layers, each on its own |
| `apps/api/test/integration/patients-http.integration.spec.ts` | 404 rather than 403, over real HTTP |
| `apps/api/test/integration/audit-logs-rls.integration.spec.ts` | RLS on the audit trail itself |
| `apps/api/test/integration/platform-isolation.integration.spec.ts` | the operator console reads no clinic data — route list derived from the controllers |
| `apps/api/test/unit/patients-capability-boundary.spec.ts` | every read route names a read capability |
| `apps/api/test/unit/route-capability-manifest.spec.ts` | no route is ungoverned by accident |

**Clinical content is doctor-only, and that is a separate boundary**: separate endpoints and separate
DTOs, never a filtered response (`docs/ARCHITECTURE.md` §8). Swept end to end by
`apps/api/test/integration/clinical-leak-guard.integration.spec.ts`, which is the sweep the release
gate runs (§4d below).

---

## A02 — Cryptographic failures

- **Passwords and bot credentials**: Argon2id (`@node-rs/argon2`), never reversible. Proved by
  `apps/api/test/integration/bot-credentials.integration.spec.ts` — the stored value matches
  `/^\$argon2id\$/` and no route returns the secret.
- **Secrets never reach the audit trail**: `audit_user_change()` redacts any `*_secret`, `*_hash` or
  `*_pending_secret` **by pattern**, so a column added later is covered without an edit. Proved by
  `apps/api/test/integration/audit-secret-pattern.integration.spec.ts`, which adds a column the
  function has never heard of.
- **In transit**: Caddy terminates TLS with automatic certificates (`docs/SERVER-SETUP.md` §6); the
  API is not exposed directly.
- **Backups** are age-encrypted before they leave the host, and the private key is deliberately not
  on it by default (`docs/SERVER-SETUP.md` §8, §9).
- **Webhook deliveries** are signed HMAC-SHA256 over `<timestamp>.<body>`
  (`apps/api/src/modules/bot/webhook-signing.ts`), verified by
  `apps/api/test/unit/webhook-event-shape.spec.ts`.
- **No secret in code or Git**: environment variables only, `.env.example` current
  (`CLAUDE.md`), and `apps/api/src/config/server-env.ts` lists what the server must carry.

- **At rest**: the EVS system disk and data volume are created **encrypted**, with the region's
  default KMS key — ruled 2026-09-19 and given its own step, `docs/SERVER-SETUP.md` §1b, because an
  EVS volume cannot be encrypted after it is created. The step ends with the command that reads the
  flag back, and says to rebuild the instance if either answers `false`.

---

## A03 — Injection

- Every query goes through Prisma with bound parameters. Raw SQL is written as tagged templates
  (`prisma.$queryRaw\`…\``), which parameterise; the two places that interpolate a column name do so
  from a constant, never from input.
- DTOs validate at the boundary with `whitelist: true, forbidNonWhitelisted: true`
  (`apps/api/src/common/validation-pipe.ts`), so an unexpected field is **refused**, not stripped —
  which is what stops a body smuggling `tenantId`.
- Arabic text is never normalised into a query key beyond the documented search key (D19), and
  clinical free text is stored byte-identical.

| Proved by | What it drives |
|---|---|
| `apps/api/test/integration/sql-guarantees.integration.spec.ts` | the database's own constraints, exercised |
| `apps/api/test/unit/refusal-codes-conformance.spec.ts` | refusals are codes, never server-composed prose |

---

## A04 — Insecure design

The design decisions that carry security weight are written down and tested, not inferred:

- **Medical and financial records are never hard-deleted** — archive or write a revision
  (`CLAUDE.md`), enforced by append-only triggers on `audit_logs`, `appointment_events`,
  `visit_revisions` and `payment_adjustments`.
- **Money is integer minor units**, never a float.
- **The slot engine is pure** and cannot reach the database, so booking cannot be raced through a
  code path that reads stale state; the exclusion constraint is the arbiter
  (`apps/api/test/integration/booking-concurrency.integration.spec.ts`).
- **The bot is a client of the API, never of the database** — `docs/WHATSAPP-BOT-CONTRACT.md`, with
  its capability set pinned by `apps/api/test/unit/bot-capability-set.spec.ts`.

---

## A05 — Security misconfiguration

- **Two flags that weaken a boundary refuse to run in production**: `OPERATOR_TOTP=off`
  (`apps/api/src/modules/platform/totp-policy.ts`) and `BOT_SANDBOX=on`
  (`apps/api/src/modules/bot/sandbox-policy.ts`). Both assert the refusal *and* the neighbouring
  cases that must not refuse — `apps/api/test/unit/bot-sandbox-policy.spec.ts`,
  `apps/api/src/modules/platform/totp-policy.spec.ts`.
- **The application connects as `clinic_os_app`, never as the migration superuser.** A code path
  reading `DATABASE_URL` is a security bug (`CLAUDE.md`); `apps/api/src/prisma/client.ts` refuses to
  start without `APP_DATABASE_URL`.
- **A missing required environment variable fails before the container serves**:
  `scripts/check-server-compose.mjs` and `apps/api/src/config/server-env.spec.ts`.
- **CORS is off unless an origin list is supplied**, and there is deliberately no wildcard branch
  (`apps/api/src/main.ts`). `TRUST_PROXY` is opt-in, because trusting `X-Forwarded-For` with nothing
  stripping it lets a client forge its own address into the audit trail.
- **A future-dated migration fails the build** (`apps/api/test/unit/migration-timestamps.spec.ts`),
  because ordering that is wrong is worse than ordering that is missing.

---

## A06 — Vulnerable and outdated components

- Dependencies are pinned to exact versions; Prisma's pin is a recorded decision (D10).
- `npm audit fix --force` is **forbidden** — its remediation downgrades Prisma to 6.x and breaks that
  pin. Recorded so the next person does not discover it at 2am.
- `apps/api/test/unit/web-dev-only-packages.spec.ts` keeps development-only packages out of the
  shipped bundle.

- **Dependabot watches four ecosystems** — `apps/api`, `apps/web`, the marketing site, and the
  GitHub Actions this pipeline is built from (`.github/dependabot.yml`). Weekly and grouped: one
  pull request per ecosystem, because a pull request nobody reads is worse than none. The marketing
  entry is written now and starts working when that app lands on `develop` (#115); Dependabot
  ignores a directory it cannot find.
- **A weekly audit job** runs `npm audit --audit-level=high` across the workspaces
  (`.github/workflows/audit.yml`), separate from CI so a new advisory cannot turn an unrelated pull
  request red and teach people to merge past it.

> **The policy, ruled 2026-09-19: a critical advisory is acted on within 7 days, a high one within
> 30.** "Acted on" means bumped, or written down here as accepted with the reason. A scheduled job
> with no deadline attached is a notification, not a policy.

---

## A07 — Identification and authentication failures

- **Rate limits with clinic-safe keys.** Login has two independent buckets — identifier and IP —
  because IP-only locks out a clinic behind one NAT and identifier-only lets a spray through
  (`apps/api/src/modules/auth/auth-throttle.ts`). Write routes are limited per **membership**
  (`apps/api/src/common/write-throttle.ts`).
- **A suspended membership's live token stops on its next request**, because
  `MembershipFreshnessInterceptor` re-reads the membership every time. Proved by
  `apps/api/test/integration/membership-freshness.integration.spec.ts`, whose break-first is removing
  the interceptor and watching the token keep working.
- **Refresh tokens rotate, and a reused one revokes the family**
  (`apps/api/test/integration/refresh-tokens.integration.spec.ts`).
- **The operator console requires a second factor**, with recovery codes
  (`apps/api/test/integration/operator-recovery-codes.integration.spec.ts`).
- A rate-limited answer is the same whether or not the account exists, because the key is derived
  from what the caller sent (`apps/api/test/integration/password-throttle.integration.spec.ts`).

---

## A08 — Software and data integrity failures

- **Migrations are hand-written SQL, applied in order, checksummed by Prisma.** Drift is refused
  before a suite runs (`apps/api/test/migration-drift.ts`).
- **Outbound webhooks are signed and idempotent**: the timestamp is inside the signed string, so a
  captured delivery cannot be replayed with a fresh one, and the delivery id is the idempotency key
  across every retry (`apps/api/test/integration/webhook-delivery.integration.spec.ts`).
- **The audit trail is append-only at the database**, not by convention
  (`apps/api/test/integration/audit-triggers.integration.spec.ts`).
- Lockfiles are committed and CI installs with `npm ci`.

- **The built image is compared against CI's record.** The `image-digest` job builds the API image
  for every commit and records its digest as an artefact; `docs/SERVER-SETUP.md` §11 downloads that
  artefact, builds the same image on the server, and `npm run release:gate` **refuses a mismatch** —
  the tag being deployed would not be the artefact CI checked. When either number is missing the gate
  says so rather than refusing, because refusing on a missing file teaches people to delete it.

> **Still open: nothing is signed.** A digest comparison proves the two builds agree, not that either
> is ours. Signing needs a registry and a key, and that is a decision nobody has taken.

---

## A09 — Security logging and monitoring failures

- Every write is audited with the actor, the role, the IP and the user agent bound at the
  transaction (D16), and the trigger **refuses a write with no actor bound** rather than recording an
  anonymous one.
- Reading clinical content writes a `READ_SENSITIVE` row — so "who opened this file" is answerable
  (`apps/api/test/integration/clinical-access.integration.spec.ts`).
- Secrets are redacted by pattern on the way in (A02).
- The host alerts through Cloud Eye and SMN, and the nightly restore drill alerts on failure
  (`docs/SERVER-SETUP.md` §9, §10).

- **Two alarms about people rather than machines**, ruled 2026-09-19 and specified in
  `docs/SERVER-SETUP.md` §10: the **refusal rate** — 401, 403 and 429 together above 30 in five
  minutes, which is guessing, reaching, or a script — and **any** `BREAK_GLASS_ACCESS` row, where
  one is the threshold because that row means somebody reached a patient's record through the
  emergency path. Both are to be fired on purpose before they are trusted.

---

## A10 — Server-side request forgery

The API makes exactly one outbound request on behalf of a tenant: the webhook delivery to the URL a
clinic registered.

- The URL is **HTTPS-only**, enforced by the DTO *and* by a database CHECK constraint. The single
  exception is a loopback address, which the sandbox provisioner sets and which no clinic settings
  route will accept (`apps/api/prisma/migrations/20260918170000_webhook_loopback_url/migration.sql`).
- Only `clinicSettings.manage` can set it, and the act is audited.
- Deliveries carry a ten-second timeout and a bounded retry, so a hostile endpoint cannot hold a
  connection open indefinitely (`apps/api/scripts/webhook-dispatch.ts`).

- **A webhook that resolves inward is refused**, at set time *and* at send time
  (`apps/api/src/modules/bot/webhook-address.ts`). Loopback, link-local — including the cloud
  metadata address — private, carrier-grade NAT and multicast ranges, in IPv4 and IPv6, and **every**
  resolved address is checked rather than the first, which is the shape a rebinding attack takes.
  Twice, because DNS is not a promise: a name that resolved publicly when it was registered can
  resolve to `127.0.0.1` tomorrow.
- The sandbox's loopback receiver survives and stays gated by `BOT_SANDBOX`, which the API refuses
  to boot with under `NODE_ENV=production`.

Proved by `apps/api/test/unit/webhook-address.spec.ts`, and at send time by
`apps/api/test/integration/webhook-delivery.integration.spec.ts`.

---

## 4d — The sweep is a release gate

`npm run release:gate` runs, in order: the **clinical leak sweep**, the compose configuration check,
and the server-environment check. It exits non-zero on the first failure, and it is the first command
of `docs/SERVER-SETUP.md` §11.

It is proven by breaking it rather than by reading it: with a clinical field added to a
reception-facing response, the gate refuses and names the endpoint that leaked.

---

## What this walk is not

It is not a penetration test and does not claim to be. It records which mechanism answers which class
of attack, and where the honest answer is still "nothing does yet".

**Open items: 1.** A08 carries a `Still open` note — nothing is signed, and a digest comparison
proves two builds agree rather than proving either is ours. The five items that were unanswered when
this document was written on 2026-09-19 were closed the same day, and each now cites the mechanism
and the test that answers it.

`test/unit/security-review-citations.spec.ts` keeps that count honest: it fails when the number
stated in this paragraph stops matching the `Still open` notes below it, so an item cannot be closed
by deleting its note.
