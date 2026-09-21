# Deploy — a brief for whoever stands up the server

For a contractor with a fresh Linux VM and this repository. End state: the app reachable over HTTPS
at a real hostname, seeded with synthetic data, backed up nightly, with a restore that has been
tested rather than assumed.

**This is not `docs/SETUP.md`.** That document is for a developer's laptop and is rehearsed on a
clean machine. This one is for a server with a public IP, where several of SETUP.md's steps are
actively wrong. Where they disagree, this document wins for servers and SETUP.md wins for laptops.

**Status — what has actually been exercised, and what has not.** Be precise about this rather than
trusting the document: a setup document is only load-bearing on a machine that has never seen the
project, and this one has not met that machine yet.

| | |
|---|---|
| The three images build | ✅ all three, on 2026-08-27 |
| The stack starts, and `/health` answers through Caddy | ✅ `{"status":"ok","database":"reachable"}`, plus the SPA and a deep link at 200 |
| Caddy sets `X-Forwarded-For` to the client address | ✅ upstream saw the client's address while the connection arrived from Caddy's |
| Express resolves that header into `req.ip`, and that value reaches `audit_logs` | ✅ `forwarded-ip-audit.integration.spec.ts` |
| An HTTP request end-to-end producing an audit row | ✅ closed in #12 — `audit-chain-http.integration.spec.ts`, forwarded client address included. Tested in-process, not yet through Caddy on a host |
| The migrator applies migrations to an empty database, as a non-root user | ✅ 13 migrations, uid 1000 |
| `clinic_os_app` is `rolsuper=f`, `rolbypassrls=f` after provisioning | ✅ |
| The API container never receives `DATABASE_URL`, and no database port is published | ✅ both confirmed on the running stack |
| TLS against a real hostname and a real Let's Encrypt certificate | ❌ **not verified** — the local run uses `SITE_ADDRESS=:80` |
| Any of it on a Linux host, or on the eventual provider | ❌ **not verified** |
| The restore drill in §7 | ✅ run 2026-08-27 — 5s, counts identical to live |
| Recovery into a *fresh* cluster (§7c) | ✅ proven, including that the obvious order silently half-restores |
| The backup script and restore drill, in the repository | ✅ `scripts/backup/` — #116, #117, #124; exercised against a throwaway database, a MinIO bucket and, read-only, the review data |
| The backup on a server cron, and the nightly restore with an alert | ❌ **not scheduled anywhere** — there is no server yet (PILOT-READINESS 1c, 2c) |
| WAL archiving and point-in-time recovery (§15, production) | ❌ **not built** — the script takes nightly dumps only |

Nothing here is marked verified until it has been watched to happen. Treat
step timings as estimates, and report anything that does not match — including the parts marked
verified.

---

## 1. What you are deploying

Four containers, defined in `docker-compose.server.yml`:

| Service | Image | Role |
|---|---|---|
| `postgres` | `postgres:16` | The database. **No published ports** — reachable only inside the Docker network |
| `migrate` | built, `migrator` target | Runs `prisma migrate deploy` and exits. The only thing that connects as the superuser |
| `api` | built, `runtime` target | NestJS on :3000, internal only |
| `web` | built, Caddy | Serves the SPA, proxies `/api`, terminates TLS. The only service on :80/:443 |

Redis is deliberately absent. Nothing in Phase 1 reads `REDIS_PASSWORD`; BullMQ arrives in Phase 6.

The SPA and API are **same-origin** — Caddy serves both under one hostname. That is why CORS stays
off and why the refresh cookie is same-site by construction rather than by configuration.

**Both images compile from source inside their build stage. Nothing here ever ships a build artefact
from the machine you deploy from.** `docker/Dockerfile.web` runs `npm run build` and copies
`/app/dist` out of that stage; `docker/Dockerfile.api` runs `npx prisma generate && npm run build`
and copies its own `dist`. A host `dist/` directory is never read, so the stale-build class of fault
does not exist on this path.

Said explicitly because the *local* review loop has now been bitten three times by exactly that fault
— a served bundle older than its source, which does not look like a tooling failure, it looks like
the work was never done (`docs/SETUP.md` §9; every serving script in `apps/web/package.json` now
builds first). **Do not "optimise" either Dockerfile by copying a pre-built `dist/` in from the
host.** It saves seconds of build time and imports that failure into production, where the symptom
is a running version nobody can account for.

---

## 1b. Linux is the server's operating system. No clinic ever sees it.

Stated explicitly because this document talks about Linux on almost every page and a reader
skimming it could reasonably infer that a clinic needs one. **They do not.** Nothing is installed at
a clinic at all.

| | |
|---|---|
| **The server** | One Linux host, running Docker. Reachable only by the contractor and by HTTPS |
| **The clinic** | A web browser. Chrome or Safari, on Windows, macOS, iPhone or Android |
| **The patient** | Nothing. Patients install nothing (CLAUDE.md) |

Reception typically has a Windows desktop; doctors are expected to use iPhone first and Android
later. The only clinic-side requirements are a modern browser and internet during clinic hours
(ARCHITECTURE.md §19 lists that second one as an assumption the pilot depends on).

---

## 2. Before you start

- A Linux host with Docker Engine and the Compose plugin. 2 vCPU / 4 GB is comfortable.
- A DNS `A` record pointing at the host **before first start**. Caddy requests a certificate on
  boot; if the name does not resolve to this machine, the request fails and Let's Encrypt rate
  limits repeated failures.
- Ports 80 and 443 reachable from the internet. Port 80 is not optional — the ACME HTTP challenge
  uses it even though nothing is served there afterwards.
- **Nothing else.** Do not install Node, Postgres or `psql` on the host. Everything runs in
  containers, and every `psql` command below runs *inside* one via `docker compose exec`.

---

## 3. ⚠ The trap: `clinic_os_app` has no password until you set one

**This is the step most likely to cost you an afternoon.** Read it before you start, not after.

The migration that creates the `clinic_os_app` role creates it **with no password**, deliberately —
a password in a checked-in migration file is a committed secret (SCHEMA-DECISIONS.md D12/D13). On a
laptop the integration suite's `globalSetup.ts` sets one on every test run, so a developer never
sees this. **On a server nothing does it**, and the symptom is not "no password": it is the API
failing to authenticate against its own database with a message that reads like a wrong credential.

So after the first `migrate` run and before the API starts:

```bash
# The password must be byte-identical to the one inside APP_DATABASE_URL.
#
# `-e PGPASSWORD` is not optional, and omitting it is the second half of this trap. The compose
# file sets --auth-local=scram-sha-256 (SCHEMA-DECISIONS.md D13), so Postgres demands a password
# even for a connection made inside the container over its own local socket. Without it, psql waits
# at an interactive "Password for user clinic_os:" prompt — which through `exec -T` looks like a
# hang rather than a prompt. This document's first draft left it out, and running the brief is how
# that was found.
docker compose -f docker-compose.server.yml exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "ALTER ROLE clinic_os_app WITH PASSWORD '<the password from APP_DATABASE_URL>';"
```

Then confirm the role is what it must be — an ordinary role, not a superuser:

```bash
docker compose -f docker-compose.server.yml exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'clinic_os_app';"
```

`rolsuper` and `rolbypassrls` must both be `f`. If either is `t`, **stop** — every row-level
security policy in the system is a no-op and the deployment is not safe to continue.

---

## 4. Secrets

Four values, generated **on the server**, never on a laptop and never pasted into a chat, ticket or
commit:

```bash
# database and app-role passwords (run twice)
openssl rand -base64 36 | tr '+/' '-_' | tr -d '='
# JWT signing secret (once, longer)
openssl rand -base64 48 | tr '+/' '-_' | tr -d '='
```

The `tr` is not decoration: these values go inside connection-string URLs, and `+`, `/` or `@` in a
password corrupts the URL and produces a failure that looks like a database problem.

| Variable | Value |
|---|---|
| `POSTGRES_USER` | `clinic_os` |
| `POSTGRES_PASSWORD` | secret 1 |
| `POSTGRES_DB` | `clinic_os` |
| `DATABASE_URL` | `postgresql://clinic_os:<secret 1>@postgres:5432/clinic_os?schema=public` |
| `APP_DATABASE_URL` | `postgresql://clinic_os_app:<secret 2>@postgres:5432/clinic_os?schema=public` |
| `JWT_SECRET` | secret 3 |
| `SLOT_TOKEN_SECRET` | secret 4 — a distinct value, minimum 32 characters |
| `ATTACHMENTS_STORAGE_ROOT` | an absolute path **inside the API container**, e.g. `/var/lib/clinic-os/attachments`, backed by a named volume or bind mount. Not a secret. The API refuses to start without it |
| `SITE_ADDRESS` | the public hostname, e.g. `staging.example.com` |

Note the host is `postgres`, not `localhost` — these are container-to-container connections.

**`ATTACHMENTS_STORAGE_ROOT` needs a volume, and Caddy must not be able to see it.** It is a path
inside the API container, so without a volume it lives in the container's writable layer and every
patient scan is destroyed by the next `docker compose up -d` — silently, because the database rows
survive and only the files go. Mount it:

```yaml
services:
  api:
    volumes:
      - attachments:/var/lib/clinic-os/attachments
volumes:
  attachments:
```

And keep it out of anything Caddy serves. `PHASE-4.md` Q11 requires attachments to be fetched
through the API under `visits.readContent`; a storage root inside the static site root would put
doctor-only patient scans behind a plain URL, which is the one failure this design exists to
prevent. The API never emits such a URL — but a web server does not need one to serve a file.

Secrets 1 and 2 must be **different from each other**. That separation is the entire point of the
two roles: the app connects as `clinic_os_app`, never as the `DATABASE_URL` superuser.

Put them in a file the compose command reads (`--env-file`), owned by root, mode `600`, outside the
repository checkout. Do not commit it. `.gitignore` already covers `.env`, but a file named
something else is not covered by anything.

---

## 5. First deploy

**The first `up` is expected to fail, once.** It is not a mistake and not a broken compose file:
the API cannot authenticate until §3 has been done, its health check fails, and Compose reports
`dependency failed to start: container ... is unhealthy`. Do §3, then bring it up again. This is
written out because the failure looks alarming and is the normal path.

```bash
git clone <repo> && cd clinic-os && git checkout develop

# 1. Build, start Postgres, run migrations. The API will start and then fail its health check --
#    expected, see above.
docker compose -f docker-compose.server.yml --env-file /etc/clinic-os.env up -d --build

# 2. The step nothing else does — see §3. Set the clinic_os_app password, then bring the stack
#    up again: the API reconnects with a working credential and `web` starts behind it.
docker compose -f docker-compose.server.yml --env-file /etc/clinic-os.env restart api
docker compose -f docker-compose.server.yml --env-file /etc/clinic-os.env up -d

# 3. Synthetic data. ARCHITECTURE.md §14: staging is synthetic only, never a production copy.
#
#    --entrypoint is NOT optional. Without it the arguments are APPENDED to the image's entrypoint,
#    producing `npx prisma migrate deploy npm run seed`, which prisma ignores: it prints "No
#    pending migrations to apply", exits 0, and seeds nothing. The first draft of this document had
#    it wrong, and the failure looked exactly like success.
docker compose -f docker-compose.server.yml --env-file /etc/clinic-os.env \
  run --rm --entrypoint npm -e APP_DATABASE_URL -e DATABASE_URL migrate run seed
```

Verify:

```bash
curl -fsS https://<SITE_ADDRESS>/api/health && echo OK
```

Then open `https://<SITE_ADDRESS>` on a phone. That is the whole point of this environment.

---

## 6. Deploying a change

Migrations run as a separate step **before** the new image goes live, and every migration must stay
backward-compatible for one release (ARCHITECTURE.md §14, expand → migrate → contract). The compose
file encodes the ordering; you only need to rebuild.

```bash
git pull
docker compose -f docker-compose.server.yml --env-file /etc/clinic-os.env up -d --build
```

If `migrate` fails, the API does not start and the previous container keeps serving. That is
intended: `depends_on: service_completed_successfully` is the gate.

---

## 7. Backups — what, how often, and how a restore is tested

**This is the section that did not exist before, and the one to get right.** ARCHITECTURE.md §15
sets the requirements; this is the concrete implementation for a single-host deployment.

> **Attachments may live in object storage rather than on the disk** (2026-09-18). With
> `ATTACHMENTS_STORAGE_BACKEND=s3` the API writes them to a bucket, and both `backup.mjs` and
> `restore-drill.mjs` read that bucket instead of the volume — the artefact and the per-key check are
> unchanged, so the §7 reasoning below holds either way. A backup left on `local` while the API
> writes to a bucket is caught by the size floor: it archives an empty directory and is refused.
>
> **Use `scripts/backup/`, not the inline scripts below** (#116, #117, #124). `backup.mjs` encrypts
> the dump and the attachment archive to an age public key and uploads both off-machine;
> `restore-drill.mjs` restores into a scratch database and checks every file each storage-key
> column references. The shell below is kept as the reasoning behind them — the ordering, the size
> floors and the attachments gap still apply.

### What backs up

| | |
|---|---|
| **Postgres** | The whole cluster. Everything of value is in it |
| **Caddy's `/data` volume** | Certificates and the ACME account key. Not critical — re-issuable — but losing it means re-issuing on every restart, which Let's Encrypt rate-limits |
| **The env file** | Separately, by whatever holds your other credentials. **Never into the same bucket as the database dump** — an attacker who gets the dump should not also get the key to everything else |
| Application images | Nothing. They rebuild from Git |

### How often

For **staging**, which holds synthetic data only:

- **Nightly `pg_dump`**, retained 7 days. That is proportionate: the data is regenerable with
  `npm run seed`, and the thing being protected is the *procedure*, not the rows.

For **production**, §15 requires more and the difference is not optional: continuous WAL archiving
plus a nightly base backup, 30-day point-in-time recovery, encrypted at rest, **stored in a separate
failure domain from the primary**. A nightly dump sitting on the same VM as the database is not a
backup — one failed disk loses both.

```bash
#!/bin/sh
# /usr/local/bin/clinic-os-backup — run from cron at 02:30, output to a log
set -eu
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DEST=/var/backups/clinic-os
mkdir -p "$DEST"

docker compose -f /opt/clinic-os/docker-compose.server.yml --env-file /etc/clinic-os.env \
  exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom \
  | gzip > "$DEST/clinic-os-$STAMP.dump.gz"

# Fail loudly on an empty or absurdly small dump rather than retaining a file that is not a backup.
SIZE=$(stat -c %s "$DEST/clinic-os-$STAMP.dump.gz")
[ "$SIZE" -gt 100000 ] || { echo "Backup is only $SIZE bytes — refusing to treat this as a backup" >&2; exit 1; }

find "$DEST" -name 'clinic-os-*.dump.gz' -mtime +7 -delete
echo "$STAMP ok ($SIZE bytes)"
```

**Copy it off the host.** Whatever object storage the provider offers, with a lifecycle rule
matching the retention above. A backup that never leaves the machine it protects is a snapshot.

### The gap this script has, stated rather than left to be discovered

**`pg_dump` does not cover attachments.** Since `PHASE-4.md` Q11 the system holds state outside
Postgres: the files under `ATTACHMENTS_STORAGE_ROOT`. A restore from the script above brings back
every `attachments` row and **not one of the files they point at** — and it does so without
erroring, because nothing in a database restore looks at a filesystem. The result is a record that
says a scan exists and a download that fails, for every attachment, discovered one at a time by
whoever needed one.

The §7 restore drill would not catch it either: it counts rows, and the rows are all there.

So a backup is not complete until it covers both, and the drill is not honest until it opens a
restored attachment. Concretely, alongside the dump:

```bash
# In the same script, after the pg_dump block. ROOT is the host side of the volume mounted at
# ATTACHMENTS_STORAGE_ROOT -- `docker volume inspect` gives it, or use the bind-mount path.
ROOT=/var/lib/docker/volumes/clinic-os_attachments/_data
tar -czf "$DEST/clinic-os-attachments-$STAMP.tar.gz" -C "$ROOT" .

# The same "refuse to keep a file that is not a backup" check. An empty archive is ~45 bytes.
ASIZE=$(stat -c %s "$DEST/clinic-os-attachments-$STAMP.tar.gz")
[ "$ASIZE" -gt 1000 ] || { echo "Attachment archive is only $ASIZE bytes" >&2; exit 1; }

find "$DEST" -name 'clinic-os-attachments-*.tar.gz' -mtime +7 -delete
```

**Ordering matters and is not free.** The dump and the tar are taken at different instants, so an
attachment uploaded in the window between them lands in exactly one of the two. Which one depends
on the order:

- **Database first, files second** (what the script above does): the upload misses the dump but is
  caught by the tar, so the restore has **a file with no row** — an orphan nobody references, and
  nothing in the product ever looks for it.
- **Files first, database second**: the upload is caught by the dump but misses the tar, so the
  restore has **a row with no file** — an attachment the screen offers and the download cannot
  serve.

Both are inconsistent; only one is visible to a doctor. That is a deliberate choice of which
inconsistency to accept, not an accident of script order, and it should not be reordered for
tidiness.

### How a restore is tested

§15 requires **monthly restore drills, with the recovery time recorded**. An untested backup is not
a backup. The drill restores into a scratch database on the same host — never over the live one:

```bash
# 1. Note the start time. The number you are measuring is how long recovery takes.
date -u +%H:%M:%S

# 2. Create a scratch database and restore the most recent dump into it.
LATEST=$(ls -1t /var/backups/clinic-os/*.dump.gz | head -1)
docker compose -f docker-compose.server.yml --env-file /etc/clinic-os.env exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres \
  psql -U "$POSTGRES_USER" -d postgres -c 'DROP DATABASE IF EXISTS restore_drill;'
docker compose -f docker-compose.server.yml --env-file /etc/clinic-os.env exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres \
  psql -U "$POSTGRES_USER" -d postgres -c 'CREATE DATABASE restore_drill;'
gunzip -c "$LATEST" | docker compose -f docker-compose.server.yml --env-file /etc/clinic-os.env \
  exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres pg_restore -U "$POSTGRES_USER" -d restore_drill --no-owner

# 3. Assert the restore is real, not merely successful.
docker compose -f docker-compose.server.yml --env-file /etc/clinic-os.env exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres \
  psql -U "$POSTGRES_USER" -d restore_drill -c \
  "SELECT (SELECT count(*) FROM tenants) AS tenants,
          (SELECT count(*) FROM patients) AS patients,
          (SELECT count(*) FROM appointments) AS appointments;"

# 4. Note the finish time, then drop the scratch database.
```

**What "assert the restore is real" means.** `pg_restore` exiting 0 is not the check — it will
happily restore an empty schema. Compare the counts against the live database. On a seeded staging
environment they should be `2 / 200 / 1234` (`docs/PHASE-1.md` records the current figures; if they
disagree, trust the live database and correct the document).

**Record each drill** — date, dump timestamp, elapsed time, row counts, and anything that went
wrong — in a running log. The elapsed time is the deliverable: it is the answer to "how long are we
down", and nobody knows it until it has been measured.

### Drill result — run 2026-08-27

First actual run, against the local stack seeded with `npm run seed`.

| | |
|---|---|
| Dump size | 489,926 bytes gzipped (size guard passed) |
| **Elapsed, dump to verified restore** | **5 seconds** |
| Live | 2 tenants, 200 patients, 1,234 appointments, 5,527 audit_logs |
| Restored into `restore_drill` | identical on all four |

Five seconds is not a useful prediction for production — 200 patients on a laptop. It is a
*procedure* that has now been executed, which is the thing that did not exist before.

---

## 7c. Recovering into a fresh cluster — the order matters, and the obvious order is wrong

The drill above restores into a scratch database **in the same cluster**, so the `clinic_os_app`
role is already there. A real recovery is onto a new machine, and that is a different problem.

**What a `pg_dump` restore brings back, verified by doing it:** the schema, every row, **30 RLS
policies, 30 tables with RLS enabled, 33 triggers** (audit and append-only) and **2 generated
columns**. The security configuration survives intact — which is worth knowing, because the
opposite would be a silent security regression on recovery.

**What it does not bring back: the role.** An earlier draft of this document said `clinic_os_app`
"will exist without a password". That was wrong, and the truth is worse: roles are cluster-level and
a database dump contains none, so **the role does not exist at all**. `pg_restore` reports 42
failures, all of them `role "clinic_os_app" does not exist` on `GRANT` statements, and then the
application cannot start:

```
psql: error: ... FATAL:  role "clinic_os_app" does not exist
```

**Do not fix this by migrating first and restoring data only.** It is the obvious move — run
`prisma migrate deploy` to create the role and grants, then `pg_restore --data-only` — and it fails
in the worst available way. Tried on 2026-08-27: **13 errors**, foreign keys violated by COPY
ordering and duplicate keys in `_prisma_migrations`, leaving **2 tenants, 0 patients and 5,469
audit_logs**. Not a clean failure — a partially populated database that answers queries and looks
alive.

**Create the role first, then restore everything.** Verified: **0 errors**, all four counts correct,
3 seconds, and the application role connects with RLS failing closed.

```bash
# 1. On the new cluster, before restoring anything. NOSUPERUSER and NOBYPASSRLS are not optional:
#    a recovered database whose app role bypasses RLS is a tenant-isolation failure, not a recovery.
psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c   "CREATE ROLE clinic_os_app WITH LOGIN PASSWORD '<secret 2>' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;"

# 2. Restore the whole dump. The GRANTs now find their role and it completes cleanly.
gunzip -c <dump> | pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner

# 3. Prove the recovery, do not assume it. Counts against what the dump should hold, and then the
#    check that matters: RLS still refuses an unbound session.
psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c   "SELECT (SELECT count(*) FROM pg_policies WHERE schemaname='public') AS policies,
          (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal) AS triggers;"
PGPASSWORD='<secret 2>' psql -U clinic_os_app -d "$POSTGRES_DB" -c "SELECT count(*) FROM patients;"
```

That last query must return **0**. It is the whole tenant-isolation model answering: no tenant bound,
no rows. A non-zero count means RLS did not come back and the recovered database is not safe to
serve.

---

## 7b. Two things that will bite you when you change dependencies

Both were found by building these images rather than by reasoning about them, and both fail in
ways that do not look like their cause.

**Run `npm install` on Linux, not on Windows.** Adding `class-validator` and `class-transformer`
from a Windows shell produced a `package-lock.json` that `npm ci` refuses on Linux — the
`@emnapi/*` transitive dependencies of `@node-rs/argon2` resolved to different versions. The
message is `EUSAGE ... package.json and package-lock.json are not in sync`, which reads like a
mistake in `package.json` and is not. CI would have caught it (it runs `npm ci` on Ubuntu), but
after a wasted build cycle. The fix, from the repo root:

```bash
docker run --rm -v "$PWD/apps/api:/w" -w /w node:24.13.0-bookworm-slim   npm install --package-lock-only
```

Then commit the lockfile. It stays valid on Windows — npm records every platform's optional
dependencies — so this is a one-way improvement, not a trade.

**And use a current npm when you do, because the npm version matters too.** The first attempt at
this fix regenerated the lockfile with the npm bundled in `node:24.13.0-bookworm-slim` (11.6.2),
and CI — whose `setup-node` installs a newer npm — still rejected it, asking for
`@emnapi/core@1.11.3` where the lockfile recorded `1.10.0`. Two npm versions resolve the optional
peer dependencies of `@node-rs/argon2` differently, and the lockfile written by the older one is
not accepted by the newer. Upgrading npm inside the container first produced a lockfile that both
accept:

```bash
docker run --rm -v "$PWD/apps/api:/w" -w /w node:24.13.0-bookworm-slim \
  sh -c 'npm i -g npm@latest && npm install --package-lock-only --include=optional'
```

Verify with a real `npm ci` rather than `--dry-run`. The dry-run passed on the version that CI
then rejected.

The reason this is recoverable rather than dangerous is that **CI runs `npm ci` on Linux**, so this
class of problem is always caught before a merge. It caught it twice here. What it costs is a
round trip, which is why the recipe is written down.

**`.dockerignore` is load-bearing, not tidiness.** Without it the build context was 432 MB and took
82 seconds, because it carried both trees' `node_modules`. The real problem is subtler: the build
stage runs `npm ci` and *then* `COPY apps/api/ ./`, so a `node_modules` in the context overwrites
the freshly installed Linux dependencies with the host's — on Windows, native binaries that cannot
execute in the image. The image builds successfully and fails at runtime. If you add a directory to
either tree, check whether it belongs in `.dockerignore` first.

---

## 8. What you must not do

Non-negotiable, each for a specific reason.

**Production secrets never pass through a chat session, a ticket, or a commit.** Generate them on
the server. If a value has been pasted into any of those, it is burned — rotate it rather than
reason about who saw it.

**The application never connects as `DATABASE_URL`.** That role is the migration superuser and has
`BYPASSRLS`, which turns every row-level security policy in the system into a no-op. `client.ts`
throws on startup rather than falling back to it, and the `migrate` container is separate from the
`api` container specifically so the long-running process cannot hold that connection string. If you
find yourself putting `DATABASE_URL` into the `api` service to fix something, the fix is wrong.

**Never run `npm audit fix --force`.** It proposes `prisma@6.12.0`, a major downgrade that breaks
the exact-version pin SCHEMA-DECISIONS.md D10 requires. The three advisories are known, accepted,
and documented in SETUP.md; the remediation is an upstream bump, not a local flag.

**Staging never holds a copy of production data** (ARCHITECTURE.md §14). Not a subset, not
"anonymised", not for one afternoon of debugging. Staging has weaker access control by design, and
the data is patient records under PDPL. Use `npm run seed`, which produces 200 realistic synthetic
patients for exactly this.

**Do not publish 5432 or 6379.** `docker-compose.yml` — the laptop file — does, because a developer
needs them from the host. `docker-compose.server.yml` does not. If you find yourself adding a
`ports:` entry to `postgres` to debug something, use `docker compose exec` instead.

**Do not run containers as root.** The API and migrator images already drop to the `node` user. The
Caddy container is the documented exception: its official image runs as root so it can bind 80/443
and write its certificate store, and dropping privileges there breaks ACME renewal. That container
holds no application code and no database credentials.

---

## 9. Known gaps, stated rather than left to be discovered

**No CI deploy step.** CI builds and tests; it does not build images or push to a registry. This
deployment builds from source on the host, which is fine for staging and wrong for production —
production wants an image built once, tested, and promoted, not rebuilt per environment.

**Rate limiting covers auth only.** Login (#12) and change-password (#118) are limited; no route
outside auth is (PILOT-READINESS 4b).

**Auth rate limiting counts in memory, which makes this a single-instance deployment.**
`@nestjs/throttler`'s default store is per-process. With one API container that is correct and
cheap. **The moment a second instance is added it silently becomes wrong**: each process keeps
its own counters, so an attacker gets the configured limit *per instance*, and a legitimate
user's failures scatter across processes instead of accumulating. Nothing errors; the limit
simply stops meaning what it says — the same shape as every other defect this project has
found.

The fix when scaling out is a shared store. Redis is already a locked decision for BullMQ
(Phase 6) and is deliberately absent from this compose file today, so the sequence is: add
Redis, point the throttler storage at it, *then* add the second API instance. Not the other
way round. **Do not scale `api` past one replica before that is done.**

**No log aggregation or alerting.** Container logs go to the Docker daemon and nothing watches
them. Acceptable for staging; name it now so it is not mistaken for done.

**No PWA.** Deliberate and deferred — see the carry-forward note in  §2b for the full reasoning, including why no install prompt will ever appear on iPhone. Opening the site in a phone browser needs only TLS and a URL,
which this provides. A service worker can serve stale application code, which in a clinical system
is a design decision rather than a plugin default.

**The provider is not chosen.** `docs/HOSTING.md` holds the comparison and a recommendation
(Huawei Cloud AF-Cairo, with LightNode Cairo as the fallback); nothing is contracted.
ARCHITECTURE.md §14 still carries "Decision required", and PDPL
residency (§2, §5) constrains production to Egypt while staging with synthetic data is unconstrained.
§18b's portability requirement is what makes that a deploy change rather than a rewrite: nothing
here is provider-specific except the DNS record and the object storage the backup script writes to.
