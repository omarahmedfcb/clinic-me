import { useEffect, useState } from "react";
import { BRAND } from "../../brand/brand.ts";
import { BrandMark } from "../../brand/Logo.tsx";
import { ClinicBadge } from "./ClinicBadge.tsx";
import { useClinicLogo } from "./use-clinic-logo.ts";
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
import { ComplaintsPage } from "../complaints/ComplaintsPage.tsx";
import { ClinicSettingsPage } from "../settings/ClinicSettingsPage.tsx";
import { MyDetailsPage } from "../settings/MyDetailsPage.tsx";
import { useSession } from "../auth/session.tsx";
import { activeNavKey, visibleNavItems } from "./navigation.ts";
import { roleLabel } from "../memberships/role-label.ts";
import { SidebarFoot, SidebarNav } from "./SidebarNav.tsx";
import { Drawer } from "../../design-system/overlays.tsx";
import { Menu } from "lucide-react";
import { ConnectionBanner } from "./ConnectionBanner.tsx";

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
  const visitAppointmentId =
    /^\/visits\/([0-9a-fA-F-]{36})$/.exec(path)?.[1] ?? null;
  // The desk is charge-scoped: it is reached from a row on the payments screen or from the
  // appointment panel once the visit has completed, never browsed to.
  const deskChargeId =
    /^\/charges\/([0-9a-fA-F-]{36})$/.exec(path)?.[1] ?? null;
  const openDoctorId =
    /^\/doctors\/([0-9a-fA-F-]{36})$/.exec(path)?.[1] ?? null;
  // «مرضاي» — R-B. Declared before the `/visits/:appointmentId` match is consulted below, so the
  // literal segment cannot be read as a malformed id.
  const myPatientId =
    /^\/visits\/patients\/([0-9a-fA-F-]{36})$/.exec(path)?.[1] ?? null;
  const myPhoto = useUserPhoto(me.membershipId);
  // Re-fetched when the clinic switches, which is what makes the switcher change the mark too.
  const clinicLogo = useClinicLogo(me.tenantId);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState(false);

  const [menuOpen, setMenuOpen] = useState(false);

  // Close the drawer after any navigation, and if the window grows to desktop width.
  useEffect(() => setMenuOpen(false), [path]);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)");
    const onChange = (): void => {
      if (query.matches) setMenuOpen(false);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const items = visibleNavItems(me.permissions);
  // **Which section is current, not which link was clicked.** Comparing `path === item.path` left
  // the sidebar blank on every nested route — a patient, a visit, the desk — which is exactly when
  // a reader most needs it to say where they are.
  const currentKey = activeNavKey(path);
  const current = me.memberships.find(
    (m) => m.membershipId === me.membershipId,
  );

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
    .filter(
      (m, index, all) =>
        all.findIndex((other) => other.tenantId === m.tenantId) === index,
    );

  const labelFor = (membership: { tenantName: string }): string =>
    membership.tenantName;

  async function onSwitch(membershipId: string): Promise<void> {
    if (switching) return;
    setSwitching(true);
    setSwitchError(false);
    const ok = await switchTenant(membershipId);
    if (!ok) setSwitchError(true);
    setSwitching(false);
  }

  const clinicSwitcher = (labelClass: string) =>
    others.length > 0 && (
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className={cx("text-xs text-ink-muted", labelClass)}>
          {t("shell.switchClinic")}
        </span>
        {others.map((membership) => (
          <Button
            key={membership.membershipId}
            variant="secondary"
            size="sm"
            loading={switching}
            onClick={() => void onSwitch(membership.membershipId)}
          >
            <span className="block max-w-40 truncate">
              {labelFor(membership)}
            </span>
          </Button>
        ))}
      </div>
    );
  return (
    <div className="min-h-dvh bg-surface-sunken text-ink flex">
      <aside className="hidden w-60 shrink-0 border-e border-border bg-surface md:flex md:flex-col">
        <div className="flex items-center gap-2.5 border-b border-border px-5 py-4">
          <BrandMark size={28} />
          <span className="text-lg font-semibold text-ink">{BRAND.name}</span>
        </div>
        <SidebarNav
          items={items}
          currentKey={currentKey}
          onNavigate={navigate}
          className="flex-1 overflow-y-auto p-3"
        />
        <SidebarFoot onNavigate={navigate} />
      </aside>

      {/* Small screens: the same sections in a drawer, opened by the menu button in the header. */}
      <div className="md:hidden">
        <Drawer
          open={menuOpen}
          onOpenChange={setMenuOpen}
          title={BRAND.name}
          footer={
            <>
              {clinicSwitcher("")}
              <SupportLink />
              <LanguageToggle inline />
              <Button variant="ghost" size="sm" onClick={() => void logout()}>
                {t("shell.logout")}
              </Button>
            </>
          }
        >
          <SidebarNav
            items={items}
            currentKey={currentKey}
            onNavigate={navigate}
          />
          <SidebarFoot onNavigate={navigate} />
        </Drawer>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-border bg-surface px-3 py-3 md:flex-wrap md:gap-3 md:px-4">
          <div className="md:hidden">
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("shell.menu.open")}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(true)}
            >
              <Menu size={22} aria-hidden="true" />
            </Button>
          </div>

          <div className="min-w-0 flex-1 md:flex-initial">
            <ClinicBadge
              clinicName={current?.tenantName ?? "—"}
              logoUrl={clinicLogo}
              userName={me.user.fullName}
              roleText={roleLabel(me.role, t)}
              onAccount={() => navigate("/me")}
            />
          </div>

          <div className="flex items-center gap-2 md:ms-auto">
            <div className="hidden items-center gap-2 md:flex">
              <Avatar name={me.user.fullName} src={myPhoto} size="sm" />
              {clinicSwitcher("hidden lg:inline")}
            </div>

            {me.permissions["appointments.read"] !== "none" && (
              <NotificationBell />
            )}

            <div className="hidden items-center gap-2 md:flex">
              <SupportLink />
              <LanguageToggle inline />
              <Button variant="ghost" size="sm" onClick={() => void logout()}>
                {t("shell.logout")}
              </Button>
            </div>
          </div>
        </header>

        <ConnectionBanner />

        {switchError && (
          <p
            role="alert"
            className="border-b border-border bg-danger-soft px-4 py-2 text-sm text-danger"
          >
            {t("shell.switchClinic.failed")}
          </p>
        )}

        <main className="flex-1 p-4 md:p-6">
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
            <MyDetailsPage
              authFetch={authFetch}
              membershipId={me.membershipId}
            />
          ) : path === "/audit-log" ? (
            <AuditLogPage authFetch={authFetch} />
          ) : path === "/complaints" ? (
            <ComplaintsPage authFetch={authFetch} />
          ) : path === "/reports" ? (
            <ReportsPage authFetch={authFetch} currency={me.currency} />
          ) : path === "/settings" ? (
            <ClinicSettingsPage authFetch={authFetch} />
          ) : path === "/patients" ? (
            <PatientsPage onOpen={(id) => navigate(`/patients/${id}`)} />
          ) : path === "/users" ? (
            <StaffPage
              onOpenDoctor={(doctorId) =>
                navigate(
                  doctorId === null ? "/doctors" : `/doctors/${doctorId}`,
                )
              }
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
            <DeskPage
              authFetch={authFetch}
              chargeId={deskChargeId}
              currency={me.currency}
            />
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
              onSelectTab={(next) =>
                navigate(next === "MINE" ? "/visits/patients" : "/visits")
              }
              onOpenPatient={(id) => navigate(`/visits/patients/${id}`)}
            />
          ) : visitAppointmentId !== null ? (
            <VisitDraftScreen
              authFetch={authFetch}
              appointmentId={visitAppointmentId}
              currency={me.currency}
            />
          ) : patientId !== null ? (
            <PatientDetailPage
              patientId={patientId}
              onBack={() => navigate("/patients")}
            />
          ) : (
            <div className="mx-auto max-w-2xl rounded-xl border border-border bg-surface p-8 text-center">
              <h1 className="text-lg font-semibold">
                {t("shell.placeholder.title")}
              </h1>
              <p className="mt-2 text-sm text-ink-muted">
                {t("shell.placeholder.body")}
              </p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
