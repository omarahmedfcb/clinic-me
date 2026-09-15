import { prisma } from "../../prisma/client.ts";
import type { ActorContext } from "../../prisma/with-tenant.ts";

/**
 * The actor an unattended process writes as -- ARCHITECTURE.md §9's nightly no-show auto-marking
 * job, seed scripts, data migrations. SCHEMA-DECISIONS.md D16: the audit trigger refuses a write
 * with no actor bound, and the answer to that is not a weaker trigger but a real, named,
 * auditable identity for operations that legitimately have no human behind them.
 *
 * The id is resolved from the database, once, rather than written down here. Repeating the UUID
 * as a TypeScript constant would make this file a second place the value lives, free to drift
 * from prisma/sql/06-system-actor.sql, which is the one that actually creates the row -- and the
 * row is the thing that matters, since audit_logs.actor_user_id is a NOT NULL foreign key into
 * users. A constant that no longer matches a row would fail at write time, on whatever unattended
 * job happened to run next, at whatever hour it is scheduled for.
 *
 * `ip` and `userAgent` say plainly what this is. They are not HTTP facts and there is nothing
 * truthful to put in them; a fabricated 127.0.0.1 would be worse than a label that cannot be
 * mistaken for a real client.
 */
let cachedId: Promise<string> | undefined;

async function resolveSystemActorId(): Promise<string> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`SELECT system_actor_id() AS id`;
  const id = rows[0]?.id;
  if (!id) {
    throw new Error(
      "system_actor_id() returned no row. The system actor is created by " +
        "prisma/sql/06-system-actor.sql -- this database is missing that migration.",
    );
  }
  return id;
}

export async function systemActor(): Promise<ActorContext> {
  cachedId ??= resolveSystemActorId();
  return {
    userId: await cachedId,
    ip: "system",
    userAgent: "system",
  };
}
