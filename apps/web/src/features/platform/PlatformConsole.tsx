// «لوحة المشغّل» — pilot-readiness 0b–0f, and the back office of 2026-09-15. The vendor's own
// surface: clinics, their size, what was agreed, and the acts that keep one running. No clinical
// data reaches it, and the server is what guarantees that.

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Card, DataTable, EmptyState, type Column } from "../../design-system/display.tsx";
import { Spinner } from "../../design-system/Spinner.tsx";
import { LanguageToggle } from "../auth/LanguageToggle.tsx";
import { formatMinor, intlLocale } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { AdminsDialog } from "./AdminsDialog.tsx";
import { ClientFilePanel } from "./ClientFilePanel.tsx";
import { ConnectWhatsAppPanel } from "./ConnectWhatsAppPanel.tsx";
import { RenewPanel } from "./RenewPanel.tsx";
import { WhatsAppBadge } from "./WhatsAppBadge.tsx";
import { attachWhatsAppThroughMeta } from "./clinic-whatsapp-attach.ts";
import { NewClinicForm, BLANK_CLINIC, type NewClinicSubmit } from "./NewClinicForm.tsx";
import { createClinicThroughMeta } from "./clinic-whatsapp-create.ts";
import { OperatorLogin } from "./OperatorLogin.tsx";
import { OperatorsPanel } from "./OperatorsPanel.tsx";
import { RecoveryCodesBanner } from "./RecoveryCodesBanner.tsx";
import { ReplaceAuthenticator } from "./ReplaceAuthenticator.tsx";
import {
  createClinic,
  loadClinics,
  loadMe,
  loadOperators,
  renewClinic,
  setSuspension,
  type Clinic,
  type NewClinicInput,
  type Me,
  type Operator,
} from "./platform-api.ts";
import { refusalText } from "./refusal-text.ts";

/** What the expiry job writes into `suspensionReason` (api: subscription-dates.ts). */
const SUBSCRIPTION_EXPIRED_REASON = "SUBSCRIPTION_EXPIRED";

/** A password shown once. Held in state only until the operator dismisses it. */
interface Issued {
  what: "clinic" | "operator";
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
  /** The clinic whose WhatsApp panel / renewal panel is open. One at a time, like the client file. */
  const [connecting, setConnecting] = useState<string | null>(null);
  const [renewing, setRenewing] = useState<string | null>(null);
  /** The clinic whose admins dialog is open. */
  const [adminsOf, setAdminsOf] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The three panels open below the table, out of sight on a long list. Each scrolls itself into view
  // when it opens. `scrollIntoView` is absent in the test DOM, hence the optional call.
  const connectRef = useRef<HTMLDivElement | null>(null);
  const renewRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLDivElement | null>(null);
  const scrollTo = (element: HTMLDivElement | null) => element?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  useEffect(() => {
    if (connecting !== null) scrollTo(connectRef.current);
  }, [connecting]);
  useEffect(() => {
    if (renewing !== null) scrollTo(renewRef.current);
  }, [renewing]);
  useEffect(() => {
    if (openFile !== null) scrollTo(fileRef.current);
  }, [openFile]);

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

  async function onConnect(row: Clinic, existingNumber: boolean): Promise<void> {
    setBusy(true);
    setRefusal(null);
    const result = await attachWhatsAppThroughMeta(row.tenantId, existingNumber);
    setBusy(false);
    if (!result.ok) {
      setRefusal(t(result.messageKey));
      return;
    }
    setConnecting(null);
    await refresh();
  }

  async function onRenew(row: Clinic, subscriptionStartsOn: string, renewalOn: string): Promise<void> {
    if (await act(() => renewClinic(row.tenantId, subscriptionStartsOn, renewalOn))) setRenewing(null);
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
            <span className="block text-xs text-ink-subtle">
              {row.suspensionReason === SUBSCRIPTION_EXPIRED_REASON
                ? t("platform.suspension.SUBSCRIPTION_EXPIRED")
                : row.suspensionReason}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "whatsapp",
      header: t("platform.whatsapp"),
      render: (row) => <WhatsAppBadge clinic={row} />,
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
            <span className="numeric block text-ink-subtle">
              {row.subscriptionStartsOn !== null ? `${row.subscriptionStartsOn} → ${row.renewalOn}` : row.renewalOn}
            </span>
          )}
          {/* No range yet, or one that has not started: the clinic is up, the bot is silent. */}
          {row.botPaused && (
            <span className="block text-danger" data-testid={`bot-paused-${row.tenantId}`}>
              {t(row.renewalOn === null ? "platform.range.none" : "platform.range.botPaused")}
            </span>
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
          {/* A clinic stopped by its expiry is turned back on by renewing it, which sets the new date;
              a plain reactivation would be undone by the expiry job within a minute. */}
          {!(row.status !== "ACTIVE" && row.suspensionReason === SUBSCRIPTION_EXPIRED_REASON) && (
            <Button
              size="sm"
              variant="ghost"
              loading={busy}
              data-testid={`suspend-${row.tenantId}`}
              onClick={() => void onSuspension(row)}
            >
              {t(row.status === "ACTIVE" ? "platform.suspend" : "platform.reactivate")}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            data-testid={`renew-${row.tenantId}`}
            onClick={() => {
              setConnecting(null);
              setRenewing(renewing === row.tenantId ? null : row.tenantId);
            }}
          >
            {t("platform.renew")}
          </Button>
          {(row.whatsapp?.state ?? "NONE") !== "CONNECTED" && (
            <Button
              size="sm"
              variant="ghost"
              data-testid={`connect-whatsapp-${row.tenantId}`}
              onClick={() => {
                setRenewing(null);
                setConnecting(connecting === row.tenantId ? null : row.tenantId);
              }}
            >
              {t((row.whatsapp?.state ?? "NONE") === "NONE" ? "platform.whatsapp.connect" : "platform.whatsapp.reconnect")}
            </Button>
          )}
          {row.admins.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              data-testid={`admins-${row.tenantId}`}
              onClick={() => setAdminsOf(row.tenantId)}
            >
              {t("platform.admins.open")}
            </Button>
          )}
        </span>
      ),
    },
  ];

  const selected = clinics?.find((row) => row.tenantId === openFile) ?? null;
  const connectingClinic = clinics?.find((row) => row.tenantId === connecting) ?? null;
  const renewingClinic = clinics?.find((row) => row.tenantId === renewing) ?? null;
  const adminsClinic = clinics?.find((row) => row.tenantId === adminsOf) ?? null;

  return (
    <main className="mx-auto max-w-6xl p-6" data-testid="platform-console">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-ink">{t("platform.title")}</h1>
          <p className="text-sm text-ink-muted">{t("platform.subtitle")}</p>
        </div>
        <div className="flex items-center gap-3">
          <p className="text-sm text-ink-muted">
            {me.fullName} · {t(`platform.role.${me.platformRole}` as TranslationKey)}
          </p>
          <LanguageToggle inline />
        </div>
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

      <AdminsDialog clinic={adminsClinic} onClose={() => setAdminsOf(null)} />

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
                onSubmit={async (mode: NewClinicSubmit) => {
                  setBusy(true);
                  setRefusal(null);
                  const input = { ...draft, nameEn: (draft.nameEn ?? "").trim() === "" ? undefined : draft.nameEn?.trim() };
                  const result = mode.whatsapp
                    ? await createClinicThroughMeta(input, mode.existingNumber)
                    : await createClinic(input);
                  setBusy(false);
                  if (!result.ok) {
                    setRefusal("messageKey" in result ? t(result.messageKey) : refusalText(t, result.code, result.params));
                    return;
                  }
                  const password = "temporaryPassword" in result ? result.temporaryPassword : "";
                  setIssued({ what: "clinic", who: draft.adminFullName, password });
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
              {connectingClinic !== null && (
                <div className="mt-4 scroll-mt-4" ref={connectRef}>
                  <ConnectWhatsAppPanel
                    clinic={connectingClinic}
                    busy={busy}
                    onConnect={(existingNumber) => void onConnect(connectingClinic, existingNumber)}
                    onCancel={() => setConnecting(null)}
                  />
                </div>
              )}
              {renewingClinic !== null && (
                <div className="mt-4 scroll-mt-4" ref={renewRef}>
                  <RenewPanel
                    clinic={renewingClinic}
                    busy={busy}
                    onRenew={(from, to) => void onRenew(renewingClinic, from, to)}
                    onCancel={() => setRenewing(null)}
                  />
                </div>
              )}
              {selected !== null && (
                <div className="mt-4 scroll-mt-4" ref={fileRef}>
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
