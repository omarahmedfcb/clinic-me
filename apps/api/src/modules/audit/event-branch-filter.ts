// Which audit events a reader sees (BRANCHES-DESIGN §4.6): any entry of the WHOLE transaction ONE_BRANCH in the read set,
// or UNSCOPED or BEFORE_BRANCHES (ruled 2026-10-31: the viewer's other filters never hide one). Null outside a request.
import { Prisma } from "../../generated/prisma/client.ts";
import { readSet } from "../../common/branch-read.ts";

/** A condition on audit row `a`: its transaction (same actor, same instant) holds an entry this reader may see. */
export function eventVisible(): Prisma.Sql | null {
  const set = readSet();
  if (set === null) return null;
  const suspended = set.suspended.map((b) => Prisma.sql` OR (w.branch_id = ${b.id}::uuid AND w.created_at < ${b.suspendedAt})`);
  return Prisma.sql`EXISTS (
    SELECT 1 FROM audit_logs w
     WHERE w.tenant_id = a.tenant_id AND w.created_at = a.created_at AND w.actor_user_id = a.actor_user_id
       AND (w.scope <> 'ONE_BRANCH' OR w.branch_id = ANY(${[...set.active]}::uuid[])${suspended.length === 0 ? Prisma.empty : Prisma.join(suspended, "")}))`;
}
