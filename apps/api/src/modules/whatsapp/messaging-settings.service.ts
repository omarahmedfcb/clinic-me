// The clinic's switches for the WhatsApp messages it sends on its own initiative.
//
// Each message is billed by Meta to the clinic's own WhatsApp account, and the reminder can cancel an
// appointment, so every switch starts OFF and belongs to the people who own the clinic: `clinicSettings.manage`,
// which a doctor and a receptionist do not hold.

import { withTenant } from "../../prisma/with-tenant.ts";
import type { CallerContext } from "../appointments/appointments.service.ts";
import type { SaveMessagingSettingsDto } from "./messaging-settings.dto.ts";

export interface MessagingSettings {
  appointmentRemindersEnabled: boolean;
  reminderLeadHours: number;
  reminderConfirmWindowHours: number;
  callInMessageEnabled: boolean;
  visitDocumentsLinkEnabled: boolean;
}

const SELECT = {
  appointmentRemindersEnabled: true,
  reminderLeadHours: true,
  reminderConfirmWindowHours: true,
  callInMessageEnabled: true,
  visitDocumentsLinkEnabled: true,
} as const;

export function getMessagingSettings(caller: CallerContext): Promise<MessagingSettings> {
  return withTenant(caller.tenantId, caller.actor, (tx) =>
    tx.tenant.findUniqueOrThrow({ where: { id: caller.tenantId }, select: SELECT }),
  );
}

export function saveMessagingSettings(caller: CallerContext, input: SaveMessagingSettingsDto): Promise<MessagingSettings> {
  return withTenant(caller.tenantId, caller.actor, (tx) =>
    // Omitted fields are `undefined`, which Prisma leaves untouched. The tenants table's own audit
    // trigger records who changed what, so nothing is logged here.
    tx.tenant.update({
      where: { id: caller.tenantId },
      data: {
        appointmentRemindersEnabled: input.appointmentRemindersEnabled,
        reminderLeadHours: input.reminderLeadHours,
        reminderConfirmWindowHours: input.reminderConfirmWindowHours,
        callInMessageEnabled: input.callInMessageEnabled,
        visitDocumentsLinkEnabled: input.visitDocumentsLinkEnabled,
      },
      select: SELECT,
    }),
  );
}
