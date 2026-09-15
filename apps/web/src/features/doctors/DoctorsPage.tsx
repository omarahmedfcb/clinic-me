import { useCallback, useEffect, useMemo, useState } from "react";
import { Avatar } from "../../design-system/Avatar.tsx";
import { Button } from "../../design-system/Button.tsx";
import { Card, DataTable, EmptyState, type Column } from "../../design-system/display.tsx";
import { Spinner } from "../../design-system/Spinner.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import { useSession } from "../auth/session.tsx";
import { useUserPhoto } from "../staff/use-user-photo.ts";
import { loadDoctors, setDoctorActive, type Doctor } from "./doctors-api.ts";
import { AddDoctorDialog } from "./AddDoctorDialog.tsx";
import { DeactivateDoctorDialog } from "./DeactivateDoctorDialog.tsx";
import { DoctorDetailDrawer } from "./DoctorDetailDrawer.tsx";

/**
 * The clinic's doctors — list and deactivate. Ruled 2026-09-05.
 *
 * The founder's reason for building it now: *"Doctors are the thing the whole scheduling engine is
 * keyed on, and an admin screen that manages services but silently excludes doctors is a gap
 * someone will hit on day one of a pilot."*
 *
 * ## Add and open, built 2026-09-06
 *
 * Create was absent because `POST /doctors` takes a `membershipId` and nothing listed memberships,
 * so the form could only have offered a raw UUID. `GET /memberships` shipped the next day and the
 * founder ruled the form onto it. Opening a doctor came with it, for a reason that was visible on
 * the screen: room number and licence expiry were rendered as columns and **no screen could write
 * to either**, so the room column was permanently "—". A column nobody can fill reads as data the
 * clinic failed to enter rather than as a control that was never built.
 *
 * `shell.nav.users` stays badged "coming soon", and that is now a narrower gap than it was: this
 * screen can link a person who already has a login, and nothing in the API can create one.
 *
 * ## Deactivate, never delete
 *
 * A doctor row is referenced by appointments, visits and prescriptions. `ON DELETE RESTRICT` would
 * refuse a delete, and CLAUDE.md forbids hard-deleting medical records regardless. `isActive: false`
 * takes the doctor out of the slot engine's inputs and leaves every historical record pointing at a
 * row that still exists.
 *
 * ## The warning is a warning, not a gate
 *
 * Stated in full on `DeactivateDoctorDialog`, which is the component that has to honour it.
 *
 * ## No schedules on this screen
 *
 * Ruled explicitly: schedules already have their own editor at `/schedules`, and a second place to
 * edit them would be a second source of truth for the thing the slot engine reads.
 */
/**
 * One doctor's avatar. The hint comes from `GET /doctors`, so a doctor with no photo costs no
 * request — it used to fire one per row that could only 404, which made the network tab unreadable
 * while the founder was trying to work out whose photo was whose.
 */
function DoctorAvatar({ doctor }: { doctor: Doctor }) {
  return <Avatar name={doctor.fullName} src={useUserPhoto(doctor.membershipId, doctor.hasPhoto)} size="sm" />;
}

export function DoctorsPage({ openDoctorId }: { openDoctorId?: string } = {}) {
  const { t } = useLocale();
  const { me, authFetch } = useSession();

  const [doctors, setDoctors] = useState<Doctor[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [toggling, setToggling] = useState<Doctor | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /**
   * Which doctor the drawer is showing, held as an id rather than the row.
   *
   * The row is then looked up from `doctors` on every render, so a save that refetches the list
   * puts the new values into the open drawer instead of leaving it showing what was there when it
   * opened — which is the bug you get for free by storing the object.
   */
  // Opens on the doctor the users list linked to, when it linked to one.
  const [openId, setOpenId] = useState<string | null>(openDoctorId ?? null);

  /**
   * Whether to render the deactivate control at all.
   *
   * The list is readable under `appointments.write` — reception picks a doctor when booking — but
   * the only *action* here needs `users.manage`. The sidebar already hides the link for anyone
   * without it, and a link is not a route: typing `/doctors` reaches this screen as a doctor, and
   * without this check they would see buttons that answer 403.
   *
   * **This hides a control; it authorises nothing.** `permissions.ts` says so at length and
   * `session.tsx` repeats it on the field itself. The server refuses the PATCH regardless, which is
   * asserted against a real reception token in `doctors-management.integration.spec.ts` — this is
   * about not offering an action that will fail.
   */
  const canManage = me.permissions["users.manage"] !== "none";

  const refresh = useCallback(async (): Promise<void> => {
    setFailed(false);
    try {
      setDoctors(await loadDoctors(authFetch));
    } catch {
      setFailed(true);
    }
  }, [authFetch]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function toggleActive(doctor: Doctor): Promise<void> {
    setActionError(null);
    const result = await setDoctorActive(authFetch, doctor.id, !doctor.isActive);
    if (result.ok) {
      await refresh();
      return;
    }
    // Surfaced rather than swallowed into the generic load-failure state: the API names what it
    // refused, and that message is the useful half.
    setActionError(result.message);
  }

  const columns = useMemo<Column<Doctor>[]>(
    () => [
      {
        key: "name",
        header: t("doctors.column.name"),
        render: (row) => (
          <div className="flex items-center gap-2">
            <DoctorAvatar doctor={row} />
            <div className="flex flex-col">
              <span className="font-medium">
                {row.title} {row.fullName}
              </span>
              <span className="text-xs text-ink-muted">{row.specialty}</span>
            </div>
          </div>
        ),
      },
      {
        key: "license",
        header: t("doctors.column.license"),
        render: (row) => (
          <div className="flex flex-col">
            {/* `numeric` so a licence number renders left-to-right inside a right-to-left table,
                the same treatment phone numbers and amounts get. */}
            <span className="numeric">{row.licenseNumber}</span>
            {/*
              Expiry is shown as a plain date and nothing more. Deriving "expired" or "expiring
              soon" here would be a claim about an instant computed in a render — and the rule this
              project follows is to derive that against a passed-in date, in one place, where it can
              be tested. Nothing acts on the date yet; showing it is the whole of this change.
            */}
            {row.licenseExpiry !== null && (
              <span className="numeric text-xs text-ink-subtle">
                {t("doctors.licenseExpiry")} {row.licenseExpiry}
              </span>
            )}
          </div>
        ),
      },
      {
        key: "room",
        header: t("doctors.column.room"),
        // Not `numeric`: rooms are called "2أ" and "الأشعة", and forcing left-to-right would break
        // the Arabic ones.
        render: (row) =>
          row.roomNumber === null ? (
            <span className="text-xs text-ink-subtle">—</span>
          ) : (
            <span>{row.roomNumber}</span>
          ),
      },
      {
        key: "status",
        header: t("doctors.column.status"),
        render: (row) => (
          <div className="flex flex-col gap-0.5">
            <span
              className={
                row.isActive
                  ? "inline-flex w-fit rounded-full bg-success-soft px-2 py-0.5 text-xs text-success"
                  : "inline-flex w-fit rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-ink-muted"
              }
            >
              {row.isActive ? t("doctors.active") : t("doctors.inactive")}
            </span>
            {row.futureAppointmentCount > 0 && (
              <span className="numeric text-xs text-ink-muted">
                {t("doctors.upcoming").replace("{count}", String(row.futureAppointmentCount))}
              </span>
            )}
          </div>
        ),
      },
      {
        // Always present, unlike the deactivate control beside it. Opening a doctor is a read, and
        // the drawer renders read-only without `users.manage` -- so a receptionist who reaches this
        // screen can look up which room a doctor is in, which is the question the room column
        // exists to answer.
        key: "actions",
        header: t("doctors.column.actions"),
        align: "end" as const,
        render: (row: Doctor) => (
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpenId(row.id)}>
              {t("doctors.open")}
            </Button>
            {canManage && (
              <Button variant="secondary" onClick={() => setToggling(row)}>
                {row.isActive ? t("doctors.deactivate") : t("doctors.activate")}
              </Button>
            )}
          </div>
        ),
      },
    ],
    [t, canManage],
  );

  if (failed) {
    return (
      <EmptyState
        title={t("doctors.loadFailed")}
        message=""
        action={<Button onClick={() => void refresh()}>{t("doctors.retry")}</Button>}
      />
    );
  }

  if (doctors === null) return <Spinner />;

  return (
    <div className="mx-auto max-w-5xl">
      <Card
        title={t("doctors.title")}
        subtitle={t("doctors.subtitle")}
        padded={false}
        actions={
          canManage ? <Button onClick={() => setAdding(true)}>{t("doctors.add.action")}</Button> : undefined
        }
      >

        {actionError !== null && (
          <p role="alert" className="mx-4 mt-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {actionError}
          </p>
        )}
        <DataTable
          columns={columns}
          rows={doctors}
          rowKey={(row) => row.id}
          caption={t("doctors.title")}
          empty={<EmptyState title={t("doctors.empty.title")} message={t("doctors.empty.message")} />}
        />
        {/*
          Was a note saying the add button did not exist and why. The button exists now, so the note
          became the narrower true statement: this screen links people who already have a login, and
          nothing in the product creates one.
        */}
        {canManage && (
          <p className="border-t border-border px-4 py-3 text-xs text-ink-subtle">
            {t("doctors.add.noAccountNote")}
          </p>
        )}
      </Card>

      <AddDoctorDialog
        open={adding}
        onOpenChange={setAdding}
        onCreated={(doctor) => {
          // Refetch and open the new row. Create cannot set room number or licence expiry -- those
          // are on the PATCH route only -- so landing in the drawer is how the admin finishes the
          // job rather than being returned to a list with two blank columns.
          void refresh();
          setOpenId(doctor.id);
        }}
      />

      <DoctorDetailDrawer
        doctor={doctors?.find((row) => row.id === openId) ?? null}
        canManage={canManage}
        onClose={() => setOpenId(null)}
        onSaved={() => void refresh()}
      />

      <DeactivateDoctorDialog
        doctor={toggling}
        onOpenChange={(open) => {
          if (!open) setToggling(null);
        }}
        onConfirm={(doctor) => void toggleActive(doctor)}
      />
    </div>
  );
}
