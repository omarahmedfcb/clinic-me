# Hosting — the decision record

**Open. Recommendation below; the decision is the founder's.** One day of checking, 2026-09-18,
against Huawei Cloud's own documentation, its published SDK region lists and its public price
calculator. LightNode Cairo is carried as the documented fallback.

**The standing rule governs everything here: patient data and backups never leave Egypt.** Both
options keep compute, database, attachments and backups inside the Cairo region; nothing below
proposes a cross-border copy, and the backup bucket is in the same country as the database.

**How each fact below was checked.** Marketing pages were not treated as evidence. Region
availability comes from Huawei's own SDK region tables and its documentation; prices come from
driving the public price calculator in a browser with the region control **asserted to read
AF-Cairo before each reading** — the calculator silently resets the region to CN-Hong Kong when the
database engine is changed, and a first pass produced Hong Kong prices that looked like Cairo ones.
Anything that could not be verified this way is marked **unverified** rather than estimated.

---

## 1. Is the Cairo region real, and what is in it

**AF-Cairo is region ID `af-north-1`.** Huawei lists AF-Cairo among the international regions, and
the region ID appears in the per-service region tables shipped in Huawei's own Go SDK.

| What we need | In AF-Cairo? | Evidence |
|---|---|---|
| ECS (compute) | Yes | `ecs.af-north-1.myhuaweicloud.com` in the SDK; selectable in the price calculator |
| RDS **for PostgreSQL** | Yes | `rds.af-north-1...` in the SDK; with AF-Cairo selected the calculator offers engine PostgreSQL and **versions 14, 15, 16, 17, 18** |
| OBS (object storage) | Yes | Selectable and priced in the calculator under AF-Cairo |
| EVS (block storage) | Yes | `evs.af-north-1...`; priced under AF-Cairo |
| Cloud Eye (CES, monitoring) | Yes | `ces.af-north-1...` |
| SMN (notifications, incl. SMS) | Yes | `smn.af-north-1...`; SMN's country list includes **Egypt (country code 20)** |
| ELB (load balancer) | Yes | `elb.af-north-1...` |
| EIP / bandwidth | Yes | The ECS calculator offers EIP with Dynamic BGP under AF-Cairo |
| CBR (cloud backup) | Yes | `cbr.af-north-1...` |

**What is NOT in Cairo, and it matters:**

- **SCM (Cloud Certificate Manager) has no `af-north-1` endpoint** — its SDK region list is
  `cn-north-4`, `ap-southeast-1`, `my-kualalumpur-1` only. A Huawei-issued/managed TLS certificate
  is therefore not a Cairo service. TLS is still available two ways: upload our own certificate to
  ELB, or keep Caddy on the ECS instance terminating Let's Encrypt as `docker-compose.server.yml`
  already does. **The second needs no new service and no new code**, so it is what the
  recommendation assumes.
- **Message & SMS (the enterprise SMS product) is not available to enterprises in Egypt.** Its
  supported list names the UAE but not Egypt. This does not block alerting: **SMN** sends SMS to
  Egyptian numbers, and SMN is in Cairo. The alert path is Cloud Eye → SMN topic → SMS/email.
- **EVS snapshots specifically** were not verified as a Cairo feature — EVS is there, its snapshot
  sub-feature was not separately confirmed. **Unverified.**

---

## 2. What the pilot shape costs

Prices are USD per month, from the public calculator, region asserted as AF-Cairo, **excluding VAT**
(the calculator says so itself). Each row records the exact configuration priced.

| Item | Configuration priced | USD/month |
|---|---|---|
| ECS | `c7n.large.2`, 2 vCPU / 4 GiB, AlmaLinux 9, 40 GB general-purpose SSD, EIP auto-assigned (Dynamic BGP), Yearly/Monthly | **97.03** |
| RDS for PostgreSQL | **PostgreSQL 16**, Primary/Standby (HA), general-purpose 2 vCPU / 4 GB, Cloud SSD 40 GB, 1 month | **115.06** |
| EVS | General-purpose SSD, 10 GB, 1 month | **1.10** |
| EVS, 100 GB | Linear extrapolation from the 10 GB reading (~0.11/GB) — **not read directly** | ~11 |
| OBS | Available and priced in Cairo; **the unit rates for stored GB, requests and egress were not captured** | **unverified** |
| Egress at pilot volume | Not captured — bandwidth is bundled into the EIP line above and priced by Mbit/s, not by GB | **unverified** |

**Rough pilot total: about USD 225–235/month before VAT**, for one ECS, one HA PostgreSQL, 100 GB of
block storage, and an EIP — with OBS storage and any egress beyond the EIP's bandwidth still to be
priced.

**One inconsistency, left visible rather than smoothed over.** The same ECS configuration read
USD 293.00 when "Required Duration" was 1 year and USD 97.03 at 1 month. Those cannot both be right
(12 × 97.03 = 1,164). One of the two readings is picking up a different bandwidth or discount, and
**the yearly commitment price must be confirmed in the console before it is relied on.**

### LightNode Cairo, the fallback

Published plans, Cairo, dedicated CPU, 50 GB NVMe, hourly or monthly:

| Plan | vCPU | RAM | Disk | Traffic | USD/month |
|---|---|---|---|---|---|
| Start | 1 | 2 GB | 50 GB | 1 TB | 21.20 |
| Agency | 2 | 4 GB | 50 GB | 1 TB | 40.70 |
| Premium | 4 | 8 GB | 50 GB | 2 TB | 80.70 |
| Enterprise | 8 | 16 GB | 50 GB | 2 TB | 158.70 |

**Like for like, LightNode is roughly a fifth of the price and gives us nothing managed.** On
LightNode we run Postgres ourselves in the compose file we already have, we own backups, failover
and monitoring, and there is no object storage in Egypt to put encrypted backups in — which is the
part that matters most, because a backup on the same VM as the database is not a backup
(`PILOT-READINESS.md` 1a). That gap has to be filled either way: a second location inside Egypt for
the backup copy, or Huawei OBS.

---

## 3. Account, payment and invoicing for a UAE company

- **Real-name verification** is required only to buy in **Chinese mainland** regions. AF-Cairo is an
  international region, so the heavyweight identity process does not apply; an enterprise account
  still supplies company name, address, contact and industry, and enterprise verification asks for a
  certificate whose registered name, country and registration number match exactly.
- **Payment:** credit card and bank transfer are both supported on the international site.
- **Invoicing a UAE company works, and the contracting entity is a UAE one.** Huawei's own tax
  documentation names **Sparkoo Technologies — Sole Proprietorship L.L.C. ("UAE Sparkoo")**, a UAE
  VAT registrant (TRN 100453584300003), which **charges 5% UAE VAT to UAE customers** and issues a
  Tax Invoice to customers with a TRN (a Simplified Tax Invoice without one). So an invoice to
  **Rahal Group FZE LLC** is ordinary, and **5% VAT lands on top of every figure in §2** — about
  USD 11–12/month at the pilot shape.

---

## 4. Compliance — the weakest part of the case

- Huawei publishes an **Egypt compliance page** that names Egypt's **Personal Data Protection Law
  151/2020** and states that Huawei Cloud complies with Egyptian law, including Law 175/2018.
- **No Cairo-specific data-residency commitment was found in Huawei's own documentation.** The
  residency claims located are marketing and partner pages, not a contractual term. The commitment
  we need has to come from the **DPA and the contract**, not from a web page.
- **ISO 27001:** Huawei Cloud holds it, and the published scope statement says "over 80 data
  centres" **without naming Cairo**. Whether `af-north-1` is inside the certificate's scope has to
  be read off the certificate itself, which is behind the compliance-certificates download.
- **No evidence was found of a PDPC registration or licence** held by Huawei for Egypt, in either
  direction. Egypt's Personal Data Protection Centre registration obligations fall on us as
  controller/processor regardless.

**What to ask Huawei in writing, before signing:** the data-residency clause for `af-north-1`; the
ISO 27001 certificate naming the Cairo facilities; their DPA text and their processor commitments
under Law 151/2020; and whether support staff outside Egypt can access data in the region.

---

## 5. Mapping our compose stack onto managed services

| Today (`docker-compose.server.yml`) | Managed equivalent | Code change |
|---|---|---|
| `postgres:16` container | RDS for PostgreSQL 16, Primary/Standby | **Yes — see §6.** Connection strings move to the RDS endpoint; the app role must be created through `root` |
| Attachments on a local volume (`ATTACHMENTS_STORAGE_ROOT`) | OBS bucket | **Built 2026-09-18.** `ATTACHMENTS_STORAGE_BACKEND=s3` selects `s3.provider.ts` (SigV4 by hand, no SDK); the backup copies the bucket down so a restore still brings the files back. Proven against MinIO by `scripts/backup/s3-attachments-drill.mjs` |
| Backup target (MinIO in testing) | OBS, same region | **No.** `scripts/backup/backup.mjs` already drives the `aws` CLI with `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`, `BACKUP_S3_BUCKET` — OBS exposes an S3-compatible endpoint, so this is configuration |
| Caddy terminating TLS | Keep Caddy on the ECS instance (SCM is not in Cairo), or ELB with an uploaded certificate | **No** if Caddy stays |
| Nothing watches `/health` | Cloud Eye alarm → SMN topic → SMS to an Egyptian number | **No** code change; this is `PILOT-READINESS.md` 2c |

**Extensions are fine.** RDS for PostgreSQL supports both extensions our migrations create,
`btree_gist` and `pg_trgm`, on PostgreSQL 13–17, installed with ordinary `CREATE EXTENSION`.

**Creating our app role is fine.** Huawei's own permissions guide shows `root` running `CREATE USER`
and `CREATE ROLE`, which is what `20260821194449_app_role` needs to create `clinic_os_app`.

---

## 6. The finding that decides the migration, proven rather than assumed

**On RDS there is no superuser — `root` is explicitly not one — and that changes how our RLS model
behaves.** 46 of our tables carry `FORCE ROW LEVEL SECURITY`, and **FORCE applies the policies to
the table's owner too**. Today the owner is the local superuser `clinic_os`, and a superuser bypasses
RLS unconditionally, so our `SECURITY DEFINER` helpers — the membership lookups, the tenant-creation
function, and `read_orphaned_audit_logs()`, the audited break-glass reader — read what they are meant
to read. Under a non-superuser owner they are subject to the very policies they exist to step around.

Proven on a throwaway database (created, probed and dropped; the review database was not touched),
with one table under `ENABLE` + `FORCE ROW LEVEL SECURITY`, a tenant-isolation policy, two rows (one
with `tenant_id IS NULL`), and the same `SECURITY DEFINER` function defined twice:

| Function owner | Rows the break-glass reader returns |
|---|---|
| Superuser (today's shape) | **1** |
| Ordinary role, `NOSUPERUSER NOBYPASSRLS` (managed shape) | **0** |

**A silent zero, not an error.** The function succeeds and returns nothing, which is exactly the
failure mode this project keeps finding: it looks like "no orphaned audit rows" rather than like a
break.

**This is not a Huawei problem** — it is true of AWS RDS, Azure and any managed PostgreSQL, and it is
a reason to know about it before the pilot rather than during it.

### Closed, 2026-09-18

The schema no longer needs a superuser. Migration `20260918080000_definer_role_portability` gives the
`SECURITY DEFINER` helpers their own owner, `clinic_os_definer` (`NOLOGIN NOSUPERUSER NOBYPASSRLS`),
which holds explicit policies for exactly what their bodies read and write — narrower than the
superuser bypass it replaces, since that bypassed every policy on every table. One separate
portability defect was found on the way: the app-role migration wrote `ALTER DEFAULT PRIVILEGES FOR
ROLE clinic_os`, hardcoding this machine's `POSTGRES_USER`, which a managed instance refuses outright.

Measured against a database owned by a `NOSUPERUSER NOBYPASSRLS` role, migrated by it:

| | Integration suite |
|---|---|
| Before | **134 failed**, 600 passed — 156 errors on `new row violates row-level security policy for table audit_logs` |
| After | **734 passed**, 0 failed, with all 11 `SECURITY DEFINER` functions owned by `clinic_os_definer` |

`scripts/rls-ownership-drill.mjs` is that run, and the `rls-ownership` CI job is what stops it
regressing. The drill derives the function list from the catalogue and refuses any helper left owned
by the migration role — proven by adding a stray one: 0 strays green, 1 stray refused by name.

---

## 7. What a one-day trial must prove before we commit

1. `prisma migrate deploy` runs to completion against a Cairo RDS PostgreSQL 16 instance, as `root`.
   *(Proven locally against a non-superuser owner — 53 migrations — but not against RDS itself.)*
2. `clinic_os_app` exists afterwards with `rolsuper = false` and `rolbypassrls = false`.
3. The tenant-isolation integration suite passes against that instance, unchanged. *(Passes locally
   under the §6 drill; RDS may still differ — `root` there may lack privileges this drill's owner
   holds, `CREATEROLE` in particular.)*
4. `read_orphaned_audit_logs()` returns rows — the §6 finding, closed locally, to be confirmed there.
5. `scripts/backup/backup.mjs` writes both artefacts to an OBS bucket through the S3 endpoint, and
   `restore-drill.mjs` restores them. The `aws` CLI's multipart upload against OBS is the specific
   risk.
6. A Cloud Eye alarm reaches a phone when the API is stopped, and the time is recorded.

---

## 8. Recommendation

**Huawei Cloud AF-Cairo, provided §7 passes and Huawei answers §4 in writing.** It is the only one of
the two that gives us, inside Egypt: a managed PostgreSQL with a standby, object storage for
encrypted off-machine backups, and monitoring that can reach a phone — the three things
`PILOT-READINESS.md` items 1a, 1c and 2c need and that a single VPS cannot provide. The cost, about
USD 225–235/month plus 5% VAT, is proportionate at one pilot clinic and does not grow per clinic.

**LightNode Cairo is the documented fallback**, and becomes the recommendation if §7 fails, if the
residency and ISO scope answers do not come in writing, or if the founder wants to spend
USD 40.70/month during the pilot instead. Taking it means accepting that we run PostgreSQL, its
failover and its backups ourselves — and that we still have to find a second place inside Egypt to
put the encrypted backup copies.

### Alternatives considered and rejected

- **A non-Egyptian region (cheaper, more mature)** — rejected: patient data and backups never leave
  Egypt, and PDPL makes that a legal position rather than a preference.
- **GaussDB instead of RDS for PostgreSQL** — rejected for the pilot: it is a different engine, and
  our 46 FORCE-RLS tables and hand-written SQL are tested against community PostgreSQL 16.
- **ELB in front of the ECS instance from day one** — rejected for now: with SCM absent from Cairo it
  adds a certificate to manage and a service to pay for, and Caddy already terminates TLS.
