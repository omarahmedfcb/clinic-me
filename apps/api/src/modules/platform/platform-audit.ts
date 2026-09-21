// Every operator action is audited — 0f. `platform-audit.spec.ts` names each `/platform/*` write
// route and how it is audited, and fails when one appears that is in neither list.

import { injectedIdOnly } from "../../prisma/injected.ts";
import { withPlatformActor, withTenant, type ActorContext } from "../../prisma/with-tenant.ts";

/**
 * Writes one `audit_logs` row for an operator action.
 *
 * **`BREAK_GLASS_ACCESS` stops being emitted by nothing here.** `PHASE-1.md` §6 flagged that the
 * action had existed in the enum since Phase 1 with no writer — "the correct state today, and a
 * defect the moment a support path exists without it". This is that support path.
 *
 * `tenantId` is the clinic acted upon, so the row lands inside that clinic's own trail and its
 * admin can see what was done to them. It is written through `injectedIdOnly` for the reason
 * `recordSensitiveRead` documents: `AuditLog` is registered nullable-tenant, so the extension
 * injects an id and nothing else.
 */
export async function recordOperatorAction(
  actor: ActorContext,
  input: {
    /** The clinic acted upon. Required: the row belongs in that clinic's trail, not in limbo. */
    tenantId: string;
    action: "CREATE" | "UPDATE" | "BREAK_GLASS_ACCESS";
    entityType: string;
    entityId: string;
    /**
     * Never a password, never a clinical field. What was done, and to what.
     *
     * Scalars only, by type: an audit row is readable by the clinic it describes, and a nested
     * object here is how a payload starts carrying more than the sentence it was written for.
     */
    detail: Record<string, string | number | boolean | null>;
  },
): Promise<void> {
  // Bound to the clinic being acted on. `audit_logs` carries `WITH CHECK (tenant_id = <bound>)`, so
  // an unbound write is refused — correctly: a row nobody's session matches is a row the clinic it
  // describes could never read, which is the opposite of what auditing the operator is for.
  await withTenant(input.tenantId, actor, async (tx) => {
    await tx.auditLog.create({
      data: injectedIdOnly({
        tenantId: input.tenantId,
        actorUserId: actor.userId,
        // Not a `MembershipRole`: the operator holds no membership, and writing one of the clinic's
        // roles here would make the trail claim they were a member of it.
        actorRole: "PLATFORM_ADMIN",
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        newState: input.detail,
        ipAddress: actor.ip,
        userAgent: actor.userAgent,
      }),
    });
  });
}

/**
 * One audit row for an operator action that belongs to **no clinic** — seating an operator,
 * changing a seat, clearing a lost second factor.
 *
 * `recordOperatorAction` above cannot be used for these: it names a tenant, because the point of it
 * is that the clinic's own administrator can read what was done to them. Who we hire is not theirs
 * to read, and there is no tenant to bind in the first place.
 *
 * The write goes through `record_platform_audit()` rather than Prisma. `audit_logs` carries
 * `WITH CHECK (tenant_id = <bound tenant>)` and `clinic_os_app` is NOBYPASSRLS, so an unbound insert
 * of a NULL-tenant row is refused from the application — correctly. That function is the one narrow,
 * named exception, and it cannot write a row belonging to a tenant even if asked to.
 */
export async function recordPlatformAction(
  actor: ActorContext,
  input: {
    action:
      | "CREATE"
      | "UPDATE"
      | "BREAK_GLASS_ACCESS"
      | "OPERATOR_RECOVERY_CODE_USED"
      | "OPERATOR_TOTP_REPLACED";
    entityType: string;
    entityId: string;
    /** Scalars only, for the reason `recordOperatorAction` gives: never a password, never a secret. */
    detail: Record<string, string | number | boolean | null>;
  },
): Promise<void> {
  await withPlatformActor(actor, async (tx) => {
    await tx.$executeRaw`
      SELECT record_platform_audit(
        ${input.action}::"AuditAction",
        ${input.entityType},
        ${input.entityId}::uuid,
        ${JSON.stringify(input.detail)}::jsonb
      )`;
  });
}
