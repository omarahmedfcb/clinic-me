// «المستخدمون» — who has an account in this clinic. Phase 5 PR 10. Admin only.
// Suspend and reactivate, never delete: a staff row is the actor on every audit line they wrote.

import { useCallback, useEffect, useState } from "react";
import { Avatar } from "../../design-system/Avatar.tsx";
import { Button } from "../../design-system/Button.tsx";
import { Card, DataTable, EmptyState, type Column } from "../../design-system/display.tsx";
import { Select, TextInput } from "../../design-system/fields.tsx";
import { Modal } from "../../design-system/overlays.tsx";
import { intlLocale } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { useSession } from "../auth/session.tsx";
import { roleLabel } from "../memberships/role-label.ts";
import { ImageField } from "../settings/ImageField.tsx";
import {
  createStaff,
  loadStaff,
  loadUserPhoto,
  removeUserPhoto,
  resetStaffPassword,
  setStaffStatus,
  updateStaff,
  uploadUserPhoto,
  STAFF_ROLES,
  type StaffMember,
  type StaffRole,
} from "./staff-api.ts";
import { useUserPhoto } from "./use-user-photo.ts";

/**
 * Whether this row's role may be changed from the users list.
 *
 * An OWNER's may not: who owns a clinic is not a decision on a dialog that also edits a phone
 * number, and transferring ownership will need its own screen. The server refuses it either way.
 */
function roleEditable(member: StaffMember): boolean {
  return member.role === "ADMIN" || member.role === "RECEPTIONIST";
}

/** One row's avatar. A component of its own because the photo is a hook, and a cell is not. */
function StaffAvatar({ member }: { member: StaffMember }) {
  return <Avatar name={member.fullName} src={useUserPhoto(member.membershipId, member.hasPhoto)} size="sm" />;
}

/** A credential the admin reads aloud once. Never stored, never fetched again. */
interface ShownOnce {
  name: string;
  password: string;
}

export function StaffPage({ onOpenDoctor }: { onOpenDoctor: (doctorId: string | null) => void }) {
  const { t, locale } = useLocale();
  const { authFetch } = useSession();

  const [staff, setStaff] = useState<StaffMember[] | null>(null);
  const [creating, setCreating] = useState(false);
  /** The row being edited, or null. Holds the original values, so only changes are sent. */
  const [editing, setEditing] = useState<StaffMember | null>(null);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  // Widened past the two the create form offers, because the edit dialog has to be able to hold an
  // OWNER's actual role without coercing it into one of them.
  const [role, setRole] = useState<string>("RECEPTIONIST");
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<ShownOnce | null>(null);
  const [failure, setFailure] = useState<{ code: string; params: Record<string, unknown> } | null>(null);

  const refresh = useCallback(async () => {
    setStaff(await loadStaff(authFetch));
  }, [authFetch]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const say = (code: string, params: Record<string, unknown>): string =>
    Object.entries(params).reduce(
      (text, [key, value]) => text.replace(`{${key}}`, String(value)),
      t(`refusal.${code}` as TranslationKey),
    );

  async function onCreate(): Promise<void> {
    setBusy(true);
    setFailure(null);
    // The create form's select only ever holds one of the two, which is why this cast is safe here
    // and why the edit dialog — which must also hold OWNER — sends its role through `roleEditable`.
    const result = await createStaff(authFetch, {
      fullName: fullName.trim(),
      phone: phone.trim(),
      role: role as StaffRole,
    });
    setBusy(false);
    if (!result.ok) {
      setFailure({ code: result.code, params: result.params });
      return;
    }
    setCreating(false);
    setFullName("");
    setPhone("");
    // An existing person keeps the password they already use, so there is nothing to show.
    if (result.temporaryPassword !== "") {
      setShown({ name: result.member.fullName, password: result.temporaryPassword });
    }
    await refresh();
  }

  function openEdit(member: StaffMember): void {
    setFailure(null);
    setEditing(member);
    setFullName(member.fullName);
    setPhone(member.phoneE164);
    // **The row's actual role, whatever it is.** This line used to read `member.role === "ADMIN" ?
    // "ADMIN" : "RECEPTIONIST"`, which silently answered "RECEPTIONIST" for an OWNER row — and the
    // save then sent it, because it differed. That demoted the owner of the pilot clinic.
    setRole(member.role);
  }

  async function onSaveEdit(): Promise<void> {
    if (editing === null) return;
    setBusy(true);
    setFailure(null);
    // Only what changed. An unchanged phone is the caller's own and would be accepted anyway, but
    // sending it gives the server one more thing it could refuse over.
    const result = await updateStaff(authFetch, editing.membershipId, {
      ...(fullName.trim() === editing.fullName ? {} : { fullName: fullName.trim() }),
      ...(phone.trim() === editing.phoneE164 ? {} : { phone: phone.trim() }),
      // The role is sent only when this row's role is editable here at all. An OWNER's is not, so
      // editing their name or photo cannot carry a role change with it.
      ...(roleEditable(editing) && role !== editing.role ? { role: role as StaffRole } : {}),
    });
    setBusy(false);
    if (!result.ok) {
      setFailure({ code: result.code, params: result.params });
      return;
    }
    setEditing(null);
    setFullName("");
    setPhone("");
    await refresh();
  }

  async function onStatus(member: StaffMember): Promise<void> {
    setFailure(null);
    const next = member.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE";
    const result = await setStaffStatus(authFetch, member.membershipId, next);
    if (!result.ok) {
      setFailure({ code: result.code, params: result.params });
      return;
    }
    await refresh();
  }

  async function onReset(member: StaffMember): Promise<void> {
    setFailure(null);
    const result = await resetStaffPassword(authFetch, member.membershipId);
    if (!result.ok) {
      setFailure({ code: result.code, params: result.params });
      return;
    }
    setShown({ name: member.fullName, password: result.temporaryPassword });
    await refresh();
  }

  const columns: Column<StaffMember>[] = [
    {
      key: "name",
      header: t("staff.column.name"),
      render: (row) => (
        <div className="flex items-center gap-2">
          <StaffAvatar member={row} />
          <div className="flex flex-col">
            <span className="font-medium">{row.fullName}</span>
            {row.mustChangePassword && (
              <span className="text-xs text-warning" data-testid={`pending-${row.membershipId}`}>
                {t("staff.pendingPassword")}
              </span>
            )}
          </div>
        </div>
      ),
    },
    {
      key: "phone",
      header: t("staff.column.phone"),
      render: (row) => (
        <span dir="ltr" className="numeric">
          {row.phoneE164}
        </span>
      ),
    },
    {
      key: "role",
      header: t("staff.column.role"),
      render: (row) => roleLabel(row.role, t),
    },
    {
      key: "status",
      header: t("staff.column.status"),
      render: (row) => (
        <span
          className={
            row.status === "ACTIVE"
              ? "inline-flex w-fit rounded-full bg-success-soft px-2 py-0.5 text-xs text-success"
              : "inline-flex w-fit rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-ink-muted"
          }
        >
          {t(row.status === "ACTIVE" ? "staff.active" : "staff.suspended")}
        </span>
      ),
    },
    {
      key: "lastLogin",
      header: t("staff.column.lastLogin"),
      render: (row) => (
        <span className="numeric text-xs text-ink-muted">
          {row.lastLoginAt === null
            ? t("staff.neverSignedIn")
            : new Date(row.lastLoginAt).toLocaleDateString(intlLocale(locale))}
        </span>
      ),
    },
    {
      key: "actions",
      header: t("staff.column.actions"),
      align: "end",
      render: (row) =>
        // A doctor's record belongs to the Doctors tab. Listed here so "who has an account" is a
        // complete answer, and linked rather than duplicated so its rules live in one place.
        row.editableHere ? (
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" data-testid={`edit-${row.membershipId}`} onClick={() => openEdit(row)}>
              {t("staff.edit")}
            </Button>
            <Button size="sm" variant="secondary" data-testid={`reset-${row.membershipId}`} onClick={() => void onReset(row)}>
              {t("staff.resetPassword")}
            </Button>
            <Button size="sm" variant="secondary" data-testid={`status-${row.membershipId}`} onClick={() => void onStatus(row)}>
              {t(row.status === "ACTIVE" ? "staff.suspend" : "staff.reactivate")}
            </Button>
          </div>
        ) : (
          <div className="flex justify-end">
            {/* The same "تعديل" the other rows carry, going where that record actually lives: the
                Doctors tab, with this doctor's drawer already open. */}
            <Button
              size="sm"
              variant="ghost"
              data-testid={`edit-${row.membershipId}`}
              onClick={() => onOpenDoctor(row.doctorId)}
            >
              {t("staff.edit")}
            </Button>
          </div>
        ),
    },
  ];

  if (staff === null) return <p className="p-6 text-sm text-ink-muted">{t("staff.loading")}</p>;

  return (
    <main className="mx-auto max-w-4xl" data-testid="staff-page">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-ink">{t("staff.title")}</h1>
        <Button data-testid="create-staff" onClick={() => setCreating(true)}>
          {t("staff.create")}
        </Button>
      </div>

      {failure !== null && (
        <p role="alert" className="mb-3 text-xs text-danger" data-testid="staff-failure">
          {say(failure.code, failure.params)}
        </p>
      )}

      <Card>
        {staff.length === 0 ? (
          <EmptyState title={t("staff.empty")} message={t("staff.emptyMessage")} />
        ) : (
          <DataTable columns={columns} rows={staff} rowKey={(row) => row.membershipId} />
        )}
      </Card>

      <Modal
        open={creating}
        onOpenChange={(open) => {
          if (!open) setCreating(false);
        }}
        title={t("staff.create")}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreating(false)}>
              {t("staff.cancel")}
            </Button>
            <Button
              loading={busy}
              disabled={fullName.trim() === "" || phone.trim() === ""}
              data-testid="create-staff-save"
              onClick={() => void onCreate()}
            >
              {t("staff.create")}
            </Button>
          </div>
        }
      >
        <div className="grid gap-3">
          <TextInput
            label={t("staff.field.name")}
            required
            value={fullName}
            data-testid="staff-name"
            onChange={(event) => setFullName(event.target.value)}
          />
          <TextInput
            label={t("staff.field.phone")}
            required
            numeric
            type="tel"
            inputMode="tel"
            value={phone}
            data-testid="staff-phone"
            onChange={(event) => setPhone(event.target.value)}
          />
          <Select
            label={t("staff.field.role")}
            value={role}
            options={STAFF_ROLES.map((value) => ({ value, label: roleLabel(value, t) }))}
            data-testid="staff-role"
            onChange={(event) => setRole(event.target.value as StaffRole)}
          />
          {/* Doctors are made in the Doctors tab, and the form says so rather than offering a role
              it would then have to refuse. */}
          <p className="text-xs text-ink-muted">{t("staff.doctorsElsewhere")}</p>
        </div>
      </Modal>

      <Modal
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={t("staff.editTitle")}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditing(null)}>
              {t("staff.cancel")}
            </Button>
            <Button
              loading={busy}
              disabled={fullName.trim() === "" || phone.trim() === ""}
              data-testid="edit-staff-save"
              onClick={() => void onSaveEdit()}
            >
              {t("staff.save")}
            </Button>
          </div>
        }
      >
        <div className="grid gap-3">
          <TextInput
            label={t("staff.field.name")}
            required
            value={fullName}
            data-testid="edit-staff-name"
            onChange={(event) => setFullName(event.target.value)}
          />
          <TextInput
            label={t("staff.field.phone")}
            required
            numeric
            type="tel"
            inputMode="tel"
            value={phone}
            data-testid="edit-staff-phone"
            onChange={(event) => setPhone(event.target.value)}
          />
          {editing !== null && roleEditable(editing) ? (
            <Select
              label={t("staff.field.role")}
              value={role}
              options={STAFF_ROLES.map((value) => ({ value, label: roleLabel(value, t) }))}
              data-testid="edit-staff-role"
              onChange={(event) => setRole(event.target.value as StaffRole)}
            />
          ) : (
            // Shown, not offered: the reader sees what the role is and that it is not theirs to
            // change here. A select defaulting to something else is what caused the demotion.
            <div className="grid gap-1">
              <span className="text-xs text-ink-muted">{t("staff.field.role")}</span>
              <p className="text-sm text-ink" data-testid="edit-staff-role-fixed">
                {editing === null ? "" : roleLabel(editing.role, t)}
              </p>
              <span className="text-xs text-ink-subtle">{t("staff.ownerRoleFixed")}</span>
            </div>
          )}
          {/* The phone is the login, and a person is one person: changing it here changes how they
              sign in to every clinic they work at. */}
          <p className="text-xs text-ink-muted">{t("staff.phoneIsLogin")}</p>

          {editing !== null && (
            <ImageField
              label={t("staff.photo")}
              testId="staff-photo"
              present={editing.hasPhoto}
              load={() => loadUserPhoto(authFetch, editing.membershipId)}
              upload={(file) => uploadUserPhoto(authFetch, editing.membershipId, file)}
              remove={() => removeUserPhoto(authFetch, editing.membershipId)}
              onChanged={() => {
                // Re-read rather than toggle a flag: the list's avatar and the dialog's own
                // `present` both come from what the server now holds, so they cannot disagree.
                void loadStaff(authFetch).then((rows) => {
                  setStaff(rows);
                  setEditing(rows.find((row) => row.membershipId === editing.membershipId) ?? null);
                });
              }}
            />
          )}
        </div>
      </Modal>

      {/* **Shown once.** The password is hashed on the server; closing this dialog is the last time
          anybody can read it, and the copy says so plainly rather than implying it can be found again. */}
      <Modal
        open={shown !== null}
        onOpenChange={(open) => {
          if (!open) setShown(null);
        }}
        title={t("staff.temporaryPassword")}
        footer={
          <Button data-testid="dismiss-password" onClick={() => setShown(null)}>
            {t("staff.done")}
          </Button>
        }
      >
        <div className="grid gap-2">
          <p className="text-sm text-ink">{shown?.name}</p>
          <p
            dir="ltr"
            className="numeric select-all rounded-lg bg-surface-sunken px-3 py-2 text-center text-lg font-semibold tracking-widest text-ink"
            data-testid="shown-password"
          >
            {shown?.password}
          </p>
          <p className="text-xs text-warning">{t("staff.shownOnce")}</p>
        </div>
      </Modal>
    </main>
  );
}
