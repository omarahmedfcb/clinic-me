// «لوحة المشغّل» — pilot-readiness 0b–0f, and the back office of 2026-09-15. The vendor's own
// surface: clinics, their size, what was agreed, and the acts that keep one running. No clinical
// data reaches it, and the server is what guarantees that.

import { useCallback, useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Card, DataTable, EmptyState, type Column } from "../../design-system/display.tsx";
import { Spinner } from "../../design-system/Spinner.tsx";
import { formatMinor, intlLocale } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { ClientFilePanel } from "./ClientFilePanel.tsx";
import { NewClinicForm, BLANK_CLINIC } from "./NewClinicForm.tsx";
import { OperatorLogin } from "./OperatorLogin.tsx";
import { OperatorsPanel } from "./OperatorsPanel.tsx";
import { RecoveryCodesBanner } from "./RecoveryCodesBanner.tsx";
import { ReplaceAuthenticator } from "./ReplaceAuthenticator.tsx";
import {
  createClinic,
  loadClinics,
  loadMe,
  loadOperators,
  resetAdminPassword,
  setSuspension,
  type Clinic,
  type NewClinicInput,
  type Me,
  type Operator,
} from "./platform-api.ts";
import { refusalText } from "./refusal-text.ts";

/** A password shown once. Held in state only until the operator dismisses it. */
interface Issued {
  what: "clinic" | "reset" | "operator";
  who: string;
  password: string;
}

type Tab = "clinics" | "operators";

export function PlatformConsole() {
  const { t, locale } = useLocale();
  const [me, setMe] = useState<Me | null>(null);
  /** Postponed until the next sign-in. Deliberately not persisted — a reload asks again. */
  const [replacePostponed, setReplacePostponed] = useState(false);
  const [tab, setTab] = useState<Tab>("clinics");
  const [clinics, setClinics] = useState<Clinic[] | null>(null);
  const [operators, setOperators] = useState<Operator[]>([]);
  const [failed, setFailed] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<NewClinicInput>(BLANK_CLINIC);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [rows, people] = await Promise.all([loadClinics(), loadOperators()]);
      setClinics(rows);
      setOperators(people);
      setFailed(false);
    } catch {
      setClinics(null);
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    if (me !== null) void refresh();
  }, [me, refresh]);

  if (me === null) {
    return (
      <OperatorLogin
        onSignedIn={(fullName) => {
          // `/platform/me` is what says which seat they hold, and the screen decides what to offer
          // from it. Read from the server rather than trusted from the login response.
          void (async () => {
            const who = await loadMe();
            // SUPPORT on a failed read: the narrower seat, so a hiccup hides controls rather than
            // offering ones the server will refuse.
            setMe(who ?? { userId: "", fullName, platformRole: "SUPPORT", recoveryCodesRemaining: 0, via: null });
          })();
        }}
      />
    );
  }

  // A recovery code opened this session, so the authenticator is gone. The console opens here until
  // it is replaced or postponed — postponed until the next sign-in, and there is no way to dismiss it.
  if (me.via === "recovery" && !replacePostponed) {
    return (
      <ReplaceAuthenticator
        onPostpone={() => setReplacePostponed(true)}
        onReplaced={() => {
          void (async () => {
            setMe((await loadMe()) ?? me);
            setReplacePostponed(false);
          })();
        }}
      />
    );
  }

  const day = new Intl.DateTimeFormat(intlLocale(locale), { year: "numeric", month: "short", day: "numeric" });

  async function act(run: () => Promise<{ ok: true } | { ok: false; code: string; params: Record<string, unknown> }>) {
    setBusy(true);
    setRefusal(null);
    const result = await run();
    setBusy(false);
    if (!result.ok) {
      setRefusal(refusalText(t, result.code, result.params));
      return false;
    }
    await refresh();
    return true;
  }

  async function onReset(row: Clinic, admin: { userId: string; fullName: string }): Promise<void> {
    setBusy(true);
    setRefusal(null);
    const result = await resetAdminPassword(row.tenantId, admin.userId);
    setBusy(false);
    if (!result.ok) {
      setRefusal(refusalText(t, result.code, result.params));
      return;
    }
    setIssued({ what: "reset", who: result.fullName, password: result.temporaryPassword });
  }

  async function onSuspension(row: Clinic): Promise<void> {
    if (row.status !== "ACTIVE") {
      await act(() => setSuspension(row.tenantId, { suspended: false }));
      return;
    }
    // A reason is required by the database, so it is asked for here rather than refused afterwards.
    const reason = window.prompt(t("platform.suspendReason"));
    if (reason === null || reason.trim() === "") return;
    await act(() => setSuspension(row.tenantId, { suspended: true, reason }));
  }

  const columns: Column<Clinic>[] = [
    {
      key: "name",
      header: t("platform.clinic"),
      render: (row) => (
        <span>
          <span className="block text-ink">{row.name}</span>
          <span className="block text-xs text-ink-subtle">{row.slug}</span>
        </span>
      ),
    },
    {
      key: "status",
      header: t("platform.status"),
      render: (row) => (
        <span className={row.status === "ACTIVE" ? "text-ink" : "text-danger"}>
          {t(`platform.status.${row.status}` as TranslationKey)}
          {row.suspensionReason !== null && (
            <span className="block text-xs text-ink-subtle">{row.suspensionReason}</span>
          )}
        </span>
      ),
    },
    {
      key: "account",
      header: t("platform.accountStatus"),
      render: (row) => (
        <span className="text-xs">
          <span className={row.accountStatus === "OVERDUE" ? "block text-danger" : "block text-ink"}>
            {t(`platform.account.${row.accountStatus}` as TranslationKey)}
          </span>
          {/*
            The fourteen-day warning. Computed on the server from an explicit instant, so the flag
            does not depend on the reviewer's clock — and it stays on once the date is past, because
            a renewal nobody acted on is exactly the case a reminder exists for.
          */}
          {row.renewalDue && (
            <span className="numeric block text-danger" data-testid={`renewal-due-${row.tenantId}`}>
              {t("platform.renewalDue")} · {row.renewalOn}
            </span>
          )}
          {!row.renewalDue && row.renewalOn !== null && (
            <span className="numeric block text-ink-subtle">{row.renewalOn}</span>
          )}
        </span>
      ),
    },
    {
      key: "size",
      header: t("platform.size"),
      render: (row) => (
        <span className="text-xs text-ink-muted">
          <span className="numeric">{row.patients}</span> {t("platform.patients")} ·{" "}
          <span className="numeric">{row.doctors}</span> {t("platform.doctors")} ·{" "}
          <span className="numeric">{row.staff}</span> {t("platform.staff")}
        </span>
      ),
    },
    {
      key: "lastActivity",
      header: t("platform.lastActivity"),
      render: (row) =>
        row.lastActivity === null ? (
          <span className="text-ink-subtle">{t("platform.never")}</span>
        ) : (
          <span className="numeric">{day.format(new Date(row.lastActivity))}</span>
        ),
    },
    {
      key: "plan",
      header: t("platform.plan"),
      align: "end",
      render: (row) => (
        <span className="text-xs">
          <span className="numeric block text-ink">{formatMinor(row.plan.monthlyMinor, row.currency, locale)}</span>
          <span className="numeric block text-ink-subtle">
            {row.plan.includedMessages} {t("platform.messages")}
          </span>
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      render: (row) => (
        <span className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="ghost"
            data-testid={`client-file-${row.tenantId}`}
            onClick={() => setOpenFile(openFile === row.tenantId ? null : row.tenantId)}
          >
            {t("platform.clientFile")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={busy}
            data-testid={`suspend-${row.tenantId}`}
            onClick={() => void onSuspension(row)}
          >
            {t(row.status === "ACTIVE" ? "platform.suspend" : "platform.reactivate")}
          </Button>
          {/* Only for an admin the server would accept: a doctor is not in `admins` at all, so
              there is no button here to be refused. */}
          {row.admins.map((admin) => (
            <Button
              key={admin.userId}
              size="sm"
              variant="ghost"
              loading={busy}
              data-testid={`reset-${admin.userId}`}
              onClick={() => void onReset(row, admin)}
            >
              {t("platform.resetPassword")}
            </Button>
          ))}
        </span>
      ),
    },
  ];

  const selected = clinics?.find((row) => row.tenantId === openFile) ?? null;

  return (
    <main className="mx-auto max-w-6xl p-6" data-testid="platform-console">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-ink">{t("platform.title")}</h1>
          <p className="text-sm text-ink-muted">{t("platform.subtitle")}</p>
        </div>
        <p className="text-sm text-ink-muted">
          {me.fullName} · {t(`platform.role.${me.platformRole}` as TranslationKey)}
        </p>
      </div>

      <div className="mb-4 flex gap-2">
        <Button
          size="sm"
          variant={tab === "clinics" ? "primary" : "ghost"}
          data-testid="tab-clinics"
          onClick={() => setTab("clinics")}
        >
          {t("platform.clinics")}
        </Button>
        <Button
          size="sm"
          variant={tab === "operators" ? "primary" : "ghost"}
          data-testid="tab-operators"
          onClick={() => setTab("operators")}
        >
          {t("platform.operators")}
        </Button>
      </div>

      {refusal !== null && (
        <p role="alert" className="mb-3 text-sm text-danger" data-testid="platform-refusal">
          {refusal}
        </p>
      )}

      {issued !== null && (
        <div className="mb-4">
          <Card title={t(`platform.issued.${issued.what}` as TranslationKey)}>
            <p className="text-sm text-ink">{issued.who}</p>
            <p className="numeric mt-2 select-all rounded-lg bg-surface-sunken px-3 py-2 text-lg" data-testid="issued-password">
              {issued.password}
            </p>
            {/* Shown once and never readable again — the server keeps only the hash. */}
            <p className="mt-2 text-xs text-ink-muted">{t("platform.shownOnce")}</p>
            <div className="mt-3">
              <Button size="sm" variant="secondary" data-testid="dismiss-password" onClick={() => setIssued(null)}>
                {t("platform.dismiss")}
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* Above the tabs' content, on every tab: it is not a task on one screen, it is a standing
          state of the account, and it stays until the supply is replenished. */}
      <RecoveryCodesBanner
        remaining={me.recoveryCodesRemaining}
        onRegenerated={() => {
          void (async () => setMe((await loadMe()) ?? me))();
        }}
      />

      {tab === "operators" ? (
        <OperatorsPanel
          me={me}
          onIssued={(who, password) => setIssued({ what: "operator", who, password })}
          onChanged={() => void refresh()}
        />
      ) : (
        <>
          <div className="mb-4">
            {creating ? (
              <NewClinicForm
                draft={draft}
                busy={busy}
                onChange={setDraft}
                onCancel={() => {
                  setCreating(false);
                  setDraft(BLANK_CLINIC);
                }}
                onSubmit={async () => {
                  setBusy(true);
                  setRefusal(null);
                  const result = await createClinic(draft);
                  setBusy(false);
                  if (!result.ok) {
                    setRefusal(refusalText(t, result.code, result.params));
                    return;
                  }
                  setIssued({ what: "clinic", who: draft.adminFullName, password: result.temporaryPassword });
                  setCreating(false);
                  setDraft(BLANK_CLINIC);
                  await refresh();
                }}
              />
            ) : (
              <Button data-testid="new-clinic" onClick={() => setCreating(true)}>
                {t("platform.newClinic")}
              </Button>
            )}
          </div>

          {failed ? (
            <p role="alert" className="text-sm text-danger" data-testid="platform-failed">
              {t("platform.loadFailed")}
            </p>
          ) : clinics === null ? (
            <Spinner />
          ) : (
            <>
              <Card title={t("platform.clinics")} padded={false}>
                <div data-testid="clinic-list">
                  <DataTable
                    columns={columns}
                    rows={clinics}
                    rowKey={(row) => row.tenantId}
                    caption={t("platform.clinics")}
                    empty={<EmptyState title={t("platform.noClinics")} message="" />}
                  />
                </div>
              </Card>
              {selected !== null && (
                <div className="mt-4">
                  <ClientFilePanel clinic={selected} operators={operators} onClose={() => setOpenFile(null)} />
                </div>
              )}
            </>
          )}
        </>
      )}
    </main>
  );
}
