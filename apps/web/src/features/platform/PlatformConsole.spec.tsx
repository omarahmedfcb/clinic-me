import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LocaleProvider } from "../../i18n/locale-context.tsx";
import { PlatformConsole } from "./PlatformConsole.tsx";

/**
 * «لوحة المشغّل» — pilot-readiness 0b–0f, and the back office of 2026-09-15.
 *
 * The wall is the server's, and `platform-isolation.integration.spec.ts` holds it. What this screen
 * owes: it must not render a confident empty list out of a failed read, it must show a one-time
 * password exactly once, it must offer a reset only for somebody the server would accept, and —
 * since the founder's report — it must render a rejected field as a sentence naming that field
 * rather than as the system-error apology.
 */

const CLINIC = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  name: "عيادة النيل",
  slug: "nile-family-clinic",
  country: "EG",
  currency: "EGP",
  timezone: "Africa/Cairo",
  status: "ACTIVE",
  suspensionReason: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActivity: "2026-09-10T09:00:00.000Z",
  patients: 214,
  doctors: 3,
  staff: 6,
  appointmentsThisMonth: 88,
  plan: { doctors: 3, monthlyMinor: 330_000, includedMessages: 2_400, setupMinor: 350_000 },
  admins: [{ userId: "aaaa1111-1111-4111-8111-111111111111", fullName: "منى سيد فهمي", role: "ADMIN" }],
  accountStatus: "ACTIVE",
  renewalOn: "2027-01-31",
  renewalInDays: 120,
  renewalDue: false,
};

const OPERATOR = {
  userId: "bbbb1111-1111-4111-8111-111111111111",
  fullName: "مشغّل المنصة",
  phoneE164: "+201000000000",
  platformRole: "OWNER",
  status: "ACTIVE",
  totpEnrolled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * Signs the operator in through **both** steps, then hands control to the caller's handler.
 *
 * The password step answers `pendingToken`, never `accessToken`: that field name is the contract
 * that the password alone opens nothing, and a harness that faked an access token here would let a
 * regression to one-step sign-in pass every test in this file.
 */
function renderConsole(
  handler: (path: string, init?: RequestInit) => Promise<Response>,
  options: { totpEnrolled?: boolean; role?: string; totpRequired?: boolean } = {},
) {
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    const url = String(path);
    if (url.endsWith("/platform/login")) {
      // `totpRequired` is the server's decision, and the harness must carry it: without it every
      // test here would exercise the OPERATOR_TOTP=off path and none would cover the second factor.
      if (options.totpRequired === false) {
        return json({ accessToken: "operator-token", fullName: "مشغّل المنصة", totpEnrolled: false, totpRequired: false });
      }
      return json({
        pendingToken: "pending-token",
        fullName: "مشغّل المنصة",
        totpEnrolled: options.totpEnrolled ?? true,
        totpRequired: true,
      });
    }
    if (url.endsWith("/platform/totp/enrol")) {
      return json({ secretBase32: "JBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/clinic-os%3A%2B20?secret=JBSWY3DPEHPK3PXP" });
    }
    if (url.endsWith("/platform/totp/verify") || url.endsWith("/platform/totp/confirm")) {
      return json({ accessToken: "operator-token", fullName: "مشغّل المنصة" });
    }
    if (url.endsWith("/platform/me")) {
      return json({ userId: OPERATOR.userId, fullName: OPERATOR.fullName, platformRole: options.role ?? "OWNER" });
    }
    if (url.endsWith("/platform/operators")) return json({ operators: [OPERATOR] });
    return handler(url, init);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(
    <LocaleProvider>
      <PlatformConsole />
    </LocaleProvider>,
  );
  return fetchMock;
}

async function signIn(): Promise<void> {
  fireEvent.change(await screen.findByTestId("operator-identifier"), { target: { value: "+201000000000" } });
  fireEvent.change(screen.getByTestId("operator-password"), { target: { value: "x" } });
  fireEvent.click(screen.getByTestId("operator-sign-in"));

  fireEvent.change(await screen.findByTestId("operator-totp"), { target: { value: "123456" } });
  fireEvent.click(screen.getByTestId("operator-verify"));
}

const fillNewClinic = (over: Record<string, string> = {}): void => {
  const values: Record<string, string> = {
    "clinic-name": "عيادة جديدة",
    "clinic-slug": "new-clinic",
    "clinic-address": "شارع",
    "clinic-phone": "01000000001",
    "admin-name": "مديرة",
    "admin-phone": "01000000002",
    ...over,
  };
  for (const [id, value] of Object.entries(values)) {
    fireEvent.change(screen.getByTestId(id), { target: { value } });
  }
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the platform console", () => {
  test("it asks the operator to sign in before anything else", async () => {
    renderConsole(async () => json({ clinics: [] }));
    expect(await screen.findByTestId("platform-login")).toBeTruthy();
    expect(screen.queryByTestId("clinic-list")).toBeNull();
  });

  /**
   * **The password alone opens nothing** — the property "2FA required for every operator" means.
   *
   * Asserted on the screen rather than on the wire: after a correct password the console must show
   * the code field, not the clinic list. A regression to one-step sign-in fails here first.
   */
  test("a correct password leads to the second factor, not to the console", async () => {
    renderConsole(async () => json({ clinics: [CLINIC] }));
    fireEvent.change(await screen.findByTestId("operator-identifier"), { target: { value: "+201000000000" } });
    fireEvent.change(screen.getByTestId("operator-password"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("operator-sign-in"));

    expect(await screen.findByTestId("operator-second-factor")).toBeTruthy();
    expect(screen.queryByTestId("clinic-list")).toBeNull();
  });

  test("an operator with no authenticator is shown a secret to enrol first", async () => {
    renderConsole(async () => json({ clinics: [CLINIC] }), { totpEnrolled: false });
    fireEvent.change(await screen.findByTestId("operator-identifier"), { target: { value: "+201000000000" } });
    fireEvent.change(screen.getByTestId("operator-password"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("operator-sign-in"));

    expect((await screen.findByTestId("totp-secret")).textContent).toBe("JBSWY3DPEHPK3PXP");
    // And the QR beside it, drawn from the same URI — one <svg>, no raster.
    const qr = screen.getByTestId("totp-qr");
    expect(qr.querySelector("svg")).not.toBeNull();
    expect(qr.innerHTML.includes("<image")).toBe(false);
  });

  /**
   * `OPERATOR_TOTP=off` — a development and review build.
   *
   * The screen does not decide this and must not: the server answers `totpRequired: false` and has
   * already issued a usable token, and the API refuses to boot with that flag when
   * `NODE_ENV=production`. What this asserts is that the console honours the answer rather than
   * showing a code prompt nobody can satisfy — which is the thing that blocked a review.
   */
  test("when the server says the second factor is off, the password alone opens the console", async () => {
    renderConsole(async () => json({ clinics: [CLINIC] }), { totpRequired: false });
    fireEvent.change(await screen.findByTestId("operator-identifier"), { target: { value: "+201000000000" } });
    fireEvent.change(screen.getByTestId("operator-password"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("operator-sign-in"));

    expect(await screen.findByTestId("clinic-list")).toBeTruthy();
    expect(screen.queryByTestId("operator-second-factor")).toBeNull();
  });

  test("the list shows size, plan and last activity", async () => {
    renderConsole(async () => json({ clinics: [CLINIC] }));
    await signIn();

    const list = await screen.findByTestId("clinic-list");
    expect(list.textContent).toContain("عيادة النيل");
    expect(list.textContent).toContain("214");
    // The plan is 1,500 + 2 × 900 = 3,300 EGP, rendered as money by the shared formatter.
    expect(list.textContent).toContain("3,300");
  });

  test("a failed read says so, and never renders an empty list of clinics", async () => {
    renderConsole(async (path) =>
      path.includes("/platform/clinics") ? json({ code: "INTERNAL", params: {} }, 500) : json({}),
    );
    await signIn();
    expect(await screen.findByTestId("platform-failed")).toBeTruthy();
    expect(screen.queryByTestId("clinic-list")).toBeNull();
  });

  /** **The clinic's own country is the phone-parsing hint** — §18b, and a column since 0b. */
  test("the country travels with the creation", async () => {
    const fetchMock = renderConsole(async (path, init) => {
      if (init?.method === "POST" && path.endsWith("/platform/clinics")) {
        return json({ tenantId: "t1", adminUserId: "u1", temporaryPassword: "Temp1234abcd" });
      }
      return json({ clinics: [CLINIC] });
    });
    await signIn();

    fireEvent.click(await screen.findByTestId("new-clinic"));
    fireEvent.change(screen.getByTestId("clinic-country"), { target: { value: "SA" } });
    fillNewClinic({
      "clinic-name": "عيادة الرياض",
      "clinic-slug": "riyadh-clinic",
      "clinic-phone": "0500000001",
      "admin-phone": "0500000002",
    });
    fireEvent.click(screen.getByTestId("create-clinic"));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([path, init]) =>
          String(path).endsWith("/platform/clinics") && (init as RequestInit | undefined)?.method === "POST",
      );
      expect(call).toBeDefined();
      // A Saudi clinic parses its own numbers as SA, not against one process-wide default.
      expect(JSON.parse((call as [string, RequestInit])[1].body as string)).toMatchObject({ country: "SA" });
    });
  });

  test("creating a clinic shows the password once, and it is dismissible", async () => {
    renderConsole(async (path, init) => {
      if (init?.method === "POST" && path.endsWith("/platform/clinics")) {
        return json({ tenantId: "t1", adminUserId: "u1", temporaryPassword: "Temp1234abcd" });
      }
      return json({ clinics: [CLINIC] });
    });
    await signIn();

    fireEvent.click(await screen.findByTestId("new-clinic"));
    fillNewClinic();
    fireEvent.click(screen.getByTestId("create-clinic"));

    const shown = await screen.findByTestId("issued-password");
    expect(shown.textContent).toBe("Temp1234abcd");

    fireEvent.click(screen.getByTestId("dismiss-password"));
    await waitFor(() => expect(screen.queryByTestId("issued-password")).toBeNull());
  });

  test("a refusal is rendered as its sentence, not swallowed", async () => {
    renderConsole(async (path, init) => {
      if (init?.method === "POST" && path.endsWith("/platform/clinics")) {
        return json({ code: "SLUG_TAKEN", params: { name: "nile-family-clinic" } }, 400);
      }
      return json({ clinics: [CLINIC] });
    });
    await signIn();

    fireEvent.click(await screen.findByTestId("new-clinic"));
    fillNewClinic({ "clinic-slug": "nile-family-clinic" });
    fireEvent.click(screen.getByTestId("create-clinic"));

    const refusal = await screen.findByTestId("platform-refusal");
    expect(refusal.textContent).toContain("nile-family-clinic");
  });

  /**
   * **The founder's 2026-09-15 report, as a screen test.**
   *
   * A DTO rejection now arrives as `INVALID_FIELD` with the field's name, and the console must
   * render the Arabic noun for that field — not the raw property name, and above all not
   * "حدث خطأ في النظام", which is what he actually read and which blames the server for a typo.
   */
  test("a rejected field is named in Arabic, never rendered as a system error", async () => {
    renderConsole(async (path, init) => {
      if (init?.method === "POST" && path.endsWith("/platform/clinics")) {
        return json({ code: "INVALID_FIELD", params: { field: "slug" }, message: ["slug must match …"] }, 400);
      }
      return json({ clinics: [CLINIC] });
    });
    await signIn();

    fireEvent.click(await screen.findByTestId("new-clinic"));
    // A slug the client itself accepts, so the request is actually sent and the server's refusal is
    // what gets rendered — the point of this test is the rendering, not the client-side hint.
    fillNewClinic({ "clinic-slug": "some-clinic" });
    fireEvent.click(screen.getByTestId("create-clinic"));

    const refusal = await screen.findByTestId("platform-refusal");
    expect(refusal.textContent).toContain("الاسم المختصر");
    expect(refusal.textContent).not.toContain("slug");
    expect(refusal.textContent).not.toContain("حدث خطأ في النظام");
  });

  /** The other half: the form says the rule before a round trip, and refuses to send. */
  test("a short name with a space is refused on the screen, before the request", async () => {
    const fetchMock = renderConsole(async () => json({ clinics: [CLINIC] }));
    await signIn();

    fireEvent.click(await screen.findByTestId("new-clinic"));
    fillNewClinic({ "clinic-slug": "nile clinic" });

    expect(screen.getByTestId("create-clinic").hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByTestId("create-clinic"));
    expect(
      fetchMock.mock.calls.some(
        ([path, init]) =>
          String(path).endsWith("/platform/clinics") && (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toBe(false);
  });

  /** **A reset is offered only for an admin the server would accept.** */
  test("there is a reset button for the admin and none for anybody else", async () => {
    renderConsole(async () => json({ clinics: [CLINIC] }));
    await signIn();
    await screen.findByTestId("clinic-list");

    expect(screen.getByTestId(`reset-${CLINIC.admins[0]?.userId ?? ""}`)).toBeTruthy();
    // One admin on the fixture, so exactly one button — a doctor is not in `admins` at all.
    expect(screen.getAllByText("كلمة مرور مؤقتة للمدير")).toHaveLength(1);
  });

  test("suspending asks for a reason and sends it", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("لم تُسدَّد الاشتراكات");
    const fetchMock = renderConsole(async (path, init) => {
      if (init?.method === "POST" && path.includes("/suspension")) return json({ status: "SUSPENDED" });
      return json({ clinics: [CLINIC] });
    });
    await signIn();

    fireEvent.click(await screen.findByTestId(`suspend-${CLINIC.tenantId}`));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([path, init]) =>
          String(path).includes("/suspension") && (init as RequestInit | undefined)?.method === "POST",
      );
      expect(call).toBeDefined();
      const body = JSON.parse((call as [string, RequestInit])[1].body as string) as Record<string, unknown>;
      expect(body).toMatchObject({ suspended: true, reason: "لم تُسدَّد الاشتراكات" });
    });
  });

  test("a cancelled reason sends nothing at all", async () => {
    vi.spyOn(window, "prompt").mockReturnValue(null);
    const fetchMock = renderConsole(async () => json({ clinics: [CLINIC] }));
    await signIn();

    fireEvent.click(await screen.findByTestId(`suspend-${CLINIC.tenantId}`));
    await waitFor(() => expect(screen.getByTestId("clinic-list")).toBeTruthy());
    expect(
      fetchMock.mock.calls.some(([path, init]) =>
        String(path).includes("/suspension") && (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toBe(false);
  });

  /** 2c — the fourteen-day warning, decided by the server and only rendered here. */
  describe("the renewal reminder", () => {
    test("a clinic inside the window is flagged", async () => {
      renderConsole(async () =>
        json({ clinics: [{ ...CLINIC, accountStatus: "OVERDUE", renewalInDays: 7, renewalDue: true }] }),
      );
      await signIn();

      const flag = await screen.findByTestId(`renewal-due-${CLINIC.tenantId}`);
      expect(flag.textContent).toContain("التجديد قريب");
      expect((await screen.findByTestId("clinic-list")).textContent).toContain("متأخر السداد");
    });

    test("and one outside it is not", async () => {
      renderConsole(async () => json({ clinics: [CLINIC] }));
      await signIn();
      await screen.findByTestId("clinic-list");
      expect(screen.queryByTestId(`renewal-due-${CLINIC.tenantId}`)).toBeNull();
    });
  });

  /** 2a — the console shows the OWNER's controls only to an OWNER. */
  describe("the operators tab", () => {
    test("an OWNER can seat somebody", async () => {
      renderConsole(async () => json({ clinics: [CLINIC] }), { role: "OWNER" });
      await signIn();
      fireEvent.click(await screen.findByTestId("tab-operators"));

      expect(await screen.findByTestId("seat-operator")).toBeTruthy();
      expect((await screen.findByTestId("operator-list")).textContent).toContain("مشغّل المنصة");
    });

    test("a SUPPORT operator is offered no seating control at all", async () => {
      // Not a disabled button: a control that is always refused teaches somebody to click it and
      // read a refusal, which is the same mistake as offering a reset for a doctor's account.
      renderConsole(async () => json({ clinics: [CLINIC] }), { role: "SUPPORT" });
      await signIn();
      fireEvent.click(await screen.findByTestId("tab-operators"));

      await screen.findByTestId("operator-list");
      expect(screen.queryByTestId("seat-operator")).toBeNull();
      expect(screen.queryByTestId(`reset-totp-${OPERATOR.userId}`)).toBeNull();
    });
  });
});
