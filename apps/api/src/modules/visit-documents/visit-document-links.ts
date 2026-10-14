// The secure link a patient is sent after a visit.
//
// The token is 256 bits from the system's CSPRNG and is shown exactly once, inside the WhatsApp
// message. Only its SHA-256 is stored: a database leak (a backup, a log, a support export) then does not
// hand out working links to patients' medical documents. A fast hash is right here -- the input is
// already 256 bits of randomness, so there is nothing for a slow hash to protect, and a patient's browser
// should not wait on argon2.
//
// A link carries no identity of its own: it names a visit, and the visit names the patient and the
// clinic. That is also why it is short-lived and revocable. Anyone holding the link can read the visit's
// documents, which is the same trust a printed prescription carries once it is handed over.

import { createHash, randomBytes } from "node:crypto";
import { uuidv7 } from "uuidv7";
import { prisma } from "../../prisma/client.ts";
import { injected } from "../../prisma/injected.ts";
import type { TransactionClient } from "../../prisma/with-tenant.ts";

/** How long a link works. Long enough to find it again next month, short enough to end. */
export const DOCUMENT_LINK_TTL_DAYS = 30;

const DAY_MS = 24 * 60 * 60_000;

/** 32 random bytes as base64url: 43 characters, no padding, safe in a path segment. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function hashDocumentToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Issues a link for a visit, inside a transaction the caller owns. Any link this same message already
 * issued is revoked first: a retried send gets a fresh token, and the abandoned one from the failed
 * attempt must not stay valid.
 */
export async function issueVisitDocumentLink(
  tx: TransactionClient,
  input: { visitId: string; intentId: string | null; now: Date },
): Promise<{ token: string; expiresAt: Date }> {
  if (input.intentId !== null) {
    await tx.visitDocumentLink.updateMany({
      where: { intentId: input.intentId, revokedAt: null },
      data: { revokedAt: input.now },
    });
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(input.now.getTime() + DOCUMENT_LINK_TTL_DAYS * DAY_MS);

  await tx.visitDocumentLink.create({
    data: injected({
      id: uuidv7(),
      visitId: input.visitId,
      intentId: input.intentId,
      tokenHash: hashDocumentToken(token),
      expiresAt,
    }),
  });

  return { token, expiresAt };
}

export interface ResolvedLink {
  linkId: string;
  tenantId: string;
  visitId: string;
}

/**
 * Which link is this? Unbound, because the question being asked is which clinic it belongs to.
 *
 * Every refusal -- malformed, unknown, expired, revoked -- is the same `null`. A caller must not be
 * able to tell a guessed token that never existed from a real one that has lapsed, or the endpoint
 * becomes an oracle for confirming that a link was ever issued.
 */
export async function resolveDocumentToken(token: string, now: Date): Promise<ResolvedLink | null> {
  if (!TOKEN_SHAPE.test(token)) return null;

  const rows = await prisma.$queryRaw<
    { linkId: string; tenantId: string; visitId: string; expiresAt: Date; revokedAt: Date | null }[]
  >`
    SELECT link_id AS "linkId", tenant_id AS "tenantId", visit_id AS "visitId",
           expires_at AS "expiresAt", revoked_at AS "revokedAt"
    FROM resolve_visit_document_link(${hashDocumentToken(token)})
  `;
  const row = rows[0];
  if (row === undefined || row.revokedAt !== null || row.expiresAt.getTime() <= now.getTime()) return null;
  return { linkId: row.linkId, tenantId: row.tenantId, visitId: row.visitId };
}

/** Best-effort bookkeeping: how often a link was opened. Never allowed to fail a patient's page load. */
export async function recordLinkView(tx: TransactionClient, linkId: string, now: Date): Promise<void> {
  const link = await tx.visitDocumentLink.findFirst({ where: { id: linkId }, select: { firstViewedAt: true } });
  await tx.visitDocumentLink.update({
    where: { id: linkId },
    data: {
      viewCount: { increment: 1 },
      lastViewedAt: now,
      ...(link?.firstViewedAt === null ? { firstViewedAt: now } : {}),
    },
  });
}
