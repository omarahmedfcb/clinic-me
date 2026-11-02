// Support access, PR 1 (docs/SUPPORT-ACCESS.md): the operator switches a clinic's flag. The database refuses "on" without a
// current contract carrying the data-processor clause; this only names that refusal. "Off" is always allowed.
import { withPlatformActor, type ActorContext } from "../../prisma/with-tenant.ts";
import type { ClinicResult } from "./platform-clinics.ts";

const NEEDS_CLAUSE = "support access needs a current contract with the data-processor clause";

export async function setSupportAccess(actor: ActorContext, tenantId: string, input: { enabled: boolean; reason: string }): Promise<ClinicResult<{ enabled: boolean }>> {
  if (input.reason.trim() === "") return { ok: false, code: "REASON_REQUIRED", params: {} };
  try {
    return await withPlatformActor<ClinicResult<{ enabled: boolean }>>(actor, async (tx) => {
      const tenant = await tx.tenant.findFirst({ where: { id: tenantId }, select: { supportAccessEnabled: true } });
      if (tenant === null) return { ok: false as const, code: "NOT_FOUND" as const, params: { resource: "clinic" as const } };
      if (tenant.supportAccessEnabled === input.enabled) {
        return { ok: false as const, code: "ALREADY_IN_THAT_STATE" as const, params: { status: input.enabled ? "ENABLED" : "DISABLED" } };
      }
      await tx.tenant.update({ where: { id: tenantId }, data: { supportAccessEnabled: input.enabled } });
      return { ok: true as const, value: { enabled: input.enabled } };
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes(NEEDS_CLAUSE)) return { ok: false, code: "DATA_PROCESSOR_CLAUSE_REQUIRED", params: {} };
    throw error;
  }
}
