// A clinic admin's inbox of operator messages (BRANCHES-DESIGN §9 D, step 6.4): only the caller's own copies, newest first.
// A read is a row of its own, so marking twice is one read; the notice bar and inbox screens are step 8.
import { uuidv7 } from "uuidv7";
import { injected } from "../../prisma/injected.ts";
import { withTenant, type ActorContext } from "../../prisma/with-tenant.ts";

export interface InboxCaller {
  tenantId: string;
  actor: ActorContext;
}

export interface InboxMessage {
  id: string;
  body: string;
  sentAt: Date;
  readAt: Date | null;
}

export async function listInbox(caller: InboxCaller): Promise<{ messages: InboxMessage[]; unread: number }> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const rows = await tx.operatorMessageRecipient.findMany({
      where: { userId: caller.actor.userId },
      select: { id: true, body: true, sentAt: true, read: { select: { readAt: true } } },
      orderBy: { sentAt: "desc" },
      take: 200,
    });
    const messages = rows.map((row) => ({ id: row.id, body: row.body, sentAt: row.sentAt, readAt: row.read?.readAt ?? null }));
    return { messages, unread: messages.filter((m) => m.readAt === null).length };
  });
}

export async function unreadCount(caller: InboxCaller): Promise<number> {
  return withTenant(caller.tenantId, caller.actor, (tx) =>
    tx.operatorMessageRecipient.count({ where: { userId: caller.actor.userId, read: { is: null } } }),
  );
}

/** False when the message is not the caller's: the controller answers 404, never 403. */
export async function markRead(caller: InboxCaller, recipientId: string): Promise<boolean> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const mine = await tx.operatorMessageRecipient.findFirst({ where: { id: recipientId, userId: caller.actor.userId }, select: { id: true, read: { select: { id: true } } } });
    if (mine === null) return false;
    if (mine.read === null) await tx.operatorMessageRead.create({ data: injected({ id: uuidv7(), recipientId }) });
    return true;
  });
}
