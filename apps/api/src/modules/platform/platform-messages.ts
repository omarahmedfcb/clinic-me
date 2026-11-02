// Operator messages (BRANCHES-DESIGN §9 D, step 6.4): to one clinic's admins or every active clinic's, in-system only.
// One transaction: the vendor's record, then deliver_operator_message() writes one copy per admin. No tenant is bound here.
import { uuidv7 } from "uuidv7";
import type { RefusalParams } from "../../common/refusals.ts";
import { withPlatformActor, type ActorContext } from "../../prisma/with-tenant.ts";

export type SendResult =
  | { ok: true; value: { id: string; clinics: number; recipients: number } }
  | { ok: false; code: "NOT_FOUND"; params: RefusalParams };

export interface SentMessage {
  id: string;
  audience: string;
  targetTenantId: string | null;
  targetClinicName: string | null;
  body: string;
  senderName: string;
  createdAt: Date;
  clinics: number;
  recipients: number;
  reads: number;
}

export async function sendOperatorMessage(actor: ActorContext, input: { body: string; tenantId?: string }): Promise<SendResult> {
  const id = uuidv7();
  return withPlatformActor<SendResult>(actor, async (tx) => {
    if (input.tenantId !== undefined && (await tx.tenant.count({ where: { id: input.tenantId } })) === 0) {
      return { ok: false as const, code: "NOT_FOUND" as const, params: { resource: "clinic" as const } };
    }
    await tx.operatorMessage.create({
      data: { id, senderId: actor.userId, audience: input.tenantId === undefined ? "ALL_CLINICS" : "ONE_CLINIC", targetTenantId: input.tenantId ?? null, body: input.body.trim() },
    });
    const [delivered] = await tx.$queryRaw<{ clinics: number; recipients: number }[]>`SELECT * FROM deliver_operator_message(${id}::uuid)`;
    return { ok: true as const, value: { id, clinics: delivered?.clinics ?? 0, recipients: delivered?.recipients ?? 0 } };
  });
}

export async function listSentMessages(actor: ActorContext): Promise<SentMessage[]> {
  return withPlatformActor(actor, (tx) =>
    tx.$queryRaw<SentMessage[]>`
      SELECT id, audience::text AS audience, target_tenant_id AS "targetTenantId", target_clinic_name AS "targetClinicName", body,
             sender_name AS "senderName", created_at AS "createdAt", clinics, recipients, reads
        FROM platform_operator_messages()`,
  );
}
