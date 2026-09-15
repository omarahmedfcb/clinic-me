import { systemActor } from "../../src/modules/audit/system-actor.ts";
import { latinKeyCoverage, latinSearchKey } from "../../src/modules/patients/domain/transliterate.ts";
import { prisma } from "../../src/prisma/client.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";

/**
 * Recomputes `patients.name_search_latin` for every patient in every tenant.
 * `npm run backfill:name-search-latin`.
 *
 * ## Why this exists at all, and why it will be run more than once
 *
 * `name_search_latin` is the *volatile* half of the D19 design: the transliteration dictionary is
 * a table of Egyptian names we expect to keep extending, and every extension leaves existing rows
 * holding a key computed under the old table. Unlike `name_search_ar`, which Postgres recomputes
 * because it is `GENERATED`, nothing recomputes this one on its own. That is the trade D19 made
 * deliberately — the stable half cannot drift, the volatile half can be improved without dropping
 * and re-adding a column — and this script is the other side of it.
 *
 * **Run it after any change to the dictionary.** It is idempotent: it computes the same value the
 * application would write and stores it, so running it twice changes nothing the second time.
 *
 * ## It goes through withTenant(), like everything else
 *
 * There is no bypass, and none is needed. Patients are RLS-protected, so this iterates tenants and
 * binds each one rather than connecting as the migration superuser — which would work, and would
 * also be the one code path in the system that could write across tenant boundaries. The audit
 * trigger fires on every update, attributing the change to the seeded system actor, exactly as the
 * nightly job does. A backfill that rewrote a column on every patient record without leaving an
 * audit trail is not something this schema should be able to express.
 */

const CHUNK_SIZE = 200;

interface TenantResult {
  tenantId: string;
  name: string;
  updated: number;
  unchanged: number;
  coverage: { full: number; partial: number; none: number };
}

async function backfillTenant(tenantId: string, name: string, actorUserId: string): Promise<TenantResult> {
  const actor = { userId: actorUserId, ip: "127.0.0.1", userAgent: "backfill:name-search-latin" };
  const result: TenantResult = {
    tenantId,
    name,
    updated: 0,
    unchanged: 0,
    coverage: { full: 0, partial: 0, none: 0 },
  };

  // Paginated by id rather than by offset: this writes to the same rows it is reading, and an
  // offset walk over a table being updated can skip or repeat rows.
  let after: string | undefined;
  for (;;) {
    const patients = await withTenant(tenantId, actor, async (tx) =>
      tx.patient.findMany({
        where: after === undefined ? {} : { id: { gt: after } },
        orderBy: { id: "asc" },
        take: CHUNK_SIZE,
        select: { id: true, fullNameAr: true, fullNameEn: true, nameSearchLatin: true },
      }),
    );
    if (patients.length === 0) break;
    after = patients.at(-1)?.id;

    const changed = patients
      .map((patient) => ({ patient, key: latinSearchKey(patient.fullNameAr, patient.fullNameEn) }))
      .filter((row) => row.key !== row.patient.nameSearchLatin);

    for (const patient of patients) {
      result.coverage[latinKeyCoverage(patient.fullNameAr)] += 1;
    }

    await withTenant(tenantId, actor, async (tx) => {
      for (const row of changed) {
        await tx.patient.update({ where: { id: row.patient.id }, data: { nameSearchLatin: row.key } });
      }
    });

    result.updated += changed.length;
    result.unchanged += patients.length - changed.length;
  }

  return result;
}

async function main(): Promise<void> {
  const actor = await systemActor();
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true }, orderBy: { id: "asc" } });

  if (tenants.length === 0) {
    console.log("No tenants. Nothing to backfill.");
    return;
  }

  const results: TenantResult[] = [];
  for (const tenant of tenants) {
    results.push(await backfillTenant(tenant.id, tenant.name, actor.userId));
  }

  let totalPartial = 0;
  let totalNone = 0;
  let totalPatients = 0;
  for (const result of results) {
    const { full, partial, none } = result.coverage;
    const seen = full + partial + none;
    totalPartial += partial;
    totalNone += none;
    totalPatients += seen;
    console.log(`${result.name}`);
    console.log(`  patients            ${seen}`);
    console.log(`  updated             ${result.updated}`);
    console.log(`  already correct     ${result.unchanged}`);
    console.log(`  dictionary coverage full ${full}  partial ${partial}  none ${none}`);
    console.log("");
  }

  // PARTIAL is the health signal, not NONE -- see D19. Egyptian given names are effectively a
  // closed set and the dictionary already holds them, so a name is rarely unrecognised outright.
  // Family names are not a closed set: new surnames arrive continuously, and a patient with a known
  // given name and an unknown surname yields a non-NULL key that is missing the part reception most
  // often searches by. The dictionary therefore degrades as a rising partial rate while the NULL
  // count sits near zero, and watching NULL alone would report "fine" throughout.
  const partialShare = totalPatients === 0 ? 0 : (100 * totalPartial) / totalPatients;
  const noneShare = totalPatients === 0 ? 0 : (100 * totalNone) / totalPatients;
  console.log(`Partially recognised: ${totalPartial}/${totalPatients} patients (${partialShare.toFixed(1)}%)  <-- the signal to watch`);
  console.log(`No Latin key at all:  ${totalNone}/${totalPatients} patients (${noneShare.toFixed(1)}%)`);
  if (partialShare > 5) {
    console.log(
      "\nPartial coverage is above 5%. That is almost always missing FAMILY names -- extend the " +
        "family-name section of src/modules/patients/domain/transliterate.ts and re-run this.",
    );
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
