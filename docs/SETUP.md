# Setup — fresh clone to a green test suite

For a machine that has never seen this project. End state: `497` unit tests and `198` integration tests, the demo data loaded, and the web app running in a browser. (The pair has been stale twice — `134`/`52` until 2026-08-25, then `228`/`127` until 2026-09-01. If they disagree with what you see, trust your run and correct this line.)

**One of those 198 does not reliably pass, and it is not your machine's fault.** `throttle-isolation.integration.spec.ts` sends 61 sequential login attempts — one past the per-IP limit of 60 — each of which bcrypt-verifies a password, against Jest's default 5000 ms per-test timeout. It passes on CI and times out on a slower machine. Reported as an open question rather than quietly retimed, because the test itself is sound and only its budget is wrong.

**This whole document was rehearsed end to end**, on 2026-08-23, against commit `a3aaf1e`: a fresh `git clone` into an empty directory, a brand-new Postgres volume, no `.env` files of any kind. Every command below is one that actually ran. The two places it can go wrong on you are called out in **Step 5** and **Step 6** — read those two before you start, not after they bite.

**Re-run on a genuinely second machine on 2026-08-24**, on Node 26 with empty volumes, which is what caught §9: the frontend had landed two commits after the original rehearsal and this document still said it did not exist. Steps 1–8 held exactly as written.

What is *not* rehearsed is marked **[UNVERIFIED]** and explained in §11.

---

## 1. Before you start

| | |
|---|---|
| **Node** | 24 or newer. Verified on 24.13.0 and on 26.0.0; CI uses 24. `.nvmrc` at the repo root selects 24 for version managers, and both `package.json` files declare `"engines": { "node": ">=24" }`. Each tree also sets `engine-strict=true` in its `.npmrc`, so **`npm ci` refuses to install on an older Node** rather than warning and continuing. |
| **npm** | **Exactly 11.19.0.** Pinned as `"engines": { "npm": "11.19.0" }` in both `package.json` files, and `engine-strict=true` makes it a hard stop — `npm ci` refuses on any other version. If yours differs: `npm i -g npm@11.19.0`. Unlike Node, which is a floor, this is an exact pin: the resolver version itself is what varies, and npm 11.12.1 and 11.19.0 rewrite `package-lock.json`'s peer bookkeeping differently. That diff looks like a dependency change and is not one. |
| **Docker Desktop** | Running, with virtualisation enabled. See §2. |
| **git** | Any recent version. |

You do **not** need Postgres, Redis, or `psql` installed on the host. Both databases run in containers, and every `psql` command in this document runs *inside* the container via `docker exec`.

---

## 2. Docker Desktop and virtualisation

Postgres and Redis run as containers, so Docker Desktop must be running **before** Step 4 — not just installed. Its whale icon should say "Engine running".

Docker Desktop needs hardware virtualisation, which is off by default on many machines:

- **Windows** — needs WSL 2. In Docker Desktop, *Settings → General → Use the WSL 2 based engine* should be ticked. If Docker Desktop refuses to start and complains about virtualisation, enable **Intel VT-x / AMD-V** (sometimes labelled *SVM Mode* or *Intel Virtualization Technology*) in the BIOS/UEFI, and make sure the *Virtual Machine Platform* Windows feature is on. A BIOS change needs a reboot.
- **macOS** — nothing to enable; virtualisation is always available.

Confirm with:

```bash
docker run --rm hello-world
```

If that prints a greeting, Docker is genuinely working. If it errors, **stop and fix Docker first** — nothing below will work, and the failures further down look like database problems rather than Docker problems.

---

## 3. Clone and create the two `.env` files

```bash
git clone https://github.com/amirra7al-gif/clinic-os.git
cd clinic-os
git checkout develop
```

Both `.env` files are gitignored, so a fresh clone has neither. **No script creates them.** This is the one genuinely manual part of the setup, and getting the passwords consistent between the two files is what Step 5 is about.

### Generate four secrets

Run this four times and keep the output, labelled **secret 1** through **secret 4**. The table at the end of this step says which goes where.

```bash
# database / redis passwords (run three times)
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"

# JWT signing secret (run once — deliberately longer)
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

`base64url` matters: the values go inside connection-string URLs, and it produces only `A–Z a–z 0–9 _ -`, none of which need URL-escaping. A password containing `@`, `:`, `/`, or `#` will corrupt the URL and produce a confusing failure. If you generate passwords some other way, keep them to that character set.

### File 1 — `.env` in the repo root

Read only by `docker-compose.yml`. Copy from `.env.example`:

```bash
cp .env.example .env
```

Then fill it in:

```ini
POSTGRES_USER=clinic_os
POSTGRES_PASSWORD=<secret 1>
POSTGRES_DB=clinic_os_dev
REDIS_PASSWORD=<secret 3>
```

### File 2 — `apps/api/.env`

Read by the API, the Prisma CLI, and the test suite. Copy from its own example:

```bash
cp apps/api/.env.example apps/api/.env
```

Then fill in all six variables. **`<secret 1>` must be byte-identical to `POSTGRES_PASSWORD` in the root `.env`**, and `<secret 2>` must be the same in both places it appears:

```ini
DATABASE_URL="postgresql://clinic_os:<secret 1>@localhost:5432/clinic_os_dev?schema=public"
APP_DATABASE_URL="postgresql://clinic_os_app:<secret 2>@localhost:5432/clinic_os_dev?schema=public"
TEST_DATABASE_URL="postgresql://clinic_os:<secret 1>@localhost:5432/clinic_os_test?schema=public"
TEST_APP_DATABASE_URL="postgresql://clinic_os_app:<secret 2>@localhost:5432/clinic_os_test?schema=public"
JWT_SECRET="<the 48-byte secret>"
SLOT_TOKEN_SECRET="<a second 48-byte secret>"
ATTACHMENTS_STORAGE_ROOT="<an absolute path outside this repository>"
```

A laptop always uses the **local** storage backend, which is the default and needs nothing beyond
the variable above. The S3 one (`ATTACHMENTS_STORAGE_BACKEND=s3`, added 2026-09-18 for Huawei OBS in
Cairo — `docs/HOSTING.md`) is a server concern; `apps/api/.env.example` lists its settings, and
`node scripts/backup/s3-attachments-drill.mjs` exercises it against MinIO in Docker if you want to
see it work.

`ATTACHMENTS_STORAGE_ROOT` is not a secret, and it is the one variable here that is a **path rather
than a credential**. It has no default on purpose (`PHASE-4.md` Q11): the API refuses to start
without it, because every plausible default fails silently — `./uploads` ends up committed by a
later `git add -A`, and a temp directory is emptied on reboot, taking patient scans with it. On
Windows use a full path such as `C:/clinic-os-attachments`; on macOS or Linux, `~/clinic-os-attachments`
expanded to its absolute form. **A relative path is refused at startup**, because it would resolve
against whatever directory the process happened to start in. The directory is created for you if it
does not exist; what cannot be created for you is a *sensible location*, which is why you choose it.

**One optional variable is not in the block above**, because leaving it unset is the right answer
for an Egyptian clinic: `DEFAULT_PHONE_COUNTRY` is the country `libphonenumber-js` parses a typed
number against when nothing else hints at one — the login identifier, and the clinic's own
letterhead numbers. It takes `EG`, `SA` or `AE`, and anything else, including unset, means `EG`.
It exists as a variable rather than a literal because `CLAUDE.md` forbids assuming +20 in code.

Keep it outside the repository. That is not tidiness: `apps/web` is served as static files in a
real deployment, and a storage root inside a served directory would put doctor-only patient scans
behind a plain URL, defeating the gate the API puts in front of them.

Leave `SHADOW_DATABASE_URL` commented out. You only need it if the migration role lacks `CREATEDB`, which is not the case here.

Which secret goes where:

| Secret | Appears in | Role it belongs to |
|---|---|---|
| **1** | root `.env` as `POSTGRES_PASSWORD`, and in `DATABASE_URL` + `TEST_DATABASE_URL` | `clinic_os` — superuser, migrations only |
| **2** | `APP_DATABASE_URL` + `TEST_APP_DATABASE_URL` | `clinic_os_app` — the application, RLS-enforced |
| **3** | root `.env` as `REDIS_PASSWORD` | Redis. Nothing in Phase 1 reads it yet |
| **4** | `apps/api/.env` as `JWT_SECRET` | Access-token signing |
| **5** | `apps/api/.env` as `SLOT_TOKEN_SECRET` | Signing appointment slot tokens. Minimum 32 characters; the API refuses to mint or verify one without it |

(`ATTACHMENTS_STORAGE_ROOT` is deliberately absent from that table — it is a location, not a secret, and nothing is weakened by sharing its value.)

Secret 1 and secret 2 must be **different from each other** — that separation is the entire point of the two roles (`CLAUDE.md`: the app connects as `clinic_os_app`, never as the `DATABASE_URL` superuser, because a superuser bypasses every RLS policy).

---

## 4. Start the containers

From the repo root:

```bash
docker compose up -d
```

Wait for both to report healthy:

```bash
docker compose ps
```

Both `postgres` and `redis` should say `Up … (healthy)`. Postgres takes a few seconds on first run because it initialises the data directory.

**Two databases are created here, not one.** `POSTGRES_DB` creates `clinic_os_dev`; `docker/postgres-init/01-create-test-database.sql` creates `clinic_os_test`. That init script runs **only on the first start of an empty volume** — standard `postgres:16` behaviour for `/docker-entrypoint-initdb.d`. Verify both exist before continuing:

```bash
docker compose exec -e PGPASSWORD='<secret 1>' postgres \
  psql -U clinic_os -d postgres \
  -c "SELECT datname FROM pg_database WHERE datname LIKE 'clinic%';"
```

The `-e PGPASSWORD=` is not optional. `docker-compose.yml` sets `--auth-local=scram-sha-256`, so Postgres demands a password even for a connection made *inside* the container over its own local socket (`SCHEMA-DECISIONS.md` D13). Without it, `psql` sits at an interactive `Password for user clinic_os:` prompt, which is easy to misread as a hang.

You should see `clinic_os_dev` and `clinic_os_test`. If you only see `clinic_os_dev`, the volume was not empty when you started — see §10.

---

## 5. ⚠ Install and migrate — both databases

```bash
cd apps/api
npm ci
npx prisma generate
```

`npx prisma generate` is **not optional and not automatic**. `src/generated/` is gitignored, so a fresh clone has no Prisma client at all and nothing compiles until you run it.

### Coming back to a clone after a `git pull`

Re-run `npx prisma generate` (and `npx prisma migrate deploy`) whenever a pull brings in a change to
`prisma/schema.prisma`. `src/generated/` is a build artifact that no pull updates, so an existing clone keeps
compiling against whatever schema it last generated from.

This is written down because it is not self-announcing. On 2026-08-25 this machine picked up the D19 patient
name split from a second machine, and `npm run typecheck` stayed green against a client that still had
`full_name` — the renamed column, the two new derived columns and the stale client all agreed with each other,
and the first symptom was a type error in a file nobody had touched. A stale client is now much more likely to
be noisy than silent, since the write paths are type-checked (`src/prisma/injected.ts`), but the re-generate
step is still yours to run.

`npm test` now says so directly: `test/unit/generated-client-freshness.spec.ts` compares `schema.prisma`
against the copy Prisma embeds in the client it generated, and fails with the command to run. It needs no
database, so it works on a clone that has not reached step 6 yet.

### The two databases are migrated by two different mechanisms

This is the part that surprises people, so it is spelled out:

```bash
# 1. clinic_os_dev — you run this by hand. Uses DATABASE_URL.
npx prisma migrate deploy
```

```bash
# 2. clinic_os_test — DO NOT run this by hand.
#    test/integration/globalSetup.ts applies migrations automatically
#    on every `npm run test:integration`, using TEST_DATABASE_URL.
```

So you migrate the dev database explicitly, and the test database migrates itself in Step 6. Ten migrations should apply, ending with `All migrations have been successfully applied.`

Use `migrate deploy`, not `npm run prisma:migrate`. That script is `prisma migrate dev`, which is for *authoring* new migrations — it wants a shadow database and can prompt interactively. `deploy` just applies what is already committed.

---

## 6. ⚠ Run the tests — and the password trap

From the **repository root**, one command:

```bash
npm run verify
```

It runs the API typecheck, the API unit and integration suites, **both of those again without
`dotenv`**, then the web typecheck and the web suite. Everything passing is the green state, and
setup is done.

**The counts that used to be printed here are gone on purpose.** They said 134 unit and 52
integration, and were wrong by roughly an order of magnitude long before anybody noticed — a number
in a setup document is a second copy of a fact the suite reports authoritatively, and nothing keeps
the copy honest. The same reasoning deleted the status sections from the phase documents. What
matters is that it is green, not what it counts.

**The `no-dotenv` half is the part people skip.** `apps/api/.env` makes a local machine richer than
CI, and five CI failures in this project have had exactly that root cause. Running them separately is
how you find out before pushing rather than after.

### Install the git hooks, once

```bash
npm run hooks:install
```

Points `core.hooksPath` at `.githooks`. The pre-push hook refuses a push whose diff carries U+FFFD or
runs of question marks inside a string — the residue of Arabic sent through a shell. It is a
one-line config change and it is not automatic: a repository that silently installs hooks on
`npm install` is a repository that runs code you did not ask for.

### Why the app cannot reach the dev database until you have run the tests once

This is the sharpest edge in the whole setup, and it is worth understanding rather than working around.

The `20260821194449_app_role` migration creates the `clinic_os_app` role **with no password** — deliberately, because migration files are committed to git and a password in one would be a secret in source control. The only code anywhere in the repo that ever sets that password is `test/integration/globalSetup.ts`, which issues `ALTER ROLE clinic_os_app WITH PASSWORD …` using the password it reads from **`TEST_APP_DATABASE_URL`**.

Verified on the clean machine, in this exact order:

1. After `docker compose up` + `npx prisma migrate deploy`, connecting to **`clinic_os_dev`** as `clinic_os_app` fails with `password authentication failed for user "clinic_os_app"`.
2. After one `npm run test:integration`, the same connection **succeeds**.

The reason is that **a Postgres role is cluster-wide, not per-database.** There is one `clinic_os_app` role shared by `clinic_os_dev` and `clinic_os_test`, and one password for it. The test suite sets that shared password from `TEST_APP_DATABASE_URL`, which is why running the tests silently repairs the dev connection too.

**The consequence you must not miss:** if `APP_DATABASE_URL` and `TEST_APP_DATABASE_URL` carry *different* passwords, running the integration suite will overwrite the shared role password with the test one and **break your dev connection** — and it will do it every single time you run the tests. That is why Step 3 insists secret 2 is identical in both URLs.

If you would rather set it explicitly than rely on the test suite's side effect, this command does it directly (verified):

```bash
docker compose exec -e PGPASSWORD='<secret 1>' postgres \
  psql -U clinic_os -d clinic_os_dev -v ON_ERROR_STOP=1 \
  -c "ALTER ROLE clinic_os_app WITH PASSWORD '<secret 2>';"
```

It prints `ALTER ROLE`. Note that it connects as the superuser (secret 1) in order to set the *app* role's password (secret 2).

---

## 7. Load the demo data

```bash
npm run seed
```

Takes about five seconds and fills the **dev** database (never the test one) with two clinics:

| | |
|---|---|
| Clinics | عيادة النيل لطب الأسرة (Cairo), مركز الشفاء للجلدية والتجميل (Alexandria) |
| Staff | 7 accounts covering OWNER, ADMIN, DOCTOR, RECEPTIONIST |
| Patients | 200, with Egyptian Arabic names |
| Appointments | ~1,200 across three months of history plus two upcoming weeks |
| Visits / payments | ~730 each, money in integer piastres |

Sign in as any seeded account with the phone number as the identifier and the password **`dev-only-not-a-real-password`** — the value says what it is, printed by the seed on every run, and it unlocks nothing but fake patients on your own machine.

Two things it deliberately gives you:

- **Two clinics, not one.** Cross-tenant isolation is the rule the system is built on, and with a single clinic a broken tenant filter looks identical to a working one — every query returns the right rows because there are no wrong rows. The second clinic is what you try to reach and must not.
- **One doctor in both.** دينا كريم القاضي (`+201001234567`) holds a membership in each clinic, which is the account the tenant switcher needs.

The data is deterministic: the same seed produces the same 1,234 appointments on every machine and on every day, so "the appointment on the 14th looks wrong" is a reproducible sentence. That holds because the seeded world is built around a *pinned* instant, `SEED_REFERENCE_DATE` in `apps/api/prisma/seed/blueprint.ts`, not around the current time — until 2026-08-25 it was built around `new Date()`, and two runs on different days quietly produced different data despite the fixed PRNG seed.

Ids are the exception and are not reproducible: they are UUIDv7, which encodes a timestamp, so they differ every run by design. Two seeded databases are equivalent, not byte-identical.

One consequence to expect: because the reference date is fixed, the "two upcoming weeks" of appointments stop being upcoming once real time passes it. From mid-September 2026 a freshly seeded database has no future appointments, and the queue and today screens will look empty. Bump `SEED_REFERENCE_DATE` when that gets in the way — and re-measure the counts in `docs/PHASE-1.md` in the same commit, because they will change. Setting `SEED_REFERENCE_DATE` in the environment overrides it for a single run.

### Re-running it

`npm run seed` is safe to run again — it detects the existing clinics and does nothing. It cannot re-seed, and that is structural rather than a missing feature: seeded appointments and audit rows live in append-only tables, and `audit_logs.tenant_id` pins the tenant with `ON DELETE RESTRICT`, so a seeded tenant genuinely cannot be deleted by anyone. To start over, throw the database away:

```bash
docker compose down -v && docker compose up -d      # ⚠ deletes all local data
cd apps/api && npx prisma migrate deploy && npm run seed
```

---

## 8. Optional — check the API boots

Not required for a green suite, but it works today:

```bash
npm run build
npm start
```

Nest starts and maps exactly one route, `GET /health`, on port `3000` (override with `PORT`). Confirm with `curl http://localhost:3000/health`.

`PORT` is read by `src/main.ts` but is not listed in `apps/api/.env.example`; it defaults to `3000`, so this is cosmetic.

---

## 9. The frontend — component gallery

**`apps/web` is a second, independent package tree.** It has its own `package.json` and its own lockfile, it is not an npm workspace, and nothing you ran above installed it. Steps 5–7 leave it untouched.

```bash
cd apps/web
npm ci
npm run dev
```

That serves the app at <http://localhost:5173/> and opens a browser automatically (`server.open` in `vite.config.ts`).

**This section said "the gallery at `/` is the only page that exists today — there is no login page and no application shell yet" until 2026-09-01, and had been wrong since 2026-08-27**, when the login screen and the authenticated shell merged. That is the second time §9 has gone stale in exactly this way; the note at the top of this document brags about catching the first. A setup document is only load-bearing on a machine that has never seen the project, which is the machine nobody tests on.

What is actually there now: the component gallery, the login screen, the authenticated shell, the schedule editor, the day view, and reception's queue screen. The gallery still needs no `.env`, no database and no running API, so it works even if Steps 4–7 failed — but **every other screen needs a logged-in session, and therefore a running API and a seeded database.**

### Pointing the frontend at an API that is not your dev one

The dev server proxies `/api` to `http://localhost:3000` by default. Override it:

```bash
VITE_API_TARGET=http://localhost:3100 npm run dev      # or `npm run preview` from the repo root
```

This exists because of the rule in `CLAUDE.md`: **never drive a browser against the dev database.** A browser session is a write session — a click lands where the pixels are, not where the intent was — so a review stack gets its own database and its own API port, and this variable is how the frontend is told about it. It was hardcoded until 2026-09-01, which meant a review session silently hit the long-running dev API instead: the port answered, so nothing looked wrong. The rule was in place and the tooling made it unfollowable.

It is optional and defaults to 3000, so nothing changes if you do not set it.

**`apps/web/README.md` is the authority for the frontend** — the scripts table, the RTL rules (`dir`/`lang` set in `index.html` before first paint, CSS logical properties, the `.numeric` wrapper for digit runs), and the directory layout all live there rather than being duplicated here.

---

## 10. If something goes wrong

**`password authentication failed for user "clinic_os_app"`** — expected before your first `npm run test:integration`; see §6. If it persists *after* a test run, your two app passwords disagree.

**`password authentication failed for user "clinic_os"`** — `POSTGRES_PASSWORD` in the root `.env` and the password inside `DATABASE_URL` in `apps/api/.env` are not identical. Note that Postgres only reads `POSTGRES_PASSWORD` when it initialises an empty volume; editing it later changes nothing until you reset (below).

**`clinic_os_test` does not exist** — the init script only runs on a first-time empty volume. If you started the containers before writing the root `.env`, or with an older volume present, you have a half-initialised cluster. Reset it:

```bash
docker compose down -v      # ⚠ -v deletes the database volume and all local data
docker compose up -d
```

Then redo Step 5. This is safe in development; there is no data worth keeping yet.

**`Cannot find module './generated/prisma'` or a wall of TypeScript errors** — you skipped `npx prisma generate`.

**`Jest did not exit one second after the test run has completed`** — expected and harmless. A known, untriaged open handle, recorded in `PHASE-1.md` §5b. Tests still pass; the process still exits. Not a setup problem.

**Port 5432 or 6379 already in use** — another Postgres or Redis is running on the host. Stop it, or change the host-side port in `docker-compose.yml` and in all four URLs in `apps/api/.env`.

**Port 5173 already in use** — another Vite dev server. Vite will pick the next free port and print it; use whatever it prints.

**`npm ci` fails with `EBADENGINE`** — deliberate (§1): `engine-strict=true` turns the `engines` field into a hard stop. Read the `Required` and `Actual` lines npm prints, because there are two different causes and they need opposite fixes. `"node"` mismatched means your Node is older than 24 — upgrade Node. `"npm"` mismatched means your npm is not the pinned version — `npm i -g npm@11.19.0`. Do not delete the `.npmrc` for either.

**`npm audit` reports 3 high-severity vulnerabilities in `apps/api`** — known and accepted. All three are one advisory, `GHSA-ggr8-5vv4-36mx` (stack exhaustion in `deepmerge-ts` <8.0.0), reached only via `prisma` → `@prisma/config` → `deepmerge-ts@7.1.5`. `prisma` is a devDependency, so none of it ships in the runtime image, and the only input it parses is our own committed `prisma.config.ts`. **Do not run `npm audit fix --force`**: the remediation npm proposes is `prisma@6.12.0`, a major downgrade that breaks the exact-version pin required by `SCHEMA-DECISIONS.md` D10. The fix is an upstream Prisma bump of `@prisma/config`, which pins `deepmerge-ts` exactly.

**Verify your setup matches CI exactly** — if you touch environment handling:

```bash
npm run test:no-dotenv               # unit
npm run test:integration:no-dotenv   # integration
```

Each strips every `.env`-declared variable and runs with only what `.github/workflows/ci.yml` provides to that step.

Run the unit one too, not just the integration one. A unit spec needs no database and no variables at all — but it only takes one `import` reaching something under `src/prisma/` for it to acquire a dependency on `APP_DATABASE_URL`, which `client.ts` reads at module scope. Locally `dotenv` supplies it and the suite is green; on CI there is no `.env` and the suite fails to even load. That has now happened four times in this project, most recently on 2026-08-25.

---

## 11. What I could not verify, and where I would look first

Ranked by how likely they are to cost you the evening.

1. **[UNVERIFIED] A non-Windows second machine.** Both runs were Windows 11 with Git Bash. The Windows-specific hazard that used to sit here — `globalSetup.ts` invoking `npx` with `shell: true` — **is gone**: it now runs Prisma's CLI entry point directly with `process.execPath` and no shell, which behaves the same on every platform. What remains is Git's line-ending conversion, since this repo is checked out with CRLF on Windows. **CI proves the whole suite passes on Linux**, which is real evidence for POSIX generally, so I rate this low risk but non-zero.

2. **[UNVERIFIED] Docker Desktop installation and BIOS virtualisation.** Docker was already installed and working here, so §2 is written from documentation rather than from a run. The BIOS labels in particular vary by manufacturer. This is the single most likely place to lose time, and it is entirely front-loaded — `docker run --rm hello-world` settles it in ten seconds.

3. **[UNVERIFIED] `git clone` from GitHub over HTTPS.** The rehearsal cloned from the local filesystem path, so it did not test authentication against GitHub. The repo URL in Step 3 is taken from the configured `origin` remote and is correct; whether the second machine has credentials for it is a question about that machine.

4. **`cp` on the second machine.** Verified in Git Bash on the second machine. `cp` is a Git Bash / macOS command; in PowerShell it is `Copy-Item`, which PowerShell aliases `cp` to, so it works there too.


### Reviewing a screen

```bash
npm run preview        # from the REPOSITORY ROOT, not apps/web
```

**This is the only build the founder reviews.** One command, from the repository root. It checks the
tree is clean and `develop` is current, installs both apps from their lockfiles, migrates and seeds
`clinic_os_review`, builds the API and the frontend, serves both, and prints the URL.

It **refuses** rather than warns, in three cases: a dirty working tree (the build would correspond to
no commit, so feedback on it cannot be traced to code anyone else can check out), a `develop`
behind `origin` (the stale-build trap this command exists to prevent), and an API that never answers
`/health` — READY is printed after that answer arrives, never on a timer.

**To review a pull request before it merges:**

```bash
npm run preview -- --pr 72
```

It runs `gh pr checkout` and builds that head. Same gates, minus the two about `develop` being
current — a pull request head is not expected to be, and often must not be. The dirty-tree gate is
checked **before** the checkout, because `gh pr checkout` on a dirty tree can carry uncommitted work
onto another branch, which is worse than the refusal.

**The login footer shows the branch, the short commit hash and the build time.** If it does not match
what the command printed, the page is cached — hard-reload before giving feedback. That is the check
that makes a stale review impossible to give silently rather than merely unlikely, and with `--pr`
the branch is the part that says *which* review you are giving.

It targets **`clinic_os_review`**, never `clinic_os_dev`, and creates and migrates it if needed —
`CLAUDE.md` forbids driving a browser at the dev database, and nothing else in the project migrates
the review one, which is how it was once found two migrations behind.

**There is no longer any command in `apps/web` that serves the app for review.** `preview`,
`preview:fresh` and `review` are gone; the remaining `smoke:serve` exists for Playwright in CI and is
named so it cannot be reached by habit. This section previously read "use `npm run review`, not `npm
run preview`" — correct advice that failed three times, because a document telling you not to use a
command that still works is a convention, not a guardrail. The path is removed, not documented
against.

**Why this is expensive rather than annoying.** A stale build does not look like a tooling failure.
It looks like the work was not done. The reviewer gives confident, specific, wrong feedback; the
developer re-checks correct code; and the round trip costs more than the feature did.

`--strictPort` is deliberate. If 4173 is already held — usually by a server left running from an
earlier session — this **fails loudly** rather than quietly moving to 4174, because a second server
on a port you are not looking at is how you review the wrong tab.

### The review database

`npm run preview` handles this — it creates, migrates and seeds `clinic_os_review` itself, and points
the API and the frontend at it. There is nothing to run by hand and no ports to remember.

It seeds only a database that is **empty**, so the data outlives the code that made it:

```bash
npm run preview -- --reseed      # drop clinic_os_review, recreate, migrate, seed
```

Use it whenever a change alters what the seed produces. On 2026-09-09 it was not there and it was
needed: PR 7i stopped seeding a membership, the review database went on holding one, and a review
build of current code presented data from before the change — the stale-build trap moved from
`dist/` to the rows. Migrations always run, so a schema change alone does not need this; a change to
the *seed* does.

This section previously gave a two-terminal recipe with connection strings and `VITE_API_TARGET` set
manually. It is gone for the reason the aliases above are gone: a recipe that must be typed correctly
every time is a convention. Every trap it warned about — serving a stale `dist/`, pointing the review
frontend at the dev API, reviewing against `clinic_os_dev` — is now a refusal or an automatic step.


### `VITE_SUPPORT_WHATSAPP` — optional, and the support link hides without it

The only other variable `apps/web` reads. It holds the platform team's WhatsApp number, in any
shape — `+20 100 123 4567` and `201001234567` both work, since non-digits are stripped before the
`wa.me` link is built.

```bash
VITE_SUPPORT_WHATSAPP="+201001234567" npm run preview   # from the repo root
```

**Leaving it unset is a supported state**, not a broken one: the link does not render at all rather
than rendering a dead `wa.me/undefined` that fails only when somebody in trouble clicks it. So a
local review needs it only if the support link is what is being reviewed.

Vite inlines it at build time, which means **changing it requires a rebuild**, not a restart — the
same property as any `VITE_` variable, and worth knowing before concluding the link is broken.

---

## 12. Things this document deliberately does not tell you to do

- **Do not run `prisma db seed`.** The seed is `npm run seed` (step 7) — a plain Node script, not wired into Prisma's seed hook. The integration tests do not use it; they create their own fixtures.
- **There is no `npm install` at the repo root.** There is no root `package.json` and no npm workspace. There are two independent package trees — `apps/api` (steps 5–8) and `apps/web` (step 9) — and each is installed from its own directory. No command run in one installs the other.
- **Do not run `npm install` in either tree.** Both have a committed lockfile; use `npm ci`, which installs exactly what is locked instead of quietly drifting it.
- **Do not run migrations against `clinic_os_test` yourself.** Step 6 does it for you, every run.
- **Do not run `npm audit fix --force` in `apps/api`.** Its proposed remediation is a downgrade to Prisma 6.x, which violates the exact-version pin in `SCHEMA-DECISIONS.md` D10. See §10.
