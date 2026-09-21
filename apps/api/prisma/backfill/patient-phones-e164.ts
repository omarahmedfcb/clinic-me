import { systemActor } from "../../src/modules/audit/system-actor.ts";
import { normalisePhone } from "../../src/modules/auth/phone.ts";
import { prisma } from "../../src/prisma/client.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";

/**
 * Normalises existing `patients.phone_e164`, `patients.secondary_phone` and `contacts.phone_e164`
 * to E.164, per tenant, against that tenant's own country. `npm run backfill:patient-phones`.
 *
 * Phones were stored exactly as typed until 2026-09-16, so one family's number could exist as
 * `0100 123 4567` and `+201001234567` — two households the product treats as unrelated. Phase 6
 * sends WhatsApp to these columns literally, which is why this is a prerequisite rather than tidying.
 *
 * **A row that does not parse is left exactly as it is and listed.** Deleting or blanking a number
 * a clinic relies on to reach a patient would be a worse outcome than an unnormalised string, and
 * the list is what a human needs in order to correct them. Idempotent: a value already in E.164
 * normalises to itself and is counted unchanged.
 *
 * Goes through `withTenant()` like the other backfill, so every write is RLS-scoped and the audit
 * trigger attributes it to the seeded system actor rather than to nobody.
 */

interface Skipped {
  tenantName: string;
  table: "patients" | "contacts";
  id: string;
  column: string;
  value: string;
  reason: "unparseable" | "would merge two households";
  into?: string;
}

interface TenantResult {
  tenantId: string;
  name: string;
  country: string;
  changed: number;
  unchanged: number;
  failed: number;
  conflicts: number;
}

type SupportedCountry = "EG" | "SA" | "AE";

async function run(): Promise<void> {
  const tenants = await prisma.tenant.findMany({
    select: { id: true, name: true, country: true },
    orderBy: { name: "asc" },
  });

  const actor = await systemActor();
  const results: TenantResult[] = [];
  const skipped: Skipped[] = [];

  for (const tenant of tenants) {
    const country = tenant.country as SupportedCountry;
    const result: TenantResult = {
      tenantId: tenant.id,
      name: tenant.name,
      country,
      changed: 0,
      unchanged: 0,
      failed: 0,
      conflicts: 0,
    };

    await withTenant(tenant.id, actor, async (tx) => {
      const contacts = await tx.contact.findMany({ select: { id: true, phoneE164: true } });
      for (const contact of contacts) {
        const normalised = normalisePhone(contact.phoneE164, country);
        if (normalised === null) {
          result.failed += 1;
          skipped.push({
            tenantName: tenant.name,
            table: "contacts",
            id: contact.id,
            column: "phone_e164",
            value: contact.phoneE164,
            reason: "unparseable",
          });
          continue;
        }
        if (normalised === contact.phoneE164) {
          result.unchanged += 1;
          continue;
        }

        /*
         * The case this migration exists for is also the one that cannot be automated: when
         * `0100 123 4567` normalises onto a contact that already holds `+201001234567`, those are
         * two households the clinic has been treating as separate. `contacts` is unique on
         * (tenant, phone), so the update would fail — and merging them reassigns patients between
         * households, which is a decision somebody has to make, not a side effect of a backfill.
         */
        const occupied = await tx.contact.findFirst({
          where: { phoneE164: normalised, id: { not: contact.id } },
          select: { id: true },
        });
        if (occupied !== null) {
          result.conflicts += 1;
          skipped.push({
            tenantName: tenant.name,
            table: "contacts",
            id: contact.id,
            column: "phone_e164",
            value: contact.phoneE164,
            reason: "would merge two households",
            into: occupied.id,
          });
          continue;
        }

        await tx.contact.update({ where: { id: contact.id }, data: { phoneE164: normalised } });
        result.changed += 1;
      }

      const patients = await tx.patient.findMany({
        select: { id: true, phoneE164: true, secondaryPhone: true },
      });
      for (const patient of patients) {
        for (const [column, value] of [
          ["phone_e164", patient.phoneE164],
          ["secondary_phone", patient.secondaryPhone],
        ] as const) {
          if (value === null || value === "") continue;

          const normalised = normalisePhone(value, country);
          if (normalised === null) {
            result.failed += 1;
            skipped.push({ tenantName: tenant.name, table: "patients", id: patient.id, column, value, reason: "unparseable" });
            continue;
          }
          if (normalised === value) {
            result.unchanged += 1;
            continue;
          }
          await tx.patient.update({
            where: { id: patient.id },
            data: column === "phone_e164" ? { phoneE164: normalised } : { secondaryPhone: normalised },
          });
          result.changed += 1;
        }
      }
    });

    results.push(result);
  }

  for (const row of results) {
    process.stdout.write(
      `${row.name} (${row.country}): changed ${row.changed}, unchanged ${row.unchanged}, ` +
        `failed ${row.failed}, conflicts ${row.conflicts}\n`,
    );
  }

  const totals = results.reduce(
    (sum, row) => ({
      changed: sum.changed + row.changed,
      unchanged: sum.unchanged + row.unchanged,
      failed: sum.failed + row.failed,
      conflicts: sum.conflicts + row.conflicts,
    }),
    { changed: 0, unchanged: 0, failed: 0, conflicts: 0 },
  );
  process.stdout.write(
    `\nTOTAL: changed ${totals.changed}, unchanged ${totals.unchanged}, ` +
      `failed ${totals.failed}, conflicts ${totals.conflicts}\n`,
  );

  if (skipped.length > 0) {
    process.stdout.write(`\nLeft untouched — a person has to decide these:\n`);
    for (const row of skipped) {
      const into = row.into === undefined ? "" : ` -> would collide with ${row.into}`;
      process.stdout.write(
        `  [${row.reason}] ${row.tenantName}  ${row.table}.${row.column}  ${row.id}  ` +
          `${JSON.stringify(row.value)}${into}\n`,
      );
    }
  }

  await prisma.$disconnect();
}

void run();
