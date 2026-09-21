// The vendor's own people — operator roles and the second factor every one of them must hold.
// Seating an operator is the OWNER's act alone; everything else here is about proving possession.

import { uuidv7 } from "uuidv7";
import type { RefusalParams } from "../../common/refusals.ts";
import { prisma } from "../../prisma/client.ts";
import { withPlatformActor, type ActorContext } from "../../prisma/with-tenant.ts";
import { hashPassword, verifyPasswordHash } from "../auth/password.ts";
import { normalisePhone, loginCountry } from "../auth/phone.ts";
import { generateTemporaryPassword } from "../memberships/staff.service.ts";
import {
  generateRecoveryCodes,
  isWellFormedRecoveryCode,
  normaliseRecoveryCode,
} from "./recovery-codes.ts";
import { generateTotpSecret, otpauthUri, verifyTotp } from "./totp.ts";

/**
 * The four seats.
 *
 * OWNER is the only one that can create another operator, and the only one that can change a role —
 * the rest of the difference is what the console shows them, which is a screen decision rather than
 * a permission one until there is something to withhold. Written down as a list so that adding a
 * fifth is a migration to the CHECK, not a string somebody types.
 */
export const OPERATOR_ROLES = ["OWNER", "SUPPORT", "SALES", "FINANCE"] as const;
export type OperatorRole = (typeof OPERATOR_ROLES)[number];

export const isOperatorRole = (value: string): value is OperatorRole =>
  (OPERATOR_ROLES as readonly string[]).includes(value);

export type OperatorRefusal =
  | "NOT_FOUND"
  | "NOT_OPERATOR_OWNER"
  | "INVALID_PHONE"
  | "DUPLICATE_PHONE"
  | "TOTP_INVALID"
  | "TOTP_ALREADY_ENROLLED"
  | "SELF_ROLE_CHANGE"
  | "LAST_ADMIN";

export type OperatorResult<T> = { ok: true; value: T } | { ok: false; code: OperatorRefusal; params: RefusalParams };

export interface OperatorRow {
  userId: string;
  fullName: string;
  phoneE164: string;
  platformRole: string;
  status: string;
  /** Whether a second factor is confirmed. Never the secret — the function cannot return one. */
  totpEnrolled: boolean;
  createdAt: Date;
}

interface DirectoryRow {
  user_id: string;
  full_name: string;
  phone_e164: string;
  platform_role: string;
  status: string;
  totp_enrolled: boolean;
  created_at: Date;
}

/** Everyone who holds the flag, from a function whose return type carries no credential. */
export async function listOperators(actor: ActorContext): Promise<OperatorRow[]> {
  const rows = await withPlatformActor(actor, (tx) =>
    tx.$queryRaw<DirectoryRow[]>`SELECT * FROM platform_operator_directory()`,
  );
  return rows.map((row) => ({
    userId: row.user_id,
    fullName: row.full_name,
    phoneE164: row.phone_e164,
    platformRole: row.platform_role,
    status: row.status,
    totpEnrolled: row.totp_enrolled,
    createdAt: row.created_at,
  }));
}

async function roleOf(userId: string): Promise<string | null> {
  const row = await prisma.user.findFirst({
    where: { id: userId, isPlatformAdmin: true, status: "ACTIVE" },
    select: { platformRole: true },
  });
  return row?.platformRole ?? null;
}

/**
 * Seats a new operator — **OWNER only**.
 *
 * The check reads the database rather than the caller's token: a role revoked a minute ago must
 * refuse now, which is the same reasoning `PlatformAuthGuard` re-reads the flag on every request.
 *
 * The account arrives with a temporary password and no authenticator, so their first sign-in is
 * forced through both: `mustChangePassword` blocks the password, and an unconfirmed second factor
 * blocks everything else.
 */
export async function createOperator(
  actor: ActorContext,
  input: { fullName: string; phone: string; platformRole: OperatorRole },
): Promise<OperatorResult<{ userId: string; temporaryPassword: string }>> {
  if ((await roleOf(actor.userId)) !== "OWNER") {
    return { ok: false, code: "NOT_OPERATOR_OWNER", params: {} };
  }

  const phoneE164 = normalisePhone(input.phone, loginCountry());
  if (phoneE164 === null) return { ok: false, code: "INVALID_PHONE", params: {} };

  const taken = await prisma.user.findFirst({ where: { phoneE164 }, select: { id: true } });
  if (taken !== null) return { ok: false, code: "DUPLICATE_PHONE", params: {} };

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const userId = uuidv7();

  await withPlatformActor(actor, (tx) =>
    tx.user.create({
      data: {
        id: userId,
        fullName: input.fullName,
        phoneE164,
        passwordHash,
        mustChangePassword: true,
        status: "ACTIVE",
        isPlatformAdmin: true,
        platformRole: input.platformRole,
      },
    }),
  );

  return { ok: true, value: { userId, temporaryPassword } };
}

/** Changes an operator's seat — OWNER only, and never their own. */
export async function setOperatorRole(
  actor: ActorContext,
  userId: string,
  platformRole: OperatorRole,
): Promise<OperatorResult<{ platformRole: string }>> {
  if ((await roleOf(actor.userId)) !== "OWNER") {
    return { ok: false, code: "NOT_OPERATOR_OWNER", params: {} };
  }
  // The same rule the clinic's users screen keeps: ask a colleague. An owner who demotes himself by
  // accident has nobody left who can undo it.
  if (userId === actor.userId) return { ok: false, code: "SELF_ROLE_CHANGE", params: {} };

  const target = await prisma.user.findFirst({
    where: { id: userId, isPlatformAdmin: true },
    select: { id: true, platformRole: true },
  });
  if (target === null) return { ok: false, code: "NOT_FOUND", params: {} };

  // Never zero owners: the seat that creates operators cannot be vacated by editing the last one.
  if (target.platformRole === "OWNER" && platformRole !== "OWNER") {
    const owners = await prisma.user.count({
      where: { isPlatformAdmin: true, status: "ACTIVE", platformRole: "OWNER" },
    });
    if (owners <= 1) return { ok: false, code: "LAST_ADMIN", params: {} };
  }

  await withPlatformActor(actor, (tx) => tx.user.update({ where: { id: userId }, data: { platformRole } }));
  return { ok: true, value: { platformRole } };
}

/**
 * Starts enrolment: a fresh secret, stored unconfirmed, with the URI an authenticator imports.
 *
 * Refuses an account that already has a confirmed one. Re-enrolling silently would lock out the
 * authenticator the operator is holding, and "my codes stopped working" is indistinguishable from
 * an account takeover — so replacing a factor is a deliberate reset, not a side effect of visiting
 * this route twice.
 */
export async function beginTotpEnrolment(
  actor: ActorContext,
  userId: string,
  issuer = "clinic-os",
): Promise<OperatorResult<{ secretBase32: string; otpauthUri: string }>> {
  const user = await prisma.user.findFirst({
    where: { id: userId, isPlatformAdmin: true, status: "ACTIVE" },
    select: { phoneE164: true, totpConfirmedAt: true },
  });
  if (user === null) return { ok: false, code: "NOT_FOUND", params: {} };
  if (user.totpConfirmedAt !== null) return { ok: false, code: "TOTP_ALREADY_ENROLLED", params: {} };

  const secretBase32 = generateTotpSecret();
  await withPlatformActor(actor, (tx) =>
    tx.user.update({ where: { id: userId }, data: { totpSecret: secretBase32, totpConfirmedAt: null } }),
  );

  return {
    ok: true,
    value: { secretBase32, otpauthUri: otpauthUri({ secretBase32, account: user.phoneE164, issuer }) },
  };
}

/**
 * Confirms enrolment by proving the operator can read a live code.
 *
 * `at` is a parameter — `CLAUDE.md`'s rule about anything whose output is called reproducible — so
 * the spec pins a code against a fixed instant rather than racing a thirty-second window.
 */
export async function confirmTotpEnrolment(
  actor: ActorContext,
  userId: string,
  code: string,
  at: Date,
): Promise<OperatorResult<{ confirmedAt: Date }>> {
  const user = await prisma.user.findFirst({
    where: { id: userId, isPlatformAdmin: true, status: "ACTIVE" },
    select: { totpSecret: true, totpConfirmedAt: true },
  });
  if (user === null || user.totpSecret === null) return { ok: false, code: "NOT_FOUND", params: {} };
  if (user.totpConfirmedAt !== null) return { ok: false, code: "TOTP_ALREADY_ENROLLED", params: {} };

  if (!verifyTotp(user.totpSecret, code, Math.floor(at.getTime() / 1000))) {
    return { ok: false, code: "TOTP_INVALID", params: {} };
  }

  await withPlatformActor(actor, (tx) =>
    tx.user.update({ where: { id: userId }, data: { totpConfirmedAt: at } }),
  );
  return { ok: true, value: { confirmedAt: at } };
}

/** Answers the challenge at sign-in. Nothing is written: this proves possession, it does not change it. */
export async function verifySecondFactor(userId: string, code: string, at: Date): Promise<boolean> {
  const user = await prisma.user.findFirst({
    where: { id: userId, isPlatformAdmin: true, status: "ACTIVE" },
    select: { totpSecret: true, totpConfirmedAt: true },
  });
  if (user === null || user.totpSecret === null || user.totpConfirmedAt === null) return false;
  return verifyTotp(user.totpSecret, code, Math.floor(at.getTime() / 1000));
}

/**
 * Clears an operator's authenticator so they can enrol a new one — OWNER only.
 *
 * The lost-phone path, and the reason `beginTotpEnrolment` refuses to overwrite a confirmed factor:
 * replacing one is an act somebody takes and the audit trail records, not something a route does
 * quietly on a second visit.
 */
export async function resetOperatorTotp(
  actor: ActorContext,
  userId: string,
): Promise<OperatorResult<{ fullName: string }>> {
  if ((await roleOf(actor.userId)) !== "OWNER") {
    return { ok: false, code: "NOT_OPERATOR_OWNER", params: {} };
  }
  const user = await prisma.user.findFirst({
    where: { id: userId, isPlatformAdmin: true },
    select: { fullName: true },
  });
  if (user === null) return { ok: false, code: "NOT_FOUND", params: {} };

  await withPlatformActor(actor, async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { totpSecret: null, totpConfirmedAt: null } });
    // The codes go with the authenticator. Leaving them would mean a reset that revokes the factor
    // an operator has and keeps the eight credentials that bypass it.
    await tx.operatorRecoveryCode.deleteMany({ where: { userId } });
  });
  return { ok: true, value: { fullName: user.fullName } };
}

/** How many unused codes an operator has left. The count of rows, because consuming one deletes it. */
export async function countRecoveryCodes(userId: string): Promise<number> {
  return prisma.operatorRecoveryCode.count({ where: { userId } });
}

/**
 * Replaces an operator's recovery codes and returns the plaintext once.
 *
 * Atomic: the old set is deleted and the new one written in one transaction, so there is no instant
 * at which an operator holds both, and none at which they hold neither.
 */
async function issueRecoveryCodes(actor: ActorContext, userId: string): Promise<string[]> {
  const codes = generateRecoveryCodes();
  const hashed = await Promise.all(codes.map((code) => hashPassword(code)));

  await withPlatformActor(actor, async (tx) => {
    await tx.operatorRecoveryCode.deleteMany({ where: { userId } });
    await tx.operatorRecoveryCode.createMany({
      data: hashed.map((codeHash) => ({ id: uuidv7(), userId, codeHash })),
    });
  });

  return codes;
}

/** Issues the first set, at enrolment. Separate from regeneration, which demands both factors. */
export async function issueRecoveryCodesAtEnrolment(actor: ActorContext, userId: string): Promise<string[]> {
  return issueRecoveryCodes(actor, userId);
}

/**
 * Regenerates an operator's codes — current password **and** a live authenticator code.
 *
 * Both, because either alone is a credential the operator might have lost control of: a stolen
 * session should not be able to mint eight new bypasses, and neither should someone holding the
 * phone alone.
 */
export async function regenerateRecoveryCodes(
  actor: ActorContext,
  input: { password: string; totpCode: string },
  at: Date,
): Promise<OperatorResult<{ codes: string[] }>> {
  const user = await prisma.user.findFirst({
    where: { id: actor.userId, isPlatformAdmin: true, status: "ACTIVE" },
    select: { passwordHash: true },
  });
  if (user === null) return { ok: false, code: "NOT_FOUND", params: {} };

  if (!(await verifyPasswordHash(user.passwordHash, input.password))) {
    return { ok: false, code: "TOTP_INVALID", params: {} };
  }
  if (!(await verifySecondFactor(actor.userId, input.totpCode, at))) {
    return { ok: false, code: "TOTP_INVALID", params: {} };
  }

  return { ok: true, value: { codes: await issueRecoveryCodes(actor, actor.userId) } };
}

/**
 * Starts replacing a lost authenticator: proves the password, mints a candidate secret.
 *
 * The candidate is held in `totpPendingSecret`, never in `totpSecret`. A replacement abandoned
 * half-way — the browser closed, the new phone dropped — must leave the operator exactly as they
 * were, still able to sign in with the codes they have left.
 */
export async function beginTotpReplacement(
  actor: ActorContext,
  password: string,
): Promise<OperatorResult<{ secretBase32: string; otpauthUri: string }>> {
  const user = await prisma.user.findFirst({
    where: { id: actor.userId, isPlatformAdmin: true, status: "ACTIVE" },
    select: { passwordHash: true, phoneE164: true },
  });
  if (user === null) return { ok: false, code: "NOT_FOUND", params: {} };
  if (!(await verifyPasswordHash(user.passwordHash, password))) {
    return { ok: false, code: "TOTP_INVALID", params: {} };
  }

  const secretBase32 = generateTotpSecret();
  await withPlatformActor(actor, (tx) =>
    tx.user.update({ where: { id: actor.userId }, data: { totpPendingSecret: secretBase32 } }),
  );

  return {
    ok: true,
    value: {
      secretBase32,
      // The same issuer the first enrolment uses, so the replacement lands beside it in the app.
      otpauthUri: otpauthUri({ secretBase32, account: user.phoneE164, issuer: "clinic-os" }),
    },
  };
}

/**
 * Finishes the replacement: the new authenticator answers, and everything old dies at once.
 *
 * One transaction, because the halves are only safe together. The old secret is replaced AND every
 * recovery code is reissued — the device that held the authenticator very likely held the code file
 * beside it, so leaving the old codes alive would leave the lost device holding working credentials.
 */
export async function confirmTotpReplacement(
  actor: ActorContext,
  code: string,
  at: Date,
): Promise<OperatorResult<{ codes: string[] }>> {
  const user = await prisma.user.findFirst({
    where: { id: actor.userId, isPlatformAdmin: true, status: "ACTIVE" },
    select: { totpPendingSecret: true },
  });
  if (user === null || user.totpPendingSecret === null) return { ok: false, code: "NOT_FOUND", params: {} };
  if (!verifyTotp(user.totpPendingSecret, code, Math.floor(at.getTime() / 1000))) {
    return { ok: false, code: "TOTP_INVALID", params: {} };
  }

  const codes = generateRecoveryCodes();
  const hashed = await Promise.all(codes.map((plain) => hashPassword(plain)));

  await withPlatformActor(actor, async (tx) => {
    await tx.user.update({
      where: { id: actor.userId },
      data: {
        totpSecret: user.totpPendingSecret,
        totpConfirmedAt: at,
        totpPendingSecret: null,
      },
    });
    await tx.operatorRecoveryCode.deleteMany({ where: { userId: actor.userId } });
    await tx.operatorRecoveryCode.createMany({
      data: hashed.map((codeHash) => ({ id: uuidv7(), userId: actor.userId, codeHash })),
    });
  });

  return { ok: true, value: { codes } };
}

/**
 * Spends one recovery code, or refuses.
 *
 * Every refusal is the same value and costs the same work. A wrong code, a code already spent and a
 * malformed one are indistinguishable to the caller — and each still pays one full Argon2 verify
 * against every stored hash, so the shape of the code cannot be read off the response time.
 */
export async function consumeRecoveryCode(userId: string, submitted: string): Promise<boolean> {
  const normalised = normaliseRecoveryCode(submitted);
  const stored = await prisma.operatorRecoveryCode.findMany({
    where: { userId },
    select: { id: true, codeHash: true },
  });

  let matched: string | null = null;
  for (const row of stored) {
    // No early exit: a match found first must not be cheaper than a match found last, and a
    // malformed code must cost what a well-formed one costs.
    const candidate = isWellFormedRecoveryCode(normalised) ? normalised : normalised.padEnd(10, "-");
    if (await verifyPasswordHash(row.codeHash, candidate)) matched = row.id;
  }
  if (matched === null || !isWellFormedRecoveryCode(normalised)) return false;

  // Single-use: the row is the code, so spending it is a delete. `deleteMany` with the id rather
  // than `delete` so a race that already removed it is a refusal, not an exception.
  const removed = await prisma.operatorRecoveryCode.deleteMany({ where: { id: matched, userId } });
  return removed.count === 1;
}
