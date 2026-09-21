# Server setup — Huawei Cloud AF-Cairo, from a bare image to a clinic logging in

For the ops developer standing up and running the pilot server. You have **SSH on the server and
read access to this repository**. You do not have write access to `develop`, and nothing here asks
you to change code: where this runbook and the code disagree, the code wins and the disagreement is
a message to Amir, not a patch.

`docs/DEPLOY.md` is the reasoning behind these steps and is worth reading once. This document is the
sequence. `docs/HOSTING.md` is why the provider is Huawei Cloud AF-Cairo.

**The rule that outranks everything below: patient data and backups never leave Egypt.** Every
resource here is created in the **AF-Cairo (`af-north-1`)** region. If a console page offers you a
different region, you are on the wrong page.

---

## 0. Before you start, and a blocker to read first

> ### The blocker this document opened with is closed
>
> `docker-compose.server.yml` now passes the `api` service `SLOT_TOKEN_SECRET` and every attachment
> setting, and mounts a named volume for the local backend (2026-09-18). `node
> scripts/check-server-compose.mjs` re-checks that against the API's own list and runs in CI, so the
> file cannot quietly lose one again. If that command fails on the checkout you were given, stop and
> tell Amir: it means the file and the code disagree, and §6 would fail at `docker compose up`.

**What Amir provides before you start.** None of it can be derived from this document:

| | |
|---|---|
| ECS instance | Ubuntu 24.04 LTS, 2 vCPU / 4 GiB, in **AF-Cairo**, with your SSH public key |
| EVS volume | 100 GB, attached, for `/var/lib/docker` and the database |
| Elastic IP | Bound to the instance |
| DNS | An `A` record for the public hostname pointing at that EIP, **created before §5** |
| OBS buckets | Two, in AF-Cairo, **private**: one for attachments, one for backups |
| OBS credentials | An access key / secret pair scoped to those two buckets |
| Age recipient | The **public** half only, for encrypting backups. The private half never reaches this server |
| SMN topic | With Amir's phone subscribed, for alerts |
| Repository | Read access, and the commit or tag to deploy |

**What you never do**, each for a reason `docs/DEPLOY.md` §8 gives in full: no production secret
through chat, a ticket or a commit — generate them on the server; never give the `api` service
`DATABASE_URL`; never publish port 5432; never run the seed against production; never copy
production data into staging or your laptop.

---

## 1. The shape you are building

Everything runs in Docker on one ECS instance, from `docker-compose.server.yml`:

| Container | What it is |
|---|---|
| `postgres` | PostgreSQL 16, **self-managed**, no published port. Data on the EVS volume |
| `migrate` | Runs `prisma migrate deploy` and exits. The only thing that connects as the superuser |
| `api` | NestJS on :3000, internal only |
| `web` | Caddy: serves the built SPA, proxies `/api`, terminates TLS on :80/:443 |

Outside the instance: **OBS** holds attachments and the encrypted backups, **Cloud Eye + SMN** watch
and alert. There is no load balancer and no managed database in the pilot shape — `docs/HOSTING.md`
§8 records why.

---

## 1b. Encrypt the disks — at creation, and only at creation

**A02, ruled 2026-09-19.** Tick **encryption** on the system disk *and* on the EVS data volume in the
ECS creation form, with the default KMS key for AF-Cairo. Patient data and every WAL segment live on
that volume, and a disk that leaves a datacentre unencrypted is a copy of the clinic's records.

This step has no second chance, which is why it has its own section: **an EVS volume cannot be
encrypted after it is created.** Correcting it later means creating an encrypted volume, copying the
data across and swapping them — during clinic hours, on a server already holding real records. Five
seconds now, or an afternoon later.

Confirm it before installing anything:

```bash
# Both volumes must report encrypted. From a shell with the Huawei CLI configured — or read the
# same two fields in the console, under the instance's Disks tab.
hcloud evs ListVolumes \
  --cli-query "volumes[?attachments[0].server_id=='<INSTANCE_ID>'].{name:name,encrypted:encrypted}"
```

If either says `false`, rebuild the instance. Nothing below is worth doing on an unencrypted volume.

---

## 2. The host: bare image to hardened

SSH in as the image's default user, then:

```bash
# Packages, clock, and unattended security updates.
sudo apt-get update && sudo apt-get -y upgrade
sudo apt-get -y install unattended-upgrades ufw fail2ban curl git
sudo dpkg-reconfigure -f noninteractive unattended-upgrades
sudo timedatectl set-timezone UTC          # The app takes timezone as a parameter; the host stays UTC.

# A named user for day-to-day work, in the docker group (added in §3).
sudo adduser --disabled-password --gecos "" clinicops
sudo mkdir -p /home/clinicops/.ssh && sudo cp ~/.ssh/authorized_keys /home/clinicops/.ssh/
sudo chown -R clinicops:clinicops /home/clinicops/.ssh && sudo chmod 700 /home/clinicops/.ssh

# Keys only, no root login.
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo systemctl restart ssh

# Only 22, 80 and 443 from outside. The database is never exposed.
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw --force enable
```

**Verify before moving on**: open a *second* SSH session as `clinicops` and keep it open. If key-only
login is broken, you want to find out while you still have a working session.

The Huawei security group is a second firewall in front of `ufw`. Allow 22, 80 and 443 there too, and
nothing else.

---

## 3. Docker

```bash
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo tee /etc/apt/keyrings/docker.asc > /dev/null
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker clinicops
```

Log out and back in as `clinicops`, then `docker run --rm hello-world`.

**Put Docker's data on the EVS volume**, not the small system disk — the database lives in a Docker
volume. If `/var/lib/docker` is not already on it: stop Docker, move the directory onto the mounted
volume, symlink or set `data-root` in `/etc/docker/daemon.json`, start Docker, and confirm with
`docker info | grep "Docker Root Dir"`.

---

## 4. The repository

```bash
sudo mkdir -p /opt/clinic-os && sudo chown clinicops:clinicops /opt/clinic-os
git clone <repository-url> /opt/clinic-os
cd /opt/clinic-os
git checkout <the commit or tag Amir named>
git log -1 --oneline     # Record this. Every later question starts with "which commit is running?"
```

---

## 5. Secrets, and the trap that follows them

Generate them **on this machine**. A secret that has been pasted into a chat or a ticket is burned.

```bash
openssl rand -base64 36    # POSTGRES_PASSWORD
openssl rand -base64 36    # the clinic_os_app password
openssl rand -base64 48    # JWT_SECRET
openssl rand -base64 48    # SLOT_TOKEN_SECRET
```

Write `/etc/clinic-os.env`, owned by root, mode `600`. `apps/api/.env.example` documents every
variable; this is the server's set:

```ini
# Postgres, inside the compose network only.
POSTGRES_USER=clinic_os
POSTGRES_PASSWORD=<first secret>
POSTGRES_DB=clinic_os
DATABASE_URL=postgresql://clinic_os:<first secret>@postgres:5432/clinic_os?schema=public
APP_DATABASE_URL=postgresql://clinic_os_app:<second secret>@postgres:5432/clinic_os?schema=public

JWT_SECRET=<third secret>
SLOT_TOKEN_SECRET=<fourth secret>
SITE_ADDRESS=<the public hostname, e.g. app.nomed-os.com>

# Attachments in OBS, in Cairo. "local" would put patient scans on this disk instead.
ATTACHMENTS_STORAGE_BACKEND=s3
ATTACHMENTS_S3_ENDPOINT=https://obs.af-north-1.myhuaweicloud.com
ATTACHMENTS_S3_BUCKET=<attachments bucket>
ATTACHMENTS_S3_REGION=af-north-1
ATTACHMENTS_S3_ACCESS_KEY_ID=<access key>
ATTACHMENTS_S3_SECRET_ACCESS_KEY=<secret key>
```

> ### The trap: `clinic_os_app` has no password until you set one
>
> The migration creates that role deliberately without one — a password in a checked-in migration
> would be a secret in Git. Until you run the command in §6 step 2, the API cannot authenticate, and
> the symptom is a **health check that never goes green**, not an error naming the cause.
>
> `-e PGPASSWORD` is not optional in that command, and omitting it is the second half of the trap:
> with `scram-sha-256` auth, `psql` prompts for a password, and through `exec -T` a prompt looks like
> a hang. `docs/DEPLOY.md` §3 has the full story.

---

## 6. First deploy

**The first `up` is expected to fail once.** That is the trap above, not a broken compose file.

```bash
cd /opt/clinic-os
set -a && . /etc/clinic-os.env && set +a   # For the psql command below only.

# 1. Build, start Postgres, run migrations. The api container will fail its health check.
docker compose -f docker-compose.server.yml --env-file /etc/clinic-os.env up -d --build

# 2. Give clinic_os_app the password that is already inside APP_DATABASE_URL.
docker compose -f docker-compose.server.yml --env-file /etc/clinic-os.env \
  exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "ALTER ROLE clinic_os_app WITH PASSWORD '<second secret>';"

# 3. Bring it up again. The API reconnects and web starts behind it.
docker compose -f docker-compose.server.yml --env-file /etc/clinic-os.env up -d
docker compose -f docker-compose.server.yml --env-file /etc/clinic-os.env ps
```

**Do not run `npm run seed` here.** It is synthetic data for a laptop, and it refuses a database that
already holds tenants — but on a production box the right answer is simply never to run it.

Verify, in this order:

```bash
curl -fsS https://<SITE_ADDRESS>/api/health && echo OK    # {"status":"ok","database":"reachable"}
curl -sI https://<SITE_ADDRESS> | head -1                  # 200, and a real certificate
```

If TLS fails, the usual cause is the DNS `A` record: Caddy requests a certificate on boot, and
Let's Encrypt rate-limits repeated failures. Fix DNS, then `docker compose ... restart web`.

**Prove the isolation rules survived the deploy**, rather than assuming:

```bash
# The app role must not bypass RLS, and the API container must not hold DATABASE_URL.
docker compose -f docker-compose.server.yml --env-file /etc/clinic-os.env \
  exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "select rolname, rolsuper, rolbypassrls from pg_roles where rolname in ('clinic_os_app','clinic_os_definer');"
# Expect f | f on both rows.

docker compose -f docker-compose.server.yml --env-file /etc/clinic-os.env exec -T api env | grep -c '^DATABASE_URL=' || echo "0 — correct"
```

---

## 7. First login

The product has no self-service signup, by design. The first operator is created here, and every
clinic is created by that operator in the platform console.

```bash
# The name is read from a FILE, never from the command line: Arabic through a shell payload is
# mangled silently, and an operator's name is exactly the field that would carry one.
cat > /tmp/operator.json <<'JSON'
{ "fullName": "…", "phoneE164": "+20…", "email": "…" }
JSON

docker compose -f docker-compose.server.yml --env-file /etc/clinic-os.env \
  run --rm --entrypoint npm -e APP_DATABASE_URL -e DATABASE_URL migrate run platform:admin -- /tmp/operator.json
rm /tmp/operator.json
```

It prints a password **once**. Hand it to Amir through whatever channel you would use for a password
— never a ticket — and do not keep a copy.

Then, in a browser at `https://<SITE_ADDRESS>`: the operator signs in, is required to enrol a second
factor (TOTP), and is shown recovery codes once. **In production the second factor cannot be turned
off**; the review build's `OPERATOR_TOTP=off` is a review convenience that refuses to boot when
`NODE_ENV=production`. From there the operator creates the first clinic and its first ADMIN, and
that ADMIN sets up doctors, services and staff.

---

## 8. Backups: nightly, encrypted, off the machine

`scripts/backup/backup.mjs` takes the dump and the attachments, encrypts each to the age **public**
key, and uploads both to the backups bucket. The private key is not on this server: a host
compromise must not hand over the clinic's history.

Build the image once:

```bash
cd /opt/clinic-os/scripts/backup && docker build -t clinic-os-backup .
```

Write `/etc/clinic-os-backup.env` (root, `600`):

```ini
BACKUP_DATABASE_URL=postgresql://clinic_os:<first secret>@postgres:5432/clinic_os
BACKUP_AGE_RECIPIENT=age1…                       # public half only
BACKUP_S3_ENDPOINT=https://obs.af-north-1.myhuaweicloud.com
BACKUP_S3_BUCKET=<backups bucket>
BACKUP_S3_REGION=af-north-1
AWS_ACCESS_KEY_ID=<access key>
AWS_SECRET_ACCESS_KEY=<secret key>
# Attachments live in OBS, so the backup copies that bucket down and archives it.
ATTACHMENTS_STORAGE_BACKEND=s3
ATTACHMENTS_S3_ENDPOINT=https://obs.af-north-1.myhuaweicloud.com
ATTACHMENTS_S3_BUCKET=<attachments bucket>
ATTACHMENTS_S3_REGION=af-north-1
```

Cron, 02:30 UTC daily:

```cron
30 2 * * * docker run --rm --network clinic-os_default --env-file /etc/clinic-os-backup.env clinic-os-backup >> /var/log/clinic-os-backup.log 2>&1
```

Run it once by hand and read the output. It prints the size of each artefact and refuses anything
below its floor — `attachments: 305 bytes is below the 1000-byte floor` is the script telling you it
was pointed at the wrong place, and is the single most useful failure it can produce.

---

## 9. The nightly restore, which is the only thing that makes the above a backup

```cron
30 3 * * * docker run --rm --network clinic-os_default --env-file /etc/clinic-os-drill.env -v /etc/clinic-os-age-identity.txt:/identity/key.txt:ro --entrypoint node clinic-os-backup /opt/backup/restore-drill.mjs >> /var/log/clinic-os-drill.log 2>&1 || /usr/local/bin/clinic-os-alert "restore drill failed"
```

`/etc/clinic-os-drill.env` carries the same bucket settings plus `DRILL_DATABASE_URL`,
`SOURCE_DATABASE_URL`, `DRILL_APP_DATABASE_URL` and `BACKUP_AGE_IDENTITY_FILE=/identity/key.txt`.

**This is the one place the private age key is needed.** Decide with Amir whether it lives on this
host at all: a drill that runs here needs it, and a key here means a host compromise can read the
backups. The alternative is running the drill somewhere else. Whatever is chosen, it is **never** in
the bucket the dumps are in.

**Prove the drill can fail before you trust it.** Point it at a truncated dump and watch it exit
non-zero. A restore job nobody has seen fail is a cron entry, not a backup.

---

## 9b. The WhatsApp webhook dispatcher

Only needed once a clinic has a bot: it queues tomorrow's reminders and delivers everything owed to
the clinic's registered webhook (`docs/WHATSAPP-BOT-CONTRACT.md` §6). Every minute, because a
confirmation the patient reads ten minutes after booking is not a confirmation:

```cron
* * * * * docker compose -f /srv/clinic-os/docker-compose.server.yml exec -T api npm run webhook:dispatch >> /var/log/clinic-os-webhook.log 2>&1
```

Overlapping runs are safe: one reminder per appointment and one delivery per act are both database
constraints, not application checks. The log line names what happened —
`reminders_queued=3 delivered=2 skipped:NO_CONSENT=1` — and `skipped:NO_CONSENT` is normal, not a
fault: nothing is sent to a patient who has not agreed to be messaged on WhatsApp.

A delivery that never succeeds is retried at 1m, 5m, 15m, 1h, 3h, 6h and 12h, then given up on and
written to that clinic's own audit trail. **Nothing at the desk waits for any of this**, so a bot
whose endpoint is down never slows a receptionist down.

---

## 10. Alerting: Cloud Eye and SMN

1. In **SMN** (AF-Cairo), confirm the topic Amir created and that his number is subscribed.
2. Install the **Cloud Eye agent** on the instance, from the Huawei console's own instructions for
   this region — they change, and a copy here would go stale.
3. Alarm rules, all notifying that SMN topic: instance unreachable; CPU above 90% for 5 minutes;
   **disk above 80%**, which is the one that actually bites, because the database and Docker share
   the volume.
4. An HTTP check on `https://<SITE_ADDRESS>/api/health` from **outside this instance** — Cloud Eye
   site monitoring, or any external checker. A monitor running on the host it watches cannot report
   that the host is gone.
5. A small `/usr/local/bin/clinic-os-alert` that publishes a message to the SMN topic, so the cron
   entries above can call it.
6. **The two alarms that are about the application rather than the machine — A09, ruled
   2026-09-19.** Everything above notices a server in trouble; none of it notices a *person* in
   trouble.

   - **Refusal rate.** Caddy's access log is the source: alarm when 401, 403 and 429 responses
     together exceed **30 in five minutes**. A run of 401s is somebody guessing a password; a run of
     403s is a credential reaching for what it does not hold; a run of 429s is a script. Ship the
     log to Cloud Eye's Log Tank Service, add a metric filter on the status field, alarm on its sum.
   - **Break-glass access.** Alarm on **any** `BREAK_GLASS_ACCESS` row in `audit_logs`. Not a rate —
     one is the threshold, because that row means somebody reached a patient's record through the
     emergency path, and the clinic is owed the question "why".

   ```bash
   # Every five minutes, from cron. It keeps its own watermark, so a restart cannot replay
   # yesterday's alerts into somebody's phone at 3am.
   */5 * * * * /usr/local/bin/clinic-os-break-glass-watch >> /var/log/clinic-os-audit-watch.log 2>&1
   ```

   ```bash
   #!/usr/bin/env bash
   # /usr/local/bin/clinic-os-break-glass-watch
   set -euo pipefail
   mark=/var/lib/clinic-os/break-glass.at
   mkdir -p "$(dirname "$mark")"
   since=$(cat "$mark" 2>/dev/null || date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%S)
   rows=$(docker compose -f /srv/clinic-os/docker-compose.server.yml exec -T postgres \
     psql -qtAX -U "$POSTGRES_USER" -d clinic_os \
     -c "SELECT count(*) FROM audit_logs WHERE action = 'BREAK_GLASS_ACCESS' AND created_at > '$since'")
   date -u +%Y-%m-%dT%H:%M:%S > "$mark"
   [ "$rows" -gt 0 ] && /usr/local/bin/clinic-os-alert "break-glass access used $rows time(s) — ask why"
   exit 0
   ```

   **Prove both before trusting either**: drive failed logins past the limit and watch the refusal
   alarm fire; use the break-glass path once on the review build and watch the message arrive. An
   alarm nobody has seen fire is a configuration screenshot.

**Then break it on purpose and time it**: `docker compose ... stop api`, wait for the message to
arrive on the phone, note how long it took, start it again. Record that number in your hand-back.
Note that **SMN sends SMS to Egyptian numbers**, while Huawei's separate Message & SMS product is not
available to enterprises in Egypt (`docs/HOSTING.md` §1) — use SMN.

---

## 11. Deploying a new release

Migrations run before the new image goes live, and every migration stays backward-compatible for one
release, so a rollback does not need a down-migration.

```bash
cd /opt/clinic-os
git fetch --all --tags
git checkout <new tag or commit>
git log -1 --oneline

# The release gate, first and always: the clinical leak sweep, the compose configuration check and
# the server-environment check. It exits non-zero on the first failure and names what failed.
# A release that cannot pass this does not go out — see docs/SECURITY-REVIEW.md §4d.
# A08: what CI recorded this commit's API image to be. Download it from the `image-digest` job's
# artefact for this exact commit and drop it beside the checkout, then build the image under the
# name the gate compares. The gate refuses a mismatch — the tag you are deploying would not be the
# artefact CI checked — and says so plainly when either number is missing.
gh run download --repo <owner>/clinic-os --name "image-digest-$(git rev-parse HEAD)" --dir .
docker build -f docker/Dockerfile.api -t clinic-os-api:local .

npm run release:gate

# Build and run migrations, then the new containers. `migrate` gates `api` in the compose file:
# if it fails, the API does not start and the previous container keeps serving.
docker compose -f docker-compose.server.yml --env-file /etc/clinic-os.env up -d --build

curl -fsS https://<SITE_ADDRESS>/api/health && echo OK
docker compose -f docker-compose.server.yml --env-file /etc/clinic-os.env ps
docker compose -f docker-compose.server.yml --env-file /etc/clinic-os.env logs --tail=50 api
```

**Take a backup first** (`§8`, run by hand), and do it during clinic downtime — the pilot clinic's
day is the thing being protected.

**Rolling back** is the same sequence with the previous tag. If a release included a migration,
check with Amir before rolling back: the code is designed to tolerate the previous schema for one
release, and that is a promise about one step, not several.

---

## 12. When something is wrong

| Symptom | First thing to check |
|---|---|
| `api` never healthy after a deploy | The `clinic_os_app` password (§5's trap). `docker compose logs api` |
| TLS fails or the certificate will not issue | DNS `A` record, then ports 80 and 443 in both `ufw` and the security group |
| Uploads fail, everything else works | OBS credentials and bucket name in `/etc/clinic-os.env`; the API checks the bucket at boot, so also read the boot logs |
| Backup log shows a size-floor refusal | The backup is pointed at the wrong place — most often `ATTACHMENTS_STORAGE_BACKEND` disagreeing with the API's |
| Disk filling | `docker system df`, old images; then the EVS volume itself |
| "Is it up?" | `curl https://<SITE_ADDRESS>/api/health` from somewhere that is not the server |

**A restore is not in this list on purpose.** If you need one, that is a conversation with Amir
before a command: `docs/DEPLOY.md` §7c has the order, including that the obvious order silently
half-restores.

---

## 13. Hand back this evidence

Not a claim that each step was done — the output that shows it:

1. The commit running, from `git log -1 --oneline`.
2. `/api/health` over HTTPS, and the certificate issuer.
3. `rolsuper`/`rolbypassrls` both false, and the API container without `DATABASE_URL`.
4. One backup run's output, and the two objects listed in the bucket.
5. One restore drill's output, including its elapsed time — and the output of the deliberately
   failed one.
6. The alert message on the phone, with the seconds from `stop api` to its arrival.
7. The first operator created, second factor enrolled, recovery codes stored by Amir.
