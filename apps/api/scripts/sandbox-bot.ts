// Issues the sandbox clinic's bot credential and points its webhook at the local echo receiver.
// Prints the three values as JSON on stdout, for the preview script's banner. Review builds only.

import { uuidv7 } from "uuidv7";
import { prisma } from "../src/prisma/client.ts";
import { injected } from "../src/prisma/injected.ts";
import { withTenant } from "../src/prisma/with-tenant.ts";
import { systemActor } from "../src/modules/audit/system-actor.ts";
import { assertSandboxScriptAllowed } from "../src/modules/bot/sandbox-policy.ts";
import { latinSearchKey } from "../src/modules/patients/domain/transliterate.ts";
import {
  issueBotCredential,
  revokeBotCredential,
  setWebhookUrl,
} from "../src/modules/bot/bot-credential.service.ts";

/**
 * The household the sandbox falls back to, for a database seeded before the seed made households
 * of its own. Three people on one number, which is the shape the bot must ask about rather than
 * assume; only the members missing from the first contact are created.
 */
const HOUSEHOLD = [
  { fullNameAr: "سلمى محمود عبد العزيز", relationship: "SELF" as const },
  { fullNameAr: "كريم محمود عبد العزيز", relationship: "SPOUSE" as const },
  { fullNameAr: "ليلى كريم محمود", relationship: "CHILD" as const },
];

/** Where the echo receiver listens. Passed in so the preview script owns the port, not this file. */
const WEBHOOK_URL = process.env["SANDBOX_WEBHOOK_URL"] ?? "http://localhost:5183/webhook";

async function main(): Promise<void> {
  assertSandboxScriptAllowed("sandbox-bot");

  // The first seeded clinic, by creation order, so "the sandbox clinic" means the same clinic on
  // both sides of a conversation about a bug.
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true, name: true } });
  if (tenant === null) throw new Error("sandbox-bot: no clinic in this database. Seed it first.");

  const actor = await systemActor();
  const ctx = { tenantId: tenant.id, actor };

  // Re-issued every time, so a rebuilt sandbox never hands out a credential the database no longer
  // honours — and revoking first is the only way past "one live credential per clinic".
  await revokeBotCredential(ctx, new Date());

  const issued = await issueBotCredential(ctx, new Date());
  if (!issued.ok) throw new Error(`sandbox-bot: could not issue a credential (${issued.code}).`);

  const url = await setWebhookUrl(ctx, WEBHOOK_URL);
  if (!url.ok) throw new Error("sandbox-bot: issued a credential and then could not find it.");

  // The ids a conversation needs. The bot has no list endpoint by design, so a developer is given
  // these the way a real clinic would give them — and the acceptance suite takes the same four.
  //
  // `phone` is a **household** number, with more than one patient on it, because that is the case
  // the contract's item 8 is about and the one the bot has to handle: one phone per family is the
  // Egyptian norm. The seed has none — 120 patients, 120 contacts, every relationship SELF — so the
  // sandbox makes one rather than handing over a number that proves the easy case.
  const fixtures = await withTenant(tenant.id, actor, async (tx) => {
    const doctor = await tx.doctor.findFirst({ select: { id: true }, orderBy: { createdAt: "asc" } });
    const service = await tx.service.findFirst({ select: { id: true }, orderBy: { createdAt: "asc" } });

    // A household the seed already made, preferred over one manufactured here: the developer and
    // the founder should be looking at the same data, and the seed's families are the review
    // build's families. Grouped in SQL because Prisma has no group-by-having on a relation count.
    const seeded = await tx.$queryRaw<{ contactId: string }[]>`
      SELECT contact_id AS "contactId"
      FROM patients
      WHERE tenant_id = ${tenant.id}::uuid AND status = 'ACTIVE'
      GROUP BY contact_id
      HAVING count(*) > 1
      ORDER BY count(*) DESC
      LIMIT 1
    `;
    const seededContactId = seeded[0]?.contactId;
    if (seededContactId !== undefined) {
      const head = await tx.patient.findFirstOrThrow({
        where: { contactId: seededContactId },
        select: { phoneE164: true },
      });
      return { phone: head.phoneE164, doctorId: doctor?.id ?? null, serviceId: service?.id ?? null };
    }

    // Fallback, for a database seeded before households existed: make one. Idempotent — a second
    // preview finds it already there and adds nobody.
    const contact = await tx.contact.findFirst({
      select: { id: true, phoneE164: true },
      orderBy: { createdAt: "asc" },
    });
    if (contact === null) return { phone: null, doctorId: doctor?.id ?? null, serviceId: service?.id ?? null };

    const existing = await tx.patient.count({ where: { contactId: contact.id, status: "ACTIVE" } });
    for (const member of HOUSEHOLD.slice(existing)) {
      await tx.patient.create({
        data: injected({
          id: uuidv7(),
          contactId: contact.id,
          fullNameAr: member.fullNameAr,
          fullNameEn: null,
          nameSearchLatin: latinSearchKey(member.fullNameAr, null),
          // The household's members are reached on the household's number, which is what makes the
          // lookup return several people for one phone.
          phoneE164: contact.phoneE164,
          relationshipToContact: member.relationship,
          status: "ACTIVE",
        }),
      });
    }

    return { phone: contact.phoneE164, doctorId: doctor?.id ?? null, serviceId: service?.id ?? null };
  });

  // An appointment belonging to a *different* clinic, for the 404-not-403 check. Read by binding
  // that clinic in turn rather than by querying across both: an unbound read of a scoped table is
  // refused by the tenant extension, which is the rule this id exists to demonstrate.
  const others = await prisma.tenant.findMany({ where: { NOT: { id: tenant.id } }, select: { id: true } });
  let foreign: { id: string } | null = null;
  for (const other of others) {
    foreign = await withTenant(other.id, actor, async (tx) => tx.appointment.findFirst({ select: { id: true } }));
    if (foreign !== null) break;
  }

  process.stdout.write(
    JSON.stringify({
      clinicId: tenant.id,
      clinicName: tenant.name,
      credentialId: issued.credentialId,
      secret: issued.secret,
      webhookSecret: issued.webhookSecret,
      webhookUrl: WEBHOOK_URL,
      ...fixtures,
      foreignAppointmentId: foreign?.id ?? null,
    }),
  );
}

main()
  .catch((error: unknown) => {
    console.error("sandbox-bot failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
