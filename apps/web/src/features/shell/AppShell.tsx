import { useEffect, useState } from "react";
import { CircleHelp } from "lucide-react";
import { BRAND } from "../../brand/brand.ts";
import { BrandMark } from "../../brand/Logo.tsx";
import { NavIcon, NAV_ICON_SIZE, NAV_ICON_STROKE } from "./nav-icons.tsx";
import { ClinicBadge } from "./ClinicBadge.tsx";
import { useClinicLogo } from "./use-clinic-logo.ts";
import { BUILD_VERSION } from "../auth/BuildStamp.tsx";
import { HelpPage } from "./HelpPage.tsx";
import { Avatar } from "../../design-system/Avatar.tsx";
import { Button } from "../../design-system/Button.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import { cx } from "../../lib/cx.ts";
import { LanguageToggle } from "../auth/LanguageToggle.tsx";
import { DayViewPage } from "../day-view/DayViewPage.tsx";
import { AppointmentBookPage } from "../appointments/AppointmentBookPage.tsx";
import { NotificationBell } from "../notifications/NotificationBell.tsx";
import { useUserPhoto } from "../staff/use-user-photo.ts";
import { SupportLink } from "./SupportLink.tsx";
import { QueuePage } from "../queue/QueuePage.tsx";
import { PatientDetailPage } from "../patients/PatientDetailPage.tsx";
import { PatientsPage } from "../patients/PatientsPage.tsx";
import { VisitDraftScreen } from "../visits/VisitDraftScreen.tsx";
import { ConsultationsPage } from "../visits/ConsultationsPage.tsx";
import { MyPatientRecord } from "../visits/MyPatientRecord.tsx";
import { PaymentsPage } from "../billing/PaymentsPage.tsx";
import { ReportsPage } from "../billing/ReportsPage.tsx";
import { StaffPage } from "../staff/StaffPage.tsx";
import { DeskPage } from "../billing/DeskPage.tsx";
import { SchedulesPage } from "../schedules/SchedulesPage.tsx";
import { DoctorsPage } from "../doctors/DoctorsPage.tsx";
import { ServicesPage } from "../services/ServicesPage.tsx";
import { AuditLogPage } from "../audit/AuditLogPage.tsx";
import { ClinicSettingsPage } from "../settings/ClinicSettingsPage.tsx";
import { MyDetailsPage } from "../settings/MyDetailsPage.tsx";
import { useSession } from "../auth/session.tsx";
import { activeNavKey, visibleNavItems } from "./navigation.ts";
import { roleLabel } from "../memberships/role-label.ts";

/**
 * The authenticated shell: sidebar, header, tenant switcher, logout.
 *
 * The last screen in Phase 1, and the one that proves the auth work is real — a session that
 * survives, a clinic name that changes when you switch, and a sidebar that differs by role.
 *
 * Nothing here sets a direction. The document carries `dir` and every rule is a logical property,
 * so the English toggle mirrors the whole layout with no second stylesheet
 * (`web-logical-properties.spec.ts` enforces that repo-wide).
 */

/**
 * Path-based navigation, without a router dependency.
 *
 * `App.tsx` said routing "should be introduced by the change that needs it, with its own review" —
 * this is that change, deliberately at its smallest. `pushState` plus a `popstate` listener gives
 * real URLs and a working back button in about fifteen lines. When a second and third screen land
 * and this starts wanting nested routes or params, that is the moment to weigh `react-router`, and
 * it is a dependency decision to bring to the founder rather than take here.
 */
function useCurrentPath(): [string, (path: string) => void] {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPop = (): void => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = (next: string): void => {
    if (next === window.location.pathname) return;
    window.history.pushState(null, "", next);
    setPath(next);
  };

  return [path, navigate];
}

export function AppShell() {
  const { t } = useLocale();
  const [path, navigate] = useCurrentPath();
  const { me, logout, switchTenant, authFetch } = useSession();

  /**
   * The first route with a parameter, which is what the note above anticipated: *"when a second and
   * third screen land and this starts wanting nested routes or params, that is the moment to weigh
   * `react-router`, and it is a dependency decision to bring to the founder rather than take here."*
   *
   * One parameter, matched with one expression, is not yet that moment — adding a routing library
   * for a single `/patients/:id` would be a dependency taken to avoid four lines. It is raised for
   * the founder rather than settled here, and the second parameterised route is when it should be
   * asked again rather than absorbed again.
   */
  const patientId = /^\/patients\/([0-9a-fA-F-]{36})$/.exec(path)?.[1] ?? null;
  // The visit screen is appointment-scoped, like every other clinical route.
  const visitAppointmentId = /^\/visits\/([0-9a-fA-F-]{36})$/.exec(path)?.[1] ?? null;
  // The desk is charge-scoped: it is reached from a row on the payments screen or from the
  // appointment panel once the visit has completed, never browsed to.
  const deskChargeId = /^\/charges\/([0-9a-fA-F-]{36})$/.exec(path)?.[1] ?? null;
  const openDoctorId = /^\/doctors\/([0-9a-fA-F-]{36})$/.exec(path)?.[1] ?? null;
  // «مرضاي» — R-B. Declared before the `/visits/:appointmentId` match is consulted below, so the
  // literal segment cannot be read as a malformed id.
  const myPatientId = /^\/visits\/patients\/([0-9a-fA-F-]{36})$/.exec(path)?.[1] ?? null;
  const myPhoto = useUserPhoto(me.membershipId);
  // Re-fetched when the clinic switches, which is what makes the switcher change the mark too.
  const clinicLogo = useClinicLogo(me.tenantId);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState(false);

  const items = visibleNavItems(me.permissions);
  // **Which section is current, not which link was clicked.** Comparing `path === item.path` left
  // the sidebar blank on every nested route — a patient, a visit, the desk — which is exactly when
  // a reader most needs it to say where they are.
  const currentKey = activeNavKey(path);
  const current = me.memberships.find((m) => m.membershipId === me.membershipId);

  /**
   * **A clinic switcher, and it lists clinics — ruled 2026-09-09, superseding 2026-09-06.**
   *
   * One person holds one role per clinic. The August arrangement gave a working owner a second
   * RECEPTIONIST membership in the same clinic to switch into, and the switcher grew a role suffix
   * so the two buttons could be told apart. That arrangement is withdrawn: the admin app is generic,
   * the owner is not assumed to practise, and setup is normally done by the vendor's onboarding team
   * on the clinic's behalf — so a button offering to become the receptionist of the clinic you own
   * describes a person the product no longer assumes exists.
   *
   * The schema is unchanged. `memberships` still permits several per person per clinic, because a
   * **doctor working in two clinics** is the case that constraint was lifted for and that case is
   * real. What changed is that the seed no longer manufactures a second role in one clinic, and this
   * list is keyed by clinic rather than by membership.
   */
  const others = me.memberships
    .filter((m) => m.tenantId !== current?.tenantId)
    // Distinct clinics: if a person somehow holds two roles in one other clinic, offering both
    // buttons would ask them a question the product has no answer for. The first is the switch.
    .filter((m, index, all) => all.findIndex((other) => other.tenantId === m.tenantId) === index);

  const labelFor = (membership: { tenantName: string }): string => membership.tenantName;

  async function onSwitch(membershipId: string): Promise<void> {
    if (switching) return;
    setSwitching(true);
    setSwitchError(false);
    const ok = await switchTenant(membershipId);
    if (!ok) setSwitchError(true);
    setSwitching(false);
  }

  return (
    <div className="min-h-dvh bg-surface-sunken text-ink flex">
      <aside className="hidden w-60 shrink-0 border-e border-border bg-surface md:flex md:flex-col">
        <div className="flex items-center gap-2.5 border-b border-border px-5 py-4">
          <BrandMark size={28} />
          <span className="text-lg font-semibold text-ink">{BRAND.name}</span>
        </div>

        <nav aria-label={t("shell.nav.sectionLabel")} className="flex-1 overflow-y-auto p-3">
          <ul className="flex flex-col gap-1">
            {items.map((item) => (
              <li key={item.key}>
                {/*
                  A real <a> once the screen exists; otherwise a <span aria-disabled>. A link that
                  goes nowhere is a bug report -- the reviewer clicks it, nothing happens, and they
                  cannot tell "not built" from "broken". The "قريبًا" badge says which.
                */}
                {item.path === undefined ? (
                  <span
                    aria-disabled="true"
                    className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink-subtle cursor-default select-none"
                  >
                    <NavIcon navKey={item.key} />
                    <span className="flex-1">{t(item.key)}</span>
                    <span className="rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] text-ink-muted">
                      {t("shell.nav.comingSoon")}
                    </span>
                  </span>
                ) : (
                  <a
                    href={item.path}
                    aria-current={currentKey === item.key ? "page" : undefined}
                    onClick={(event) => {
                      // Left-click only, and no modifier: ctrl/cmd-click must still open a tab.
                      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                      event.preventDefault();
                      navigate(item.path as string);
                    }}
                    className={cx(
                      "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm",
                      // Filled in primary with white text, per the brief. The old active state was
                      // a grey tint, which on a sidebar of thirteen items said "hovered" more than
                      // it said "you are here".
                      currentKey === item.key
                        ? "bg-primary font-medium text-white"
                        : "text-ink-muted hover:bg-primary-soft hover:text-primary",
                    )}
                  >
                    <NavIcon navKey={item.key} />
                    <span className="flex-1">{t(item.key)}</span>
                  </a>
                )}
              </li>
            ))}
          </ul>
        </nav>

        {/*
          The foot of the sidebar: help, and which build this is.

          «مساعدة» is a static page rather than a section — it is deliberately below the rule, not
          in the list above, because the brief said the sections stay exactly as they are. The
          version sits under it for the reason `BuildStamp` exists on the login page: when a clinic
          says "it did something odd", the first question is which build they are on, and an answer
          they can read aloud is worth more than one we have to go and look up.
        */}
        <div className="border-t border-border p-3">
          <a
            href="/help"
            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink-muted hover:bg-primary-soft hover:text-primary"
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
              event.preventDefault();
              navigate("/help");
            }}
          >
            <CircleHelp size={NAV_ICON_SIZE} strokeWidth={NAV_ICON_STROKE} aria-hidden="true" className="shrink-0" />
            <span className="flex-1">{t("shell.nav.help")}</span>
          </a>
          <p className="numeric px-3 pt-2 text-[11px] text-ink-subtle">{BUILD_VERSION}</p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-3 border-b border-border bg-surface px-4 py-3">
          {/*
            **The clinic leads the top bar** — ruled 2026-09-15. Its own mark, then its name as the
            page's heading, with who you are here beneath it. The NOMED mark is not used as the
            fallback: a clinic with no logo shows its own initials, so none of them looks like ours.
          */}
          <ClinicBadge
            clinicName={current?.tenantName ?? "—"}
            logoUrl={clinicLogo}
            userName={me.user.fullName}
            roleText={roleLabel(me.role, t)}
            onAccount={() => navigate("/me")}
          />

          <div className="ms-auto flex items-center gap-2">
            {/*
              The signed-in person's own face, moved here with the clinic badge: it belongs with the
              account controls rather than competing with the clinic's mark at the start of the bar.
              No `hasPhoto` hint exists — the shell knows a membership and nothing else — so a 404 is
              an ordinary answer.
            */}
            <Avatar name={me.user.fullName} src={myPhoto} size="sm" />
            {others.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="hidden text-xs text-ink-muted sm:inline">{t("shell.switchClinic")}</span>
                {others.map((membership) => (
                  <Button
                    key={membership.membershipId}
                    variant="secondary"
                    size="sm"
                    loading={switching}
                    onClick={() => void onSwitch(membership.membershipId)}
                  >
                    {labelFor(membership)}
                  </Button>
                ))}
              </div>
            )}

            {/* Only for roles that can see a booking -- the same capability the API guards on. */}
            {/*
              `appointments.read`, not `.write`. The two were split on 2026-09-06 and the
              notification routes went to the read side deliberately — dismissing your own
              notification is a personal act, not a desk operation. Gating the bell on the write
              half would have taken an owner's notifications away as a side effect of a ruling
              about who books appointments.
            */}
            {me.permissions["appointments.read"] !== "none" && <NotificationBell />}

            <SupportLink />

            <LanguageToggle inline />

            <Button variant="ghost" size="sm" onClick={() => void logout()}>
              {t("shell.logout")}
            </Button>
          </div>
        </header>

        {switchError && (
          <p role="alert" className="border-b border-border bg-danger-soft px-4 py-2 text-sm text-danger">
            {t("shell.switchClinic.failed")}
          </p>
        )}

        <main className="flex-1 p-6">
          {path === "/appointments" ? (
            <AppointmentBookPage />
          ) : path === "/day" ? (
            <DayViewPage />
          ) : path === "/queue" ? (
            <QueuePage />
          ) : path === "/schedules" ? (
            <SchedulesPage />
          ) : path === "/services" ? (
            <ServicesPage />
          ) : path === "/doctors" ? (
            <DoctorsPage />
          ) : openDoctorId !== null ? (
            // The users list links here for a doctor row: the Doctors tab with that drawer open.
            <DoctorsPage openDoctorId={openDoctorId} />
          ) : path === "/help" ? (
            <HelpPage />
          ) : path === "/me" ? (
            <MyDetailsPage authFetch={authFetch} membershipId={me.membershipId} />
          ) : path === "/audit-log" ? (
            <AuditLogPage authFetch={authFetch} />
          ) : path === "/reports" ? (
            <ReportsPage authFetch={authFetch} currency={me.currency} />
          ) : path === "/settings" ? (
            <ClinicSettingsPage authFetch={authFetch} />
          ) : path === "/patients" ? (
            <PatientsPage onOpen={(id) => navigate(`/patients/${id}`)} />
          ) : path === "/users" ? (
            <StaffPage
              onOpenDoctor={(doctorId) => navigate(doctorId === null ? "/doctors" : `/doctors/${doctorId}`)}
            />
          ) : path === "/appointments" ? (
            <AppointmentBookPage />
          ) : path === "/payments" ? (
            <PaymentsPage
              authFetch={authFetch}
              currency={me.currency}
              onOpenCharge={(chargeId) => navigate(`/charges/${chargeId}`)}
            />
          ) : deskChargeId !== null ? (
            <DeskPage authFetch={authFetch} chargeId={deskChargeId} currency={me.currency} />
          ) : myPatientId !== null ? (
            <MyPatientRecord
              authFetch={authFetch}
              patientId={myPatientId}
              onBack={() => navigate("/visits/patients")}
            />
          ) : path === "/visits" || path === "/visits/patients" ? (
            <ConsultationsPage
              authFetch={authFetch}
              onGoToQueue={() => navigate("/queue")}
              tab={path === "/visits/patients" ? "MINE" : "OPEN"}
              onSelectTab={(next) => navigate(next === "MINE" ? "/visits/patients" : "/visits")}
              onOpenPatient={(id) => navigate(`/visits/patients/${id}`)}
            />
          ) : visitAppointmentId !== null ? (
            <VisitDraftScreen
              authFetch={authFetch}
              appointmentId={visitAppointmentId}
              currency={me.currency}
            />
          ) : patientId !== null ? (
            <PatientDetailPage patientId={patientId} onBack={() => navigate("/patients")} />
          ) : (
            <div className="mx-auto max-w-2xl rounded-xl border border-border bg-surface p-8 text-center">
              <h1 className="text-lg font-semibold">{t("shell.placeholder.title")}</h1>
              <p className="mt-2 text-sm text-ink-muted">{t("shell.placeholder.body")}</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
