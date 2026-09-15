// Profile photos — «المستخدمون» review, 2026-09-12. One photo per person, not per membership.
// The same StorageProvider seam and the same image guard as the logo; a third key shape of its own.

import { uuidv7 } from "uuidv7";
import { isSafePhotoKey, photoKeyFor } from "../attachments/domain/photo-key.ts";
import { sniff } from "../attachments/domain/sniff.ts";
import {
  ObjectNotFound,
  type StorageProvider,
} from "../attachments/storage/storage-provider.ts";
import { admitImage, type IdentityResult } from "../clinic-identity/clinic-identity.service.ts";
import { prisma } from "../../prisma/client.ts";
import { withTenant } from "../../prisma/with-tenant.ts";
import type { StaffCaller } from "./staff.service.ts";

/**
 * The user behind a membership **in the caller's own clinic**, or null.
 *
 * This is the whole access rule for photos, and it is deliberately a membership lookup rather than a
 * user lookup: `users` is not tenant-scoped, so reading one by id would let any clinic fetch any
 * person's photo. Going through `memberships` under the tenant extension means a caller can only
 * reach somebody who works where they work, and a colleague from another clinic is simply absent.
 */
async function userInThisClinic(
  caller: StaffCaller,
  membershipId: string,
): Promise<{ id: string; photoStorageKey: string | null } | null> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const membership = await tx.membership.findFirst({
      where: { id: membershipId },
      select: { user: { select: { id: true, photoStorageKey: true } } },
    });
    return membership?.user ?? null;
  });
}

/** Stores a photo and points the person's row at it. The previous object is left where it is (Q11). */
export async function putUserPhoto(
  caller: StaffCaller,
  storage: StorageProvider,
  membershipId: string,
  bytes: Buffer,
): Promise<IdentityResult<{ stored: true }>> {
  const user = await userInThisClinic(caller, membershipId);
  if (user === null) {
    return { ok: false, refusal: { code: "NOT_FOUND", params: { resource: "membership" } } };
  }

  const admitted = admitImage(bytes);
  if (!admitted.ok) return admitted;

  const key = photoKeyFor({
    tenantId: caller.tenantId,
    userId: user.id,
    imageId: uuidv7(),
    extension: admitted.value.extension,
  });

  await storage.put(key, bytes);
  // Through `withTenant`, which is what binds the actor the `users_audit` trigger requires. `users`
  // is not tenant-scoped, so the extension passes the write through untouched — the binding is the
  // whole point of going this way.
  await withTenant(caller.tenantId, caller.actor, (tx) =>
    tx.user.update({ where: { id: user.id }, data: { photoStorageKey: key } }),
  );
  return { ok: true, value: { stored: true } };
}

/**
 * Stops using a photo. **The stored object is left exactly where it is** — `StorageProvider` has no
 * `delete()` by design (Q11), and this does not reach around it.
 */
export async function clearUserPhoto(
  caller: StaffCaller,
  membershipId: string,
): Promise<IdentityResult<{ cleared: true }>> {
  const user = await userInThisClinic(caller, membershipId);
  if (user === null) {
    return { ok: false, refusal: { code: "NOT_FOUND", params: { resource: "membership" } } };
  }
  await withTenant(caller.tenantId, caller.actor, (tx) =>
    tx.user.update({ where: { id: user.id }, data: { photoStorageKey: null } }),
  );
  return { ok: true, value: { cleared: true } };
}

export interface UserPhoto {
  bytes: Buffer;
  mimeType: string;
}

/**
 * The bytes behind a person's photo key, or null when there are none.
 *
 * The key is re-validated on the way out even though this system wrote it: a database is a place
 * values arrive from a restore or a future writer, and what this prevents is reading an arbitrary
 * file off the host.
 */
export async function readUserPhoto(
  caller: StaffCaller,
  storage: StorageProvider,
  membershipId: string,
): Promise<UserPhoto | null> {
  const user = await userInThisClinic(caller, membershipId);
  if (user === null) return null;

  const key = user.photoStorageKey;
  if (key === null || !isSafePhotoKey(key)) return null;

  try {
    const bytes = await storage.get(key);
    const sniffed = sniff(bytes);
    return { bytes, mimeType: sniffed.ok ? sniffed.mimeType : "application/octet-stream" };
  } catch (error) {
    if (error instanceof ObjectNotFound) return null;
    throw error;
  }
}
