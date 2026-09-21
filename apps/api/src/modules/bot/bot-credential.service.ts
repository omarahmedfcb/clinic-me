// Issuing, revoking and authenticating one clinic's bot credential. docs/WHATSAPP-BOT-CONTRACT.md §2.

import { randomBytes } from "node:crypto";
import { uuidv7 } from "uuidv7";
import { prisma } from "../../prisma/client.ts";
import { injected } from "../../prisma/injected.ts";
import { withTenant } from "../../prisma/with-tenant.ts";
import { hashPassword, verifyPasswordHash } from "../auth/password.ts";
import { botUserIdentifier } from "./bot-identifier.ts";
import { generateWebhookSecret } from "./webhook-signing.ts";
import type { CallerContext } from "../patients/patients.service.ts";

/** What the clinic sees. Never the secret, which exists in plaintext only in the issue response. */
export interface BotCredentialSummary {
  credentialId: string;
  issuedAt: Date;
  issuedByUserId: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  /** Where we call. The signing secret is never part of this, or of any other read. */
  webhookUrl: string | null;
}

export type IssueResult =
  | { ok: true; credentialId: string; secret: string; webhookSecret: string }
  | { ok: false; code: "ALREADY_ISSUED" };

function isDuplicateLiveCredential(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  const meta = JSON.stringify((error as { meta?: unknown }).meta ?? null);
  return code === "P2002" && meta.includes("bot_credentials_one_active_per_tenant");
}

/**
 * A new credential, and the only moment its secret exists outside the caller's hands.
 *
 * 32 random bytes, hashed with the same Argon2id the staff passwords use. A credential that can be
 * read back from the database is one a database backup hands to whoever holds it — and this one
 * authenticates software running outside our network.
 *
 * The bot's identity is an `AI_AGENT` membership created here alongside the credential, because the
 * two have no separate life: the capability set lives on the membership, and a credential without
 * one would authenticate as nothing.
 */
export async function issueBotCredential(ctx: CallerContext, now: Date): Promise<IssueResult> {
  const secret = randomBytes(32).toString("base64url");
  const secretHash = await hashPassword(secret);
  // Issued together and revoked together: one act gives the bot its voice and its ears.
  const webhookSecret = generateWebhookSecret();
  const credentialId = uuidv7();

  try {
    await withTenant(ctx.tenantId, ctx.actor, async (tx) => {
      // The bot's user row is global, like every user; its membership is what scopes it to a clinic.
      const botUserId = uuidv7();
      await prisma.user.create({
        data: {
          id: botUserId,
          // Not a phone number: the reserved +999 range, which no person can hold and no login can
          // resolve. See bot-identifier.ts for why a plausible mobile was the wrong thing to store.
          phoneE164: botUserIdentifier(),
          passwordHash: "bot-credentials-do-not-use-a-password",
          fullName: "WhatsApp bot",
          status: "ACTIVE",
        },
      });

      const membershipId = uuidv7();
      await tx.membership.create({
        data: injected({ id: membershipId, userId: botUserId, role: "AI_AGENT", status: "ACTIVE" }),
      });

      await tx.botCredential.create({
        data: injected({
          id: credentialId,
          membershipId,
          secretHash,
          issuedByUserId: ctx.actor.userId,
          issuedAt: now,
          webhookSecret,
        }),
      });
    });
  } catch (error) {
    // The partial unique index is what refuses a second live credential, so two administrators
    // issuing at the same instant meet the same answer as two sequential ones.
    //
    // The constraint name is read from Prisma's `meta`, not from the message: for a partial index the
    // message says "Unique constraint failed on the (not available)", and matching on the text
    // would have quietly turned every P2002 here — a colliding bot user phone, say — into
    // "already issued". Naming the index is what makes this refusal mean one thing.
    if (isDuplicateLiveCredential(error)) return { ok: false, code: "ALREADY_ISSUED" };
    throw error;
  }

  return { ok: true, credentialId, secret, webhookSecret };
}

/**
 * Revokes the live credential, and suspends the membership behind it.
 *
 * Both, deliberately. Revoking the credential stops a new token being minted; suspending the
 * membership stops the token already minted, on its **next request** — `MembershipFreshnessInterceptor`
 * re-reads the membership on every authenticated call, which is the mechanism 4c describes for staff.
 * Revoking only the credential would leave a bot working until its access token expired.
 */
export async function revokeBotCredential(
  ctx: CallerContext,
  now: Date,
): Promise<{ ok: true } | { ok: false; code: "NOT_FOUND" }> {
  return withTenant(ctx.tenantId, ctx.actor, async (tx) => {
    const live = await tx.botCredential.findFirst({
      where: { revokedAt: null },
      select: { id: true, membershipId: true },
    });
    if (live === null) return { ok: false as const, code: "NOT_FOUND" as const };

    await tx.botCredential.update({
      where: { id: live.id },
      data: { revokedAt: now, revokedByUserId: ctx.actor.userId },
    });
    await tx.membership.update({ where: { id: live.membershipId }, data: { status: "SUSPENDED" } });

    return { ok: true as const };
  });
}

/** The live credential's summary, or null. Read by the clinic settings screen. */
export async function describeBotCredential(ctx: CallerContext): Promise<BotCredentialSummary | null> {
  return withTenant(ctx.tenantId, ctx.actor, async (tx) => {
    const live = await tx.botCredential.findFirst({
      where: { revokedAt: null },
      select: {
        id: true, issuedAt: true, issuedByUserId: true, lastUsedAt: true, revokedAt: true, webhookUrl: true,
      },
    });
    if (live === null) return null;
    return {
      credentialId: live.id,
      issuedAt: live.issuedAt,
      issuedByUserId: live.issuedByUserId,
      lastUsedAt: live.lastUsedAt,
      revokedAt: live.revokedAt,
      webhookUrl: live.webhookUrl,
    };
  });
}

export interface AuthenticatedBot {
  tenantId: string;
  membershipId: string;
  userId: string;
}

interface ResolvedCredential {
  credentialId: string;
  tenantId: string;
  membershipId: string;
  userId: string;
  secretHash: string;
  revokedAt: Date | null;
  membershipStatus: string;
}

/**
 * Checks a credential and returns who it is, or null.
 *
 * Through `resolve_bot_credential`, not the table: this lookup has no tenant to bind, because the
 * credential is what says which clinic it belongs to. Same escape hatch, and the same narrowness, as
 * `resolve_active_membership` for a staff login (prisma/sql/04-membership-lookup-functions.sql).
 *
 * A revoked credential and a wrong secret are the same answer, and the verify runs either way: a
 * revoked id that returned faster than a live one would tell a caller which ids had once existed.
 */
export async function authenticateBotCredential(
  credentialId: string,
  secret: string,
  now: Date,
): Promise<AuthenticatedBot | null> {
  const rows = await prisma.$queryRaw<ResolvedCredential[]>`
    SELECT credential_id AS "credentialId", tenant_id AS "tenantId", membership_id AS "membershipId",
           user_id AS "userId", secret_hash AS "secretHash", revoked_at AS "revokedAt",
           membership_status AS "membershipStatus"
    FROM resolve_bot_credential(${credentialId}::uuid)
  `;
  const credential = rows[0] ?? null;

  const hash =
    credential?.secretHash ??
    "$argon2id$v=19$m=65536,t=3,p=4$notarealsaltnotarealsalt$notarealhashnotarealhashnotarealhashnotareal";
  const matches = await verifyPasswordHash(hash, secret);

  if (credential === null || !matches) return null;
  if (credential.revokedAt !== null || credential.membershipStatus !== "ACTIVE") return null;

  await prisma.$queryRaw`SELECT note_bot_credential_use(${credential.credentialId}::uuid, ${now}::timestamptz)`;

  return {
    tenantId: credential.tenantId,
    membershipId: credential.membershipId,
    userId: credential.userId,
  };
}

/**
 * Where the clinic's bot listens. HTTPS only, and a CHECK constraint says the same thing in the
 * database — a URL is configuration a person types, and this one carries a patient's first name.
 */
export async function setWebhookUrl(
  ctx: CallerContext,
  url: string,
): Promise<{ ok: true } | { ok: false; code: "NOT_FOUND" }> {
  return withTenant(ctx.tenantId, ctx.actor, async (tx) => {
    const live = await tx.botCredential.findFirst({ where: { revokedAt: null }, select: { id: true } });
    if (live === null) return { ok: false as const, code: "NOT_FOUND" as const };

    await tx.botCredential.update({ where: { id: live.id }, data: { webhookUrl: url } });
    return { ok: true as const };
  });
}
