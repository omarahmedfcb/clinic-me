// The operator's account — pilot-readiness 0a. Created outside every tenant, because it belongs to
// none: `is_platform_admin` is a column on the global `users` row, not a role in a clinic.

import { uuidv7 } from "uuidv7";
import { prisma } from "../../src/prisma/client.ts";
import { hashPassword } from "../../src/modules/auth/password.ts";

export interface PlatformAdminInput {
  fullName: string;
  phoneE164: string;
  email: string | null;
  password: string;
}

/**
 * Creates, or leaves alone, one platform admin.
 *
 * **Not written through `withTenant`.** `users` is not tenant-scoped and this row deliberately has
 * no tenant to bind — the audit trigger on `users` fires on UPDATE only, so an insert here needs no
 * actor either. That is also why this cannot be folded into `seedStaff`, which is tenant-shaped
 * throughout.
 *
 * Idempotent on the phone number, so a re-run neither duplicates the operator nor resets a password
 * somebody is already using.
 */
export async function ensurePlatformAdmin(input: PlatformAdminInput): Promise<{ created: boolean; userId: string }> {
  const existing = await prisma.user.findFirst({
    where: { phoneE164: input.phoneE164 },
    select: { id: true },
  });
  if (existing !== null) return { created: false, userId: existing.id };

  const user = await prisma.user.create({
    data: {
      id: uuidv7(),
      fullName: input.fullName,
      phoneE164: input.phoneE164,
      email: input.email,
      passwordHash: await hashPassword(input.password),
      isPlatformAdmin: true,
      status: "ACTIVE",
    },
    select: { id: true },
  });
  return { created: true, userId: user.id };
}
