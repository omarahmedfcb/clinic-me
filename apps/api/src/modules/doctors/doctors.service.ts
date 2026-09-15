import { LIVE_STATUSES } from "../appointments/domain/transition.ts";
import { injected } from "../../prisma/injected.ts";
import type { RefusalCode, RefusalParams } from "../../common/refusals.ts";
import { withTenant, type ActorContext, type TransactionClient } from "../../prisma/with-tenant.ts";

/**
 * Doctors — the clinic's own roster, not global identity.
 *
 * A `Doctor` row hangs off a `Membership`, which is what makes the same person able to work at two
 * clinics (ARCHITECTURE.md §4) without either clinic seeing the other's row. `membershipId` is
 * `@unique`, so one membership is one doctor record.
 *
 * Plain functions, no `@Injectable()`, absence as a value — the same shape as
 * `patients.service.ts` and for the same reason: ARCHITECTURE.md §12's tool registry names
 * `get_doctor_information()`, and it calls this without a Nest container.
 */

export interface CallerContext {
  tenantId: string;
  actor: ActorContext;
}

export interface DoctorSummary {
  id: string;
  membershipId: string;
  fullName: string;
  title: string;
  specialty: string;
  licenseNumber: string;
  /**
   * `YYYY-MM-DD`, or null when nobody has recorded it. Derived state -- "expired", "expiring soon"
   * -- is deliberately **not** computed here: it is a claim about an instant, and the rule this
   * project follows is to derive it at read time against a passed-in date rather than store or
   * precompute a flag. Nothing acts on it yet; the screen shows the date.
   */
  licenseExpiry: string | null;
  roomNumber: string | null;
  /**
   * What a printed sheet says about this doctor — Q28's fields, on the doctor's own record since
   * Q38 folded the separate profile screen into this one. `hasSignature` and `hasStamp` are
   * existence, never the bytes: the images are streamed from their own capability-gated routes.
   */
  printedName: string | null;
  syndicateNumber: string | null;
  /** R1 and R2: whether this doctor may move a visit total, and whether they take payment. */
  mayAdjustPrices: boolean;
  /** How far they may move a total. Null means unlimited; the lower of the two binds. */
  priceAdjustmentCapPercent: number | null;
  priceAdjustmentCapMinor: number | null;
  collectsPayments: boolean;
  hasSignature: boolean;
  hasStamp: boolean;
  /** Whether a profile photo is stored. On the person, so it is read through their membership. */
  hasPhoto: boolean;
  isActive: boolean;
  /**
   * Appointments still to happen that are booked with this doctor — the number the deactivate
   * warning shows. Zero is a real answer and not a missing one.
   *
   * Mirrors `services.futureAppointmentCount` deliberately. Deactivating a doctor is the more
   * consequential of the two: a service nobody can book still gets performed, but a doctor removed
   * from the board has appointments that somebody has to move. A deactivate button beside a sibling
   * screen that warns, on a screen that does not, is the "check in one place and not its sibling"
   * shape this project keeps finding.
   */
  futureAppointmentCount: number;
}

export interface CreateDoctorInput {
  membershipId: string;
  specialty: string;
  licenseNumber: string;
  title: string;
}

export interface UpdateDoctorInput {
  specialty?: string;
  licenseNumber?: string;
  title?: string;
  isActive?: boolean;
  /**
   * `YYYY-MM-DD`, or `null` to clear it. `null` is meaningful and is not the same as omitting the
   * field: omitting leaves the stored value alone, and `null` says "this was recorded and should
   * not have been". A PATCH that could only ever set is one an admin cannot use to fix a mistake.
   */
  licenseExpiry?: string | null;
  roomNumber?: string | null;
  /** Q28's print fields. Same null-clears-it reading as the two above. */
  printedName?: string | null;
  syndicateNumber?: string | null;
  /** R1 and R2, set by an admin on the doctor form. Booleans, so there is nothing to clear. */
  mayAdjustPrices?: boolean;
  /** `null` clears the cap, which means unlimited. Omitting leaves it alone. */
  priceAdjustmentCapPercent?: number | null;
  priceAdjustmentCapMinor?: number | null;
  collectsPayments?: boolean;
}

export type CreateDoctorResult =
  | { ok: true; doctor: DoctorSummary }
  | { ok: false; code: RefusalCode; params: RefusalParams };

/**
 * `include` rather than a join on `users` directly: `users` is not tenant-scoped, and reaching it
 * through `membership` keeps the traversal inside rows RLS has already constrained.
 */
const WITH_NAME = {
  membership: { select: { user: { select: { fullName: true, photoStorageKey: true } } } },
};

interface DoctorRow {
  id: string;
  membershipId: string;
  title: string;
  specialty: string;
  licenseNumber: string;
  licenseExpiry: Date | null;
  roomNumber: string | null;
  printedName: string | null;
  syndicateNumber: string | null;
  mayAdjustPrices: boolean;
  priceAdjustmentCapPercent: number | null;
  priceAdjustmentCapMinor: number | null;
  collectsPayments: boolean;
  signatureStorageKey: string | null;
  stampStorageKey: string | null;
  isActive: boolean;
  membership: { user: { fullName: string; photoStorageKey: string | null } };
}

const toSummary = (row: DoctorRow, futureAppointmentCount: number): DoctorSummary => ({
  id: row.id,
  membershipId: row.membershipId,
  fullName: row.membership.user.fullName,
  title: row.title,
  specialty: row.specialty,
  licenseNumber: row.licenseNumber,
  // `DATE` arrives as a Date at UTC midnight; the calendar day is the whole of its content, and
  // sending an instant would invite a client to render it in its own timezone and shift it a day.
  licenseExpiry: row.licenseExpiry === null ? null : row.licenseExpiry.toISOString().slice(0, 10),
  roomNumber: row.roomNumber,
  printedName: row.printedName,
  syndicateNumber: row.syndicateNumber,
  mayAdjustPrices: row.mayAdjustPrices,
  priceAdjustmentCapPercent: row.priceAdjustmentCapPercent,
  priceAdjustmentCapMinor: row.priceAdjustmentCapMinor,
  collectsPayments: row.collectsPayments,
  hasSignature: row.signatureStorageKey !== null,
  hasStamp: row.stampStorageKey !== null,
  hasPhoto: row.membership.user.photoStorageKey !== null,
  isActive: row.isActive,
  futureAppointmentCount,
});

/**
 * Inactive doctors are included: a management screen has to be able to reactivate one.
 *
 * `now` is a parameter and is never read from the clock in here — "future appointments" is a claim
 * about an instant, and CLAUDE.md requires the reference point to be explicit so the boundary can
 * be tested without waiting for it. Same signature as `listServices` for the same reason.
 */
export async function listDoctors(caller: CallerContext, now: Date): Promise<DoctorSummary[]> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const rows = await tx.doctor.findMany({ include: WITH_NAME, orderBy: { createdAt: "asc" } });
    const counts = await countFutureAppointments(tx, now);
    return rows.map((row) => toSummary(row, counts.get(row.id) ?? 0));
  });
}

/**
 * One `groupBy` for the whole list rather than a count per row, which would be N+1 queries to
 * render a screen that holds a handful of doctors.
 *
 * `LIVE_STATUSES` comes from the appointment state machine rather than being spelled out here: a
 * cancelled appointment is not an upcoming visit, and counting it would make the warning ask an
 * admin to hesitate over something that is not going to happen.
 */
async function countFutureAppointments(
  tx: TransactionClient,
  now: Date,
  doctorId?: string,
): Promise<Map<string, number>> {
  const grouped = await tx.appointment.groupBy({
    by: ["doctorId"],
    where: {
      scheduledStart: { gt: now },
      // Spread into a mutable array: Prisma's generated `in` will not take a readonly one, and
      // LIVE_STATUSES is readonly precisely so no caller can edit the state machine's answer.
      status: { in: [...LIVE_STATUSES] },
      ...(doctorId === undefined ? {} : { doctorId }),
    },
    _count: { _all: true },
  });
  return new Map(grouped.map((row) => [row.doctorId, row._count._all]));
}

export async function getDoctor(
  caller: CallerContext,
  doctorId: string,
  now: Date,
): Promise<DoctorSummary | null> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const row = await tx.doctor.findFirst({ where: { id: doctorId }, include: WITH_NAME });
    if (row === null) return null;
    const counts = await countFutureAppointments(tx, now, doctorId);
    return toSummary(row, counts.get(row.id) ?? 0);
  });
}

export async function createDoctor(
  caller: CallerContext,
  input: CreateDoctorInput,
): Promise<CreateDoctorResult> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    // The membership must exist *in this tenant*. RLS makes another clinic's membership invisible
    // here, so a cross-tenant id is indistinguishable from one that never existed — which is what
    // lets the controller answer 404 without an ownership check.
    const membership = await tx.membership.findFirst({ where: { id: input.membershipId } });
    if (membership === null) {
      // NOT_FOUND with a resource, not a code of its own: "no such membership" asks the caller
      // for the same next action as "no such doctor" -- look again at what you chose.
      return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        params: { resource: "membership" } as const,
      };
    }

    const existing = await tx.doctor.findFirst({ where: { membershipId: input.membershipId } });
    if (existing !== null) {
      // Its own code, because it asks for something different: pick somebody else.
      return { ok: false as const, code: "ALREADY_A_DOCTOR" as const, params: {} };
    }

    const created = await tx.doctor.create({
      data: injected({
        membershipId: input.membershipId,
        specialty: input.specialty,
        licenseNumber: input.licenseNumber,
        title: input.title,
      }),
    });

    // Read back rather than using `include` on the create. `injected<T>()` erases the literal
    // create-input type that Prisma's conditional return type needs in order to narrow an
    // `include`, so the created row types as the bare model and `membership` is missing. Fighting
    // that with a cast would reintroduce exactly the unchecked-write hole `injected()` exists to
    // close (see its doc comment on `as never`). One extra read inside the same transaction is a
    // better trade than an assertion.
    const withName = await tx.doctor.findFirst({ where: { id: created.id }, include: WITH_NAME });
    if (withName === null) {
      throw new Error("Doctor vanished between insert and read inside one transaction.");
    }
    // A doctor created a moment ago has no appointments, so 0 here is a fact rather than an
    // unqueried default -- nothing can reference the row until it exists.
    return { ok: true as const, doctor: toSummary(withName, 0) };
  });
}

/**
 * Deactivation is an update, never a delete.
 *
 * A doctor row is referenced by appointments, visits and prescriptions, and CLAUDE.md forbids
 * hard-deleting medical records — `ON DELETE RESTRICT` would refuse it anyway. `isActive: false`
 * removes them from availability (the engine's inputs are filtered on it) while every historical
 * record keeps pointing at a row that still exists.
 */
export async function updateDoctor(
  caller: CallerContext,
  doctorId: string,
  input: UpdateDoctorInput,
  now: Date,
): Promise<DoctorSummary | null> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const existing = await tx.doctor.findFirst({ where: { id: doctorId } });
    if (existing === null) return null;

    // Spread field by field rather than handing `input` to Prisma whole. `licenseExpiry` arrives as
    // `YYYY-MM-DD` and the column is `@db.Date`, so it needs converting -- and `undefined` (leave
    // alone) has to stay distinct from `null` (clear it), which a blanket spread would preserve but
    // a naive `?? null` would destroy.
    const { licenseExpiry, ...rest } = input;
    const updated = await tx.doctor.update({
      where: { id: doctorId },
      data: {
        ...rest,
        ...(licenseExpiry === undefined
          ? {}
          : { licenseExpiry: licenseExpiry === null ? null : new Date(licenseExpiry) }),
      },
      include: WITH_NAME,
    });
    // Counted after the write, so the screen that just deactivated a doctor is told how many
    // appointments are still standing rather than how many there were a moment ago.
    const counts = await countFutureAppointments(tx, now, doctorId);
    return toSummary(updated, counts.get(updated.id) ?? 0);
  });
}
