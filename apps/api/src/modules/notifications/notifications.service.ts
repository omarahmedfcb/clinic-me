import type { NotificationKind } from "../../generated/prisma/client.ts";
import { injected } from "../../prisma/injected.ts";
import { withTenant, type ActorContext, type TransactionClient } from "../../prisma/with-tenant.ts";

/**
 * Notifications: reading them, and the one function that writes them.
 *
 * ## Written inside the caller's transaction
 *
 * `recordNotification` takes a `tx`, not a `CallerContext`, and that is deliberate. It is called
 * from inside `bookAppointment`'s and `changeAppointmentStatus`'s existing transaction, so a
 * booking that rolls back cannot leave behind a notification claiming it happened. A notification
 * written in its own transaction would be a second source of truth about whether something
 * occurred, and the two would disagree on exactly the request that failed.
 *
 * ## Read state is per membership
 *
 * A person holds memberships in several clinics, so unread counts are computed against
 * `membershipId` from the validated token — never against the user. See PHASE-2.md §16.
 */

export interface NotificationCaller {
  tenantId: string;
  membershipId: string;
  actor: ActorContext;
}

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  appointmentId: string | null;
  patientId: string | null;
  occurredAt: Date;
  source: string;
  /** Only what the list renders. Never clinical content. */
  payload: unknown;
  read: boolean;
}

/** The whole notifiable set. A closed union so a new kind is a decision, not a side effect. */
export interface NotificationInput {
  kind: NotificationKind;
  appointmentId: string;
  patientId: string;
  source: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
}

/**
 * Write one notification, inside a transaction the caller already owns.
 *
 * `payload` must carry only what the list renders. There is no clinical content in any of the
 * three kinds by construction — a booking, a cancellation and a reschedule are appointment
 * metadata, which §8 makes visible to reception — but this is the place a future kind could smuggle
 * some in, so the rule is stated here rather than assumed.
 */
export async function recordNotification(
  tx: TransactionClient,
  actorUserId: string,
  input: NotificationInput,
): Promise<void> {
  await tx.notification.create({
    data: injected({
      kind: input.kind,
      appointmentId: input.appointmentId,
      patientId: input.patientId,
      actorUserId,
      source: input.source as never,
      occurredAt: input.occurredAt,
      payload: input.payload as never,
    }),
  });
}

/**
 * How many notifications this membership has not read.
 *
 * The bell polls this every fifteen seconds, so it is one indexed anti-join and nothing else — no
 * payloads, no joins to patients, no ordering. The list is fetched only when the bell is opened.
 */
export async function unreadCount(caller: NotificationCaller): Promise<number> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    return tx.notification.count({
      where: { reads: { none: { membershipId: caller.membershipId } } },
    });
  });
}

/**
 * The most recent notifications, newest first, with this membership's read state.
 *
 * Capped rather than paginated: a bell dropdown that scrolls forever is a list nobody reads to the
 * end of, and anything older than the last fifty items is history the day view already shows.
 */
export async function listNotifications(
  caller: NotificationCaller,
  limit = 50,
): Promise<NotificationItem[]> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const rows = await tx.notification.findMany({
      // Two notifications can share an instant -- a cancellation recorded at the same `now` as the
      // booking it cancels, which is exactly what a test does. `id` breaks the tie deterministically
      // because ids are UUIDv7 (D6) and therefore time-ordered; without it Postgres is free to
      // return ties in any order and the newest item is whichever the planner felt like.
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: Math.min(Math.max(limit, 1), 50),
      include: { reads: { where: { membershipId: caller.membershipId }, select: { id: true } } },
    });

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      appointmentId: row.appointmentId,
      patientId: row.patientId,
      occurredAt: row.occurredAt,
      source: row.source,
      payload: row.payload,
      read: row.reads.length > 0,
    }));
  });
}

/**
 * Mark notifications read for this membership.
 *
 * `createMany` with `skipDuplicates`, because the unique constraint on
 * `(notification_id, membership_id)` makes a second click a no-op rather than an error — and a
 * bell that throws when you open it twice is worse than one that does nothing.
 *
 * Marking read is a write that D16 would normally audit; `notification_reads` is deliberately
 * exempt from the audit triggers (see `prisma/sql/17-notifications.sql`), because it records that
 * someone *looked*, not that anything changed.
 */
export async function markRead(
  caller: NotificationCaller,
  notificationIds: string[],
): Promise<number> {
  if (notificationIds.length === 0) return 0;

  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    // Filtered through a tenant-scoped read first: an id from another clinic is invisible here, so
    // it is silently dropped rather than inserted against a row the caller cannot see.
    const visible = await tx.notification.findMany({
      where: { id: { in: notificationIds } },
      select: { id: true },
    });

    const result = await tx.notificationRead.createMany({
      data: visible.map((row) =>
        injected({ notificationId: row.id, membershipId: caller.membershipId }),
      ),
      skipDuplicates: true,
    });
    return result.count;
  });
}
