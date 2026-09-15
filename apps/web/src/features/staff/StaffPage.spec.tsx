import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LocaleProvider } from "../../i18n/locale-context.tsx";
import { SessionProvider, type CurrentUser } from "../auth/session.tsx";
import { StaffPage } from "./StaffPage.tsx";

/**
 * «المستخدمون» — Phase 5 PR 10.
 *
 * The screen's own rules, and the one that matters most: **the temporary password is shown once**,
 * in a dialog, and nothing on this screen can produce it again. The server guarantees that half
 * (`staff-accounts.integration.spec.ts`); this is about the screen not implying otherwise.
 */

const ME: CurrentUser = {
  user: { id: "u1", fullName: "أمينة", phoneE164: "+201000000000", email: null, locale: null },
  membershipId: "m1",
  tenantId: "t1",
  currency: "EGP",
  role: "ADMIN",
  memberships: [],
  permissions: { "users.manage": "full" },
};

const RECEPTIONIST = {
  membershipId: "m2",
  userId: "u2",
  fullName: "منى سعيد",
  phoneE164: "+201111111111",
  role: "RECEPTIONIST",
  status: "ACTIVE",
  lastLoginAt: "2026-09-10T08:00:00.000Z",
  mustChangePassword: false,
  editableHere: true,
  doctorId: null,
  hasPhoto: false,
};

const DOCTOR = {
  membershipId: "m3",
  userId: "u3",
  fullName: "د. هشام",
  phoneE164: "+201222222222",
  role: "DOCTOR",
  status: "ACTIVE",
  lastLoginAt: null,
  mustChangePassword: false,
  editableHere: false,
  doctorId: "d1",
  hasPhoto: false,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage(
  handler: (path: string, init?: RequestInit) => Promise<Response>,
  onOpenDoctor = vi.fn(),
) {
  const fetchMock = vi.fn(handler);
  vi.stubGlobal("fetch", fetchMock);
  render(
    <LocaleProvider>
      <SessionProvider initialToken="token" initialMe={ME} onSignedOut={() => {}}>
        <StaffPage onOpenDoctor={onOpenDoctor} />
      </SessionProvider>
    </LocaleProvider>,
  );
  return { fetchMock, onOpenDoctor };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the staff list", () => {
  test("shows who has an account, with the facts the ruling names", async () => {
    renderPage(async () => json([RECEPTIONIST, DOCTOR]));
    await screen.findByTestId("staff-page");
    expect(screen.getByText("منى سعيد")).toBeTruthy();
    expect(screen.getByText("+201111111111")).toBeTruthy();
    // Never signed in is a fact, and reads as one rather than as a blank cell.
    expect(screen.getByTestId("staff-page").textContent).toContain("لم يدخل بعد");
  });

  test("a doctor is listed and linked, never edited here", async () => {
    const { onOpenDoctor } = renderPage(async () => json([RECEPTIONIST, DOCTOR]));
    await screen.findByTestId("staff-page");

    // No suspend and no reset on a doctor's row: that record belongs to the Doctors tab, and a
    // second place to edit it is a second place for its rules to be forgotten.
    expect(screen.queryByTestId("reset-m3")).toBeNull();
    expect(screen.queryByTestId("status-m3")).toBeNull();

    // The row still carries "تعديل" — it goes to the Doctors tab, carrying *that doctor*, so the
    // drawer opens on them rather than on a list the reader has to search again.
    fireEvent.click(screen.getByTestId("edit-m3"));
    expect(onOpenDoctor).toHaveBeenCalledWith(DOCTOR.doctorId);
  });

  /**
   * **Two users, two photos; and initials for somebody who has none.**
   *
   * The founder's finding: one uploaded photo appeared on every account. The API was proven correct
   * first — only the one membership returned bytes and every other 404'd — so what this pins down is
   * the screen: each row resolves its own person, and nobody borrows a neighbour's face.
   */
  test("each row shows its own photo, and a user with none shows initials", async () => {
    const second = { ...RECEPTIONIST, membershipId: "m4", userId: "u4", fullName: "ياسمين الشربيني", hasPhoto: true };
    const withPhoto = { ...RECEPTIONIST, hasPhoto: true };

    const seen: string[] = [];
    renderPage(async (path) => {
      const url = String(path);
      const photo = /\/api\/staff\/([^/]+)\/photo$/.exec(url);
      if (photo !== null) {
        const membershipId = photo[1] as string;
        seen.push(membershipId);
        // Distinct bytes per person, so a shared object URL cannot pass for a correct one.
        return new Response(`photo-of-${membershipId}`, { status: 200, headers: { "content-type": "image/png" } });
      }
      return json([withPhoto, second, DOCTOR]);
    });
    await screen.findByTestId("staff-page");

    // Exactly the two who have one are asked for, and each is asked for its own.
    await waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(2));
    expect(new Set(seen)).toEqual(new Set(["m2", "m4"]));
    expect(seen).not.toContain("m3");

    const images = screen.getAllByRole("img");
    expect(images).toHaveLength(2);
    // Two different sources: the bug was every avatar pointing at one blob.
    expect(new Set(images.map((image) => image.getAttribute("src"))).size).toBe(2);

    // And the doctor, who has none, draws initials rather than borrowing somebody's face.
    expect(screen.getAllByTestId("avatar-initials")).toHaveLength(1);
  });

  test("editing sends only what changed, as a PATCH", async () => {
    const { fetchMock } = renderPage(async (_path, init) => {
      if (init?.method === "PATCH") return json({ ...RECEPTIONIST, fullName: "منى سعيد علي" });
      return json([RECEPTIONIST, DOCTOR]);
    });
    await screen.findByTestId("staff-page");

    fireEvent.click(screen.getByTestId("edit-m2"));
    const name = await screen.findByTestId("edit-staff-name");
    // The dialog opens on what is stored, so an edit is a correction rather than a re-entry.
    expect((name as HTMLInputElement).value).toBe("منى سعيد");

    fireEvent.change(name, { target: { value: "منى سعيد علي" } });
    fireEvent.click(screen.getByTestId("edit-staff-save"));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
      expect(patch).toBeDefined();
      expect(String((patch as [string, RequestInit])[0])).toContain("/api/staff/m2");
      // The untouched phone and role are absent: only the field that changed is sent.
      expect(JSON.parse((patch as [string, RequestInit])[1].body as string)).toEqual({
        fullName: "منى سعيد علي",
      });
    });
  });

  /**
   * **The bug that demoted the owner of the pilot clinic**, 2026-09-13.
   *
   * `openEdit` read `member.role === "ADMIN" ? "ADMIN" : "RECEPTIONIST"`, so an OWNER row opened on
   * RECEPTIONIST — and the save sent the role because it differed. Editing his name or his photo
   * demoted him, and `audit_logs` recorded it under his own name.
   */
  test("editing an owner sends no role, and shows the role rather than offering it", async () => {
    const owner = { ...RECEPTIONIST, membershipId: "m9", userId: "u9", fullName: "أحمد الشناوي", role: "OWNER" };
    const { fetchMock } = renderPage(async (_path, init) => {
      if (init?.method === "PATCH") return json({ ...owner, fullName: "أحمد عبد الرحمن الشناوي" });
      return json([owner, DOCTOR]);
    });
    await screen.findByTestId("staff-page");

    fireEvent.click(screen.getByTestId("edit-m9"));
    // Shown, not offered: there is no select to default to the wrong value.
    expect(await screen.findByTestId("edit-staff-role-fixed")).toBeTruthy();
    expect(screen.queryByTestId("edit-staff-role")).toBeNull();

    fireEvent.change(screen.getByTestId("edit-staff-name"), { target: { value: "أحمد عبد الرحمن الشناوي" } });
    fireEvent.click(screen.getByTestId("edit-staff-save"));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
      expect(patch).toBeDefined();
      const body = JSON.parse((patch as [string, RequestInit])[1].body as string) as Record<string, unknown>;
      // The name, and nothing else. A `role` on this request is the demotion.
      expect(body).toEqual({ fullName: "أحمد عبد الرحمن الشناوي" });
    });
  });

  test("a duplicate phone is refused as a sentence, never as a code", async () => {
    renderPage(async (_path, init) => {
      if (init?.method === "PATCH") return json({ code: "DUPLICATE_PHONE", params: {} }, 409);
      return json([RECEPTIONIST, DOCTOR]);
    });
    await screen.findByTestId("staff-page");

    fireEvent.click(screen.getByTestId("edit-m2"));
    fireEvent.change(await screen.findByTestId("edit-staff-phone"), { target: { value: "+201222222222" } });
    fireEvent.click(screen.getByTestId("edit-staff-save"));

    const alert = await screen.findByTestId("staff-failure");
    expect(alert.textContent).not.toContain("DUPLICATE_PHONE");
    expect(alert.textContent?.length ?? 0).toBeGreaterThan(5);
  });

  test("suspending says suspend, never delete", async () => {
    const { fetchMock } = renderPage(async (path, init) => {
      if (init?.method === "POST" && path.includes("/status")) {
        return json({ ...RECEPTIONIST, status: "SUSPENDED" });
      }
      return json([RECEPTIONIST, DOCTOR]);
    });
    await screen.findByTestId("status-m2");
    fireEvent.click(screen.getByTestId("status-m2"));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([path, init]) => String(path).includes("/status") && (init as RequestInit | undefined)?.method === "POST",
      );
      expect(post).toBeDefined();
      const body = JSON.parse((post as [string, RequestInit])[1].body as string) as Record<string, unknown>;
      expect(body).toEqual({ status: "SUSPENDED" });
    });
    // There is no delete anywhere on this screen, which is the ruling rather than an omission.
    expect(screen.getByTestId("staff-page").textContent).not.toContain("حذف");
  });

  test("a reset shows the temporary password once, and says so", async () => {
    renderPage(async (path, init) => {
      if (init?.method === "POST" && path.includes("/password")) {
        return json({ temporaryPassword: "Kd7mRq2xTb9P" });
      }
      return json([RECEPTIONIST, DOCTOR]);
    });
    fireEvent.click(await screen.findByTestId("reset-m2"));

    const shown = await screen.findByTestId("shown-password");
    expect(shown.textContent).toBe("Kd7mRq2xTb9P");
    // The copy has to say it cannot be shown again, or an admin will close the dialog expecting to
    // find it later — which is the one thing this design makes impossible.
    expect(screen.getByText(/مرة واحدة فقط|Shown once/)).toBeTruthy();

    fireEvent.click(screen.getByTestId("dismiss-password"));
    await waitFor(() => expect(screen.queryByTestId("shown-password")).toBeNull());
  });

  test("creating a user sends the three fields and shows the password once", async () => {
    const { fetchMock } = renderPage(async (path, init) => {
      if (init?.method === "POST" && String(path).endsWith("/api/staff")) {
        return json({ member: { ...RECEPTIONIST, fullName: "سارة" }, temporaryPassword: "Ab3dEf6hJk9m" }, 201);
      }
      return json([RECEPTIONIST]);
    });
    fireEvent.click(await screen.findByTestId("create-staff"));

    fireEvent.change(screen.getByTestId("staff-name"), { target: { value: "سارة" } });
    fireEvent.change(screen.getByTestId("staff-phone"), { target: { value: "01001234567" } });
    fireEvent.change(screen.getByTestId("staff-role"), { target: { value: "ADMIN" } });
    fireEvent.click(screen.getByTestId("create-staff-save"));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([path, init]) => String(path).endsWith("/api/staff") && (init as RequestInit | undefined)?.method === "POST",
      );
      expect(post).toBeDefined();
      const body = JSON.parse((post as [string, RequestInit])[1].body as string) as Record<string, unknown>;
      expect(body).toEqual({ fullName: "سارة", phone: "01001234567", role: "ADMIN" });
    });
    expect((await screen.findByTestId("shown-password")).textContent).toBe("Ab3dEf6hJk9m");
  });

  test("a refusal is rendered as a sentence, never as a code", async () => {
    renderPage(async (path, init) => {
      if (init?.method === "POST" && String(path).endsWith("/api/staff")) {
        return json({ code: "ALREADY_A_MEMBER", params: { name: "سارة" } }, 409);
      }
      return json([RECEPTIONIST]);
    });
    fireEvent.click(await screen.findByTestId("create-staff"));
    fireEvent.change(screen.getByTestId("staff-name"), { target: { value: "سارة" } });
    fireEvent.change(screen.getByTestId("staff-phone"), { target: { value: "01001234567" } });
    fireEvent.click(screen.getByTestId("create-staff-save"));

    const alert = await screen.findByTestId("staff-failure");
    expect(alert.textContent).not.toContain("ALREADY_A_MEMBER");
    expect(alert.textContent?.length ?? 0).toBeGreaterThan(10);
  });
});
