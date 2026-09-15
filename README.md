# Clinic OS

Multi-tenant SaaS for small outpatient clinics in Egypt. Replaces the paper appointment book, the WhatsApp thread, the paper patient file, and the Excel accounting sheet with one system. Patients install nothing.

Arabic-first and RTL by default; English secondary.

> **Status: Phase 1 (Foundation), in progress.** The database schema, authentication and tenant-isolation layers are built and tested. There is no clinic-facing UI yet — `apps/web` does not exist. The API currently serves exactly one route, `GET /health`.

---

## Setup

**→ [`docs/SETUP.md`](docs/SETUP.md)** — fresh clone to a green test suite, in ten steps.

Read it rather than improvising. Two steps are genuinely manual and are not covered by any script:

- creating **both** `.env` files from their `.env.example` templates, with passwords that match across them, and
- migrating the **dev** database by hand — the test database migrates itself.

There is also one trap worth knowing before you start: `clinic_os_app` is a cluster-wide Postgres role created **without** a password, and the only thing in the repo that ever sets it is the integration suite's `globalSetup`. Until you have run the tests once, the application cannot connect to the dev database. `SETUP.md` §6 explains it.

The short version, once the `.env` files exist:

```bash
docker compose up -d
cd apps/api
npm ci
npx prisma generate
npx prisma migrate deploy
npm test && npm run test:integration
npm run seed
```

Green means **134 unit** and **52 integration** tests passing.

`npm run seed` then fills the dev database with two clinics, 8 staff memberships across 7 people covering every role (one of them a doctor working in both clinics, so the clinic switcher is exercised by the seed rather than only by tests), 200 patients with Egyptian Arabic names, and three months of appointments, visits and payments. Sign in with any seeded phone number and the password `dev-only-not-a-real-password` (named so it cannot be mistaken for a leaked credential). Re-running it is safe — it detects existing data and stops.

---

## Layout

```
apps/api/     NestJS + Prisma backend
apps/web/     React + Vite frontend — not created yet
docker/       Postgres init scripts
docs/         Architecture, schema decisions, phase plans
```

There is no root `package.json` and no npm workspace; all Node commands run from `apps/api`.

## Documentation

| | |
|---|---|
| [`docs/SETUP.md`](docs/SETUP.md) | Getting it running on a new machine |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Standing up a server — containers, TLS, backups, restore drills |
| [`CLAUDE.md`](CLAUDE.md) | Working agreement, locked decisions, rules that are never broken |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Full design, schema, state machines, security model |
| [`docs/SCHEMA-DECISIONS.md`](docs/SCHEMA-DECISIONS.md) | Numbered record of every schema decision and why |
| [`docs/PHASE-1.md`](docs/PHASE-1.md) | Current phase scope and Definition of Done |
| [`docs/PRICING.md`](docs/PRICING.md) | Commercial model (context, not implementation) |

## Two rules worth knowing before reading any code

**The application never connects as the `DATABASE_URL` superuser.** That role bypasses Row-Level Security, which would silently turn every isolation policy into a no-op. Application code connects as `clinic_os_app` via `APP_DATABASE_URL`.

**A cross-tenant request returns 404, never 403.** A 403 confirms the record exists.

The rest are in [`CLAUDE.md`](CLAUDE.md).

## Tests

```bash
cd apps/api
npm test                             # unit
npm run test:integration             # integration (needs Docker running)
npm run test:no-dotenv               # unit, in CI's exact environment
npm run test:integration:no-dotenv   # integration, in CI's exact environment
```

CI runs typecheck → unit → integration → build on every push to `develop`, `feature/**` and `fix/**`, and on pull requests into `develop`. Changes reach `develop` through a PR whose CI has already passed — see CLAUDE.md. (`PHASE-1.md` also calls for a lint stage; ESLint is not set up yet, so CI has none.)

---

Licensed privately. All rights reserved.
