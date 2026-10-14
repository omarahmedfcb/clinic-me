// Submits the platform's WhatsApp message templates to a clinic's WhatsApp Business Account, and shows
// which ones Meta has approved.
//
//   npm run whatsapp:templates -- <tenantId>            submit what is missing, then print the status
//   npm run whatsapp:templates -- <tenantId> --status   print the status only
//
// Templates belong to the clinic's WABA, so this runs once per clinic -- after its number is connected,
// and again whenever the wording in src/modules/whatsapp/whatsapp-templates.ts changes (a changed text
// needs a new name, because Meta will not let an approved template be edited in place).
//
// Review usually takes minutes for UTILITY templates and up to a day. Reminders, cancellation notices
// and the documents link are only sent once their template is APPROVED; before that the send fails with
// Meta's "template does not exist" error and the desk is notified.

import { prisma } from "../src/prisma/client.ts";
import { withTenant } from "../src/prisma/with-tenant.ts";
import { systemActor } from "../src/modules/audit/system-actor.ts";
import { resolveWhatsAppAccess } from "../src/modules/whatsapp/whatsapp-connections.ts";
import { listWhatsAppTemplates, submitWhatsAppTemplate } from "../src/modules/whatsapp/whatsapp-graph-client.ts";
import {
  ALL_TEMPLATE_KEYS,
  TEMPLATE_LANGUAGE,
  TEMPLATES,
  templateSubmission,
} from "../src/modules/whatsapp/whatsapp-templates.ts";

async function main(): Promise<void> {
  const tenantId = process.argv[2];
  const statusOnly = process.argv.includes("--status");
  if (tenantId === undefined || tenantId.startsWith("--")) {
    throw new Error("Usage: npm run whatsapp:templates -- <tenantId> [--status]");
  }

  const appUrl = process.env["PUBLIC_APP_URL"];
  if (!statusOnly && !appUrl) {
    throw new Error("PUBLIC_APP_URL is not set. The documents button needs the address patients will open.");
  }

  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId },
    select: { name: true, whatsappPhoneNumberId: true },
  });
  if (tenant === null) throw new Error(`No clinic with id ${tenantId}.`);
  if (tenant.whatsappPhoneNumberId === null) throw new Error(`${tenant.name} has no WhatsApp number connected.`);

  const access = await resolveWhatsAppAccess(tenantId, tenant.whatsappPhoneNumberId);
  if (access === null) throw new Error(`${tenant.name} has no active WhatsApp connection.`);

  const stored = await withTenant(tenantId, await systemActor(), (tx) =>
    tx.whatsAppConnection.findFirst({ select: { wabaId: true } }),
  );
  // A clinic that signed up has its WABA id stored. A clinic on the .env test number has none, so for that
  // one case the id can be given as WHATSAPP_WABA_ID. A stored id always wins.
  const wabaId = stored?.wabaId ?? process.env["WHATSAPP_WABA_ID"];
  if (wabaId === undefined || wabaId === "") {
    throw new Error(
      `${tenant.name} runs on the .env test number, which has no stored WABA id. Set WHATSAPP_WABA_ID to its WhatsApp Business Account id, or submit the templates in Meta's WhatsApp Manager instead.`,
    );
  }

  const existing = await listWhatsAppTemplates(wabaId, access.accessToken);
  const has = (name: string): boolean =>
    existing.some((template) => template.name === name && template.language === TEMPLATE_LANGUAGE);

  if (!statusOnly) {
    for (const key of ALL_TEMPLATE_KEYS) {
      const { name } = TEMPLATES[key];
      if (has(name)) {
        console.log(`  exists     ${name}`);
        continue;
      }
      const result = await submitWhatsAppTemplate(wabaId, templateSubmission(key, appUrl as string), access.accessToken);
      console.log(`  submitted  ${name} -> ${result.status}`);
    }
  }

  console.log(`\nStatus for ${tenant.name} (WABA ${wabaId}):`);
  const after = statusOnly ? existing : await listWhatsAppTemplates(wabaId, access.accessToken);
  for (const key of ALL_TEMPLATE_KEYS) {
    const { name } = TEMPLATES[key];
    const found = after.find((template) => template.name === name && template.language === TEMPLATE_LANGUAGE);
    console.log(`  ${(found?.status ?? "NOT SUBMITTED").padEnd(14)} ${name}`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
