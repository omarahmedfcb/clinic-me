import { uuidv7 } from "uuidv7";
import type { AttachmentCategory } from "../../generated/prisma/enums.ts";
import type { RefusalParams } from "../../common/refusals.ts";
import { injected } from "../../prisma/injected.ts";
import type { TransactionClient } from "../../prisma/with-tenant.ts";
import { withTenant, type ActorContext } from "../../prisma/with-tenant.ts";
import { doctorIdForMembership, isPresentWithDoctor } from "../clinical/clinical.access.ts";
import { hasActiveTransferGrant } from "../transfers/transfer-access.ts";
import { visitScope } from "../clinical/visit-scope.ts";
import { declaredTypeConflict } from "./domain/declared-type.ts";
import { sniff } from "./domain/sniff.ts";
import { storageKeyFor } from "./domain/storage-key.ts";
import { MAX_ATTACHMENT_BYTES } from "./storage/storage.config.ts";
import { ObjectNotFound, type StorageProvider } from "./storage/storage-provider.ts";

/**
 * Attachments — the service. `PHASE-4.md` Q10, Q11, checkpoint "Attachments".
 *
 * Refusals are values with machine-readable reasons rather than framework exceptions, the same
 * shape as `insurance.service.ts` and `transfers.service.ts`, so the AI tool layer can call these
 * functions without catching HTTP errors.
 *
 * ## Doctor-only, upload included — the founder's ruling of 2026-09-05
 *
 * Q10 and Q11 settled *what* may be attached and *where the bytes live*, but neither said who may
 * upload. Ruled: **the doctor, and nobody else.** `visits.write` guards the write routes and
 * `visits.readContent` guards the reads, both `DOCTOR`-only in the permission matrix — so no new
 * capability, and no permission-matrix change.
 *
 * **The known cost, recorded rather than left to be rediscovered:** a lab result handed in at the
 * desk cannot be filed by reception. It waits for the doctor. That was put to the founder with the
 * alternative — reception uploads, reads stay doctor-only — and he chose this one.
 *
 ## Which doctor, for which patient — and it gates writes as well as reads
 *
 * `PermissionGuard` proves the caller is a doctor. It cannot prove *this* doctor may touch *this*
 * patient's file — that needs the row in hand, which `permissions.ts` says belongs here.
 *
 * - **A doctor may read an attachment they uploaded, unconditionally.** Presence is the wrong
 *   question about a file you filed yourself.
 * - **Every other read, and every write, needs a care relationship** — see `hasCareRelationship`
 *   for the three doors and why the middle one is *authored a visit* rather than *has an
 *   appointment*.
 *
 * **The write side is not decoration, and it was very nearly missed.** `visits.write` is
 * `DOCTOR: FULL`, so the guard admits any doctor in the clinic; the first draft of this module
 * stopped there and would have let any of them file a document onto any patient's record.
 * `own-capability-enforcement.ts` caught it — its `NO_CONSUMER` entry for `visits.write` exists to
 * fail the suite the moment a route consumes that capability, precisely so the ownership check gets
 * written instead of assumed. That entry is removed in the same change that adds this check, which
 * is what it was there to force.
 *
 * **Flagged for the visit-detail checkpoint, deliberately not solved here.** `clinical.access.ts`
 * resolves access from an *appointment*; an attachment may have no visit and therefore no
 * appointment at all (`visit_id` is nullable — a scan filed against a patient between visits). So
 * this module asks the patient-level question directly rather than routing through `resolveAccess`,
 * and when `GET /visits/:id` lands the two need reconciling into one rule rather than two that
 * agree today only by inspection.
 */

export type AttachmentRefusalReason =
  | "NOT_FOUND"
  | "TOO_LARGE"
  | "UNSUPPORTED_TYPE"
  | "HEIC_NOT_CONVERTED"
  | "TYPE_MISMATCH"
  | "EMPTY_FILE"
  | "NOT_A_DOCTOR"
  | "NOT_PERMITTED"
  | "VISIT_MISMATCH";

export type AttachmentResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: AttachmentRefusalReason; params: RefusalParams };

export interface AttachmentCaller {
  tenantId: string;
  actor: ActorContext;
  /**
   * Which membership is acting. Added 2026-09-06 with the multiple-memberships change: a person may
   * hold two memberships in one clinic, so "is this caller a doctor" is a question about the
   * membership they are acting under, not about the human.
   */
  membershipId: string;
}

/**
 * What a list returns. **Metadata only — no bytes, and no clinical content.**
 *
 * `storageKey` is deliberately absent. It is an internal address, it is of no use to any client
 * that can only fetch through `GET /attachments/:id/content`, and a field named like a location is
 * an invitation to try to use it as one.
 */
export interface AttachmentView {
  id: string;
  patientId: string;
  visitId: string | null;
  fileName: string;
  /** What the bytes actually are, from sniffing — never what the uploader declared. */
  mimeType: string;
  sizeBytes: number;
  category: AttachmentCategory;
  description: string | null;
  uploadedByUserId: string;
  createdAt: Date;
  archivedAt: Date | null;
}

const VIEW_COLUMNS = {
  id: true,
  patientId: true,
  visitId: true,
  fileName: true,
  mimeType: true,
  sizeBytes: true,
  category: true,
  description: true,
  uploadedByUserId: true,
  createdAt: true,
  archivedAt: true,
} as const;

/**
 * Is this patient this doctor's business? The one question both directions ask.
 *
 * `now` is passed in, never read from the clock here — the transfer window is compared against it,
 * and a boundary that reads its own clock cannot be tested at the boundary (CLAUDE.md).
 *
 * ## Three doors, and why the middle one is not "has an appointment"
 *
 * 1. **The patient is with them now** — `ARRIVED`/`WAITING`/`IN_CONSULTATION`. The ordinary
 *    consultation case, unchanged from `clinical.access.ts`.
 * 2. **They have authored a visit for this patient.** This is the door that makes the feature work:
 *    a lab result arrives four days after the consultation, and under presence alone the doctor who
 *    ordered it could not file it — reception cannot either, by the 2026-09-05 ruling, so the
 *    result would have nowhere to go.
 * 3. **An accepted, unexpired transfer grant** (D24).
 *
 * Door 2 is *authored a visit*, deliberately **not** *has an appointment*. `clinical.access.ts`
 * states the objection to the weaker version and it is a real one: "'Has an appointment' is too weak
 * a gate because reception creates bookings; a doctor could otherwise read any record by having
 * someone book it." A visit is written by the doctor during the consultation, so it cannot be
 * manufactured from a booking screen — which is the property that made presence trustworthy in the
 * first place, obtained here without requiring the patient to still be in the room.
 *
 * It is the same move `PHASE-4.md` Q18 makes for `GET /visits/:id`: presence was always a proxy for
 * *"this patient is your business right now"*, and for a record you already authored the better
 * question is *"was this yours"*.
 */
async function hasCareRelationship(
  tx: TransactionClient,
  patientId: string,
  doctorId: string,
  now: Date,
  viewerUserId: string,
): Promise<boolean> {
  if (await isPresentWithDoctor(tx, patientId, doctorId)) return true;

  // Scoped: an unfinished draft by someone else is not a care relationship of this viewer's.
  const authored = await tx.visit.findFirst({
    where: { patientId, doctorId, ...visitScope({ actor: { userId: viewerUserId } }) },
    select: { id: true },
  });
  if (authored !== null) return true;

  return hasActiveTransferGrant(tx, { patientId, doctorId }, now);
}

/**
 * Files a new attachment.
 *
 * **Order matters and is not incidental.** The content is sniffed and the size checked *before*
 * anything is written — to the database or to disk — so a refused upload leaves nothing behind to
 * clean up. The database row and the stored object are then written inside one transaction, with
 * the object written first: if `put` fails the transaction rolls back and there is no row pointing
 * at bytes that are not there. The opposite order can leave a record of a file nobody can open.
 */
export async function uploadAttachment(
  caller: AttachmentCaller,
  storage: StorageProvider,
  input: {
    patientId: string;
    visitId: string | null;
    fileName: string;
    /** What the caller's browser said it was. Never decides admission -- only checked for a
     *  contradiction against the sniffed truth (`domain/declared-type.ts`). */
    declaredMimeType: string;
    category: AttachmentCategory;
    description: string | null;
    bytes: Buffer;
  },
  /** Passed in rather than read here, so the transfer window inside the access rule is testable. */
  now: Date,
): Promise<AttachmentResult<AttachmentView>> {
  // Server-side, and not only in the browser or in multer's limit. The service is the interface
  // (the AI tool layer calls it directly), so a cap enforced solely at the HTTP edge is a cap that
  // does not exist for half its callers.
  if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      code: "TOO_LARGE",
      params: { limit: MAX_ATTACHMENT_BYTES, actual: input.bytes.byteLength },
    };
  }

  const sniffed = sniff(input.bytes);
  if (!sniffed.ok) {
    switch (sniffed.reason) {
      case "EMPTY":
        return { ok: false, code: "EMPTY_FILE", params: {} };
      case "HEIC":
        return {
          ok: false,
          code: "HEIC_NOT_CONVERTED",
          params: {},
        };
      default:
        return {
          ok: false,
          code: "UNSUPPORTED_TYPE",
          params: {},
        };
    }
  }

  // Admission is already settled -- `sniff` decided and nothing below can change that. This asks a
  // different question: do the caller's own two claims agree with the answer? A file that says
  // `.jpg` in its name and holds a PDF is not a format problem, it is a disagreement, and a
  // disagreement is worth refusing even when both formats are individually welcome.
  const conflict = declaredTypeConflict(sniffed.mimeType, input.fileName, input.declaredMimeType);
  if (conflict !== null) {
    return {
      ok: false,
      code: "TYPE_MISMATCH",
      params: { claimed: conflict.claimed, detected: conflict.actual },
    };
  }

  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const doctorId = await doctorIdForMembership(tx, caller.membershipId);
    if (doctorId === null) {
      return {
        ok: false as const,
        code: "NOT_A_DOCTOR" as const,
        params: {},
      };
    }

    // The tenant extension has already scoped this, so a cross-tenant id is indistinguishable from
    // one that never existed -- 404, never 403 (CLAUDE.md).
    const patient = await tx.patient.findFirst({
      where: { id: input.patientId },
      select: { id: true },
    });
    if (patient === null) {
      return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        params: { resource: "patient" } as const,
      };
    }

    // **The check `own-capability-enforcement.ts` demanded of anything consuming `visits.write`.**
    // That registry's warning is exact: DOCTOR is FULL for this capability, so `PermissionGuard`
    // admits *any* doctor, and FULL reads as "no scoping needed" when it means "scoping owed
    // elsewhere". Without this branch any doctor in the clinic could file a document onto any
    // patient's record -- attributed to them correctly in `uploaded_by_user_id`, and looking
    // entirely legitimate. The registry entry for `visits.write` is removed in the same change that
    // adds this, which is what it was there to force.
    if (!(await hasCareRelationship(tx, input.patientId, doctorId, now, caller.actor.userId))) {
      return {
        ok: false as const,
        code: "NOT_PERMITTED" as const,
        params: {},
      };
    }

    if (input.visitId !== null) {
      const visit = await tx.visit.findFirst({
        where: { id: input.visitId, ...visitScope({ actor: { userId: caller.actor.userId } }) },
        select: { id: true, patientId: true },
      });
      if (visit === null) {
        return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        params: { resource: "visit" } as const,
      };
      }
      // A visit belonging to a different patient is a well-formed request that is wrong about the
      // world, not a malformed one: 422 at the controller, and never silently accepted -- filing a
      // scan against the wrong patient's visit is the error this check exists to prevent.
      if (visit.patientId !== input.patientId) {
        return {
          ok: false as const,
          code: "VISIT_MISMATCH" as const,
          params: {},
        };
      }
    }

    // Minted here rather than left to the extension, because the storage key is derived from it and
    // the object is written before the row exists.
    const attachmentId = uuidv7();
    const storageKey = storageKeyFor({
      tenantId: caller.tenantId,
      patientId: input.patientId,
      attachmentId,
      extension: sniffed.extension,
    });

    await storage.put(storageKey, input.bytes);

    const created = await tx.attachment.create({
      data: injected({
        id: attachmentId,
        patientId: input.patientId,
        visitId: input.visitId,
        uploadedByUserId: caller.actor.userId,
        fileName: input.fileName,
        storageKey,
        // What it is, not what was claimed.
        mimeType: sniffed.mimeType,
        sizeBytes: input.bytes.byteLength,
        category: input.category,
        description: input.description,
      }),
      select: VIEW_COLUMNS,
    });

    return { ok: true as const, value: created };
  });
}

/**
 * Every attachment on a patient's file, newest first, **including archived ones**.
 *
 * Archived rows are returned with `archivedAt` set rather than filtered out, because archiving is
 * not deletion and a doctor looking for a scan they archived by mistake needs to be able to find
 * it. A screen decides how to show them; an endpoint that hid them would make them unrecoverable
 * through the product.
 */
export async function listPatientAttachments(
  caller: AttachmentCaller,
  patientId: string,
  now: Date,
): Promise<AttachmentResult<AttachmentView[]>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const doctorId = await doctorIdForMembership(tx, caller.membershipId);
    if (doctorId === null) {
      return {
        ok: false as const,
        code: "NOT_A_DOCTOR" as const,
        params: {},
      };
    }

    const patient = await tx.patient.findFirst({
      where: { id: patientId },
      select: { id: true },
    });
    if (patient === null) {
      return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        params: { resource: "patient" } as const,
      };
    }

    const permitted = await hasCareRelationship(tx, patientId, doctorId, now, caller.actor.userId);

    const rows = await tx.attachment.findMany({
      where: permitted
        ? { patientId }
        : // Not permitted at patient level: they still see what they filed themselves, which is the
          // unconditional half of the rule above.
          { patientId, uploadedByUserId: caller.actor.userId },
      select: VIEW_COLUMNS,
      orderBy: { createdAt: "desc" },
    });

    return { ok: true as const, value: rows };
  });
}

/**
 * The bytes, plus what the response needs to describe them.
 *
 * Fetched through the API and never from a public path — Q11's security half. The object is read
 * from storage only after the row has been found and the access rule has passed, so a caller who
 * may not see the file never causes a read of it.
 */
export async function readAttachmentContent(
  caller: AttachmentCaller,
  storage: StorageProvider,
  attachmentId: string,
  now: Date,
): Promise<AttachmentResult<{ fileName: string; mimeType: string; bytes: Buffer }>> {
  const found = await withTenant(caller.tenantId, caller.actor, async (tx) => {
    const doctorId = await doctorIdForMembership(tx, caller.membershipId);
    if (doctorId === null) {
      return {
        ok: false as const,
        code: "NOT_A_DOCTOR" as const,
        params: {},
      };
    }

    const attachment = await tx.attachment.findFirst({
      where: { id: attachmentId },
      select: { fileName: true, mimeType: true, storageKey: true, patientId: true, uploadedByUserId: true },
    });
    if (attachment === null) {
      return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        params: { resource: "attachment" } as const,
      };
    }

    const mine = attachment.uploadedByUserId === caller.actor.userId;
    if (!mine && !(await hasCareRelationship(tx, attachment.patientId, doctorId, now, caller.actor.userId))) {
      // NOT_PERMITTED rather than NOT_FOUND: the caller is a doctor in the right tenant, so the
      // row's existence is not a secret from them -- only its content is. The tenant boundary is
      // the one that must stay indistinguishable, and the query above already enforced it.
      return {
        ok: false as const,
        code: "NOT_PERMITTED" as const,
        params: {},
      };
    }

    return { ok: true as const, value: attachment };
  });

  if (!found.ok) return found;

  try {
    const bytes = await storage.get(found.value.storageKey);
    return {
      ok: true,
      value: { fileName: found.value.fileName, mimeType: found.value.mimeType, bytes },
    };
  } catch (error) {
    if (error instanceof ObjectNotFound) {
      // A row whose object is gone. Not a 404 dressed up as one: this is a real inconsistency
      // between the database and the storage root -- a restore that covered `pg_dump` but not the
      // files, which is the exact gap DEPLOY.md now warns about.
      throw new Error(
        `Attachment ${attachmentId} has a database row but no stored object. The storage root and ` +
          "the database are out of step -- see docs/DEPLOY.md on backing up both.",
      );
    }
    throw error;
  }
}

/**
 * Archives an attachment. **Nothing is destroyed** — the row keeps every column it had and the
 * stored object is not touched (CLAUDE.md: medical records are never hard-deleted, and
 * `StorageProvider` has no `delete` for this reason).
 *
 * Idempotent: archiving an already-archived attachment leaves the original `archived_at` alone
 * rather than moving it, so the timestamp keeps meaning "when this was archived".
 */
export async function archiveAttachment(
  caller: AttachmentCaller,
  attachmentId: string,
  now: Date,
): Promise<AttachmentResult<AttachmentView>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const doctorId = await doctorIdForMembership(tx, caller.membershipId);
    if (doctorId === null) {
      return {
        ok: false as const,
        code: "NOT_A_DOCTOR" as const,
        params: {},
      };
    }

    const attachment = await tx.attachment.findFirst({
      where: { id: attachmentId },
      select: { id: true, patientId: true, uploadedByUserId: true, archivedAt: true },
    });
    if (attachment === null) {
      return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        params: { resource: "attachment" } as const,
      };
    }

    const mine = attachment.uploadedByUserId === caller.actor.userId;
    if (!mine && !(await hasCareRelationship(tx, attachment.patientId, doctorId, now, caller.actor.userId))) {
      return {
        ok: false as const,
        code: "NOT_PERMITTED" as const,
        params: {},
      };
    }

    if (attachment.archivedAt !== null) {
      const unchanged = await tx.attachment.findFirstOrThrow({
        where: { id: attachmentId },
        select: VIEW_COLUMNS,
      });
      return { ok: true as const, value: unchanged };
    }

    const archived = await tx.attachment.update({
      where: { id: attachmentId },
      data: { archivedAt: now },
      select: VIEW_COLUMNS,
    });

    return { ok: true as const, value: archived };
  });
}

/**
 * The attachments filed against one visit, newest first, **including archived ones**.
 *
 * Takes a transaction rather than a caller: it is called from inside `visits.service.ts`, which has
 * already established that this doctor may read this visit. Passing `tx` rather than opening a
 * second transaction is what keeps the visit and its attachments a single consistent read — and it
 * means the access decision is made once, by the caller, instead of twice by two rules that could
 * disagree.
 *
 * **It performs no access check of its own, and that is why it takes `tx`.** A function that
 * queried on its own would be one an unguarded caller could reach.
 */
export async function attachmentsForVisit(
  tx: TransactionClient,
  visitId: string,
): Promise<AttachmentView[]> {
  return tx.attachment.findMany({
    where: { visitId },
    select: VIEW_COLUMNS,
    orderBy: { createdAt: "desc" },
  });
}

/**
 * What **reception** may know about a patient's attachments — ruled by the founder 2026-09-05.
 *
 * His words: *"reception can see WHICH attachments exist. Not what they contain."* The operational
 * need is real and specific — *"the X-ray is already on file, don't ask him to bring it again"* —
 * and it is the same class of fact as a visit date or an appointment status, which reception
 * already sees.
 *
 * ## The line, and why `fileName` is on the wrong side of it
 *
 * Category, size and upload date describe the *existence* of a document. A filename describes its
 * *contents*: `أشعة_الركبة_اليمنى.pdf` — "right knee x-ray" — discloses the condition to anyone who
 * reads the list, which is the §8 boundary exactly. So the ruling is category, size, upload date
 * and count; **no filename, no preview, no content URL.**
 *
 * **There is no `id` either, and that is deliberate rather than an oversight.** An id is a handle,
 * and a handle invites a caller to try `GET /attachments/:id/content` with it. That route is
 * doctor-only at the guard and would refuse — but the safest version of a reception-facing list is
 * one that hands out nothing to try. Reception needs to know a knee x-ray exists, not which row it
 * is.
 *
 * ## A separate function, a separate DTO, a separate controller
 *
 * `CLAUDE.md` requires the clinical boundary to be enforced "by separate endpoints and separate
 * DTOs — never by filtering fields out of one response". `AttachmentView` is not narrowed here and
 * must never be: this returns its own type, built from its own `select`, so a field added to the
 * doctor's view cannot arrive in reception's by inheritance.
 *
 * **Archived rows are excluded**, which is a judgement about the question being asked rather than
 * about the data. Reception is asking "is this on file, or must the patient bring it again" — and
 * an archived attachment is one a doctor set aside. Counting it would answer "yes" to a question
 * whose true answer is "no". The doctor's own list still shows archived rows, marked; nothing is
 * hidden from the person who can act on it.
 */
export interface ReceptionAttachmentItem {
  category: AttachmentCategory;
  sizeBytes: number;
  createdAt: Date;
}

export interface ReceptionAttachmentSummary {
  /** Live attachments only — archived rows are not counted. See the note above. */
  total: number;
  /** Newest first. No identity, no filename, no type beyond the category. */
  items: ReceptionAttachmentItem[];
}

export async function summariseAttachmentsForReception(
  caller: AttachmentCaller,
  patientId: string,
): Promise<AttachmentResult<ReceptionAttachmentSummary>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    // The patient is resolved first so an unknown or other-tenant id is a 404 rather than an empty
    // summary. An empty summary is a different wrong answer: it says "this patient has nothing on
    // file", which is a statement about a patient the caller cannot see.
    const patient = await tx.patient.findFirst({ where: { id: patientId }, select: { id: true } });
    if (patient === null) {
      return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        params: { resource: "patient" } as const,
      };
    }

    const items = await tx.attachment.findMany({
      where: { patientId, archivedAt: null },
      // The whole of what reception receives, listed explicitly. Not `AttachmentView` minus fields.
      select: { category: true, sizeBytes: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });

    return { ok: true as const, value: { total: items.length, items } };
  });
}
