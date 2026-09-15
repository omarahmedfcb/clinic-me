import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocaleProvider } from "../../i18n/locale-context.tsx";
import { ClinicSettingsPage } from "./ClinicSettingsPage.tsx";

/**
 * The screen PR 7f shipped without — Q36.
 *
 * The assertion that carries this file is the last one: **"remove" sends a DELETE and does not claim
 * to delete the file.** `StorageProvider` has no `delete()` by design, so the row's pointer is what
 * is cleared, and a screen that said otherwise would be promising something the system deliberately
 * cannot do.
 */

const IDENTITY = {
  name: "عيادة النيل",
  address: "١٢ شارع الجمهورية، القاهرة",
  phone: "+201001234567",
  secondaryPhone: "16123",
  hasLogo: true,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderPage(identity: typeof IDENTITY = IDENTITY) {
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:stub");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  const authFetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith("/logo") && init?.method === undefined) {
      return new Response(new Blob([new Uint8Array([0x89, 0x50])]), { status: 200 });
    }
    if (path.endsWith("/logo")) return jsonResponse({ removed: true });
    if (init?.method === "PUT") {
      return jsonResponse({ ...identity, ...(JSON.parse(String(init.body)) as object) });
    }
    return jsonResponse(identity);
  });
  render(
    <LocaleProvider>
      <ClinicSettingsPage authFetch={authFetch} />
    </LocaleProvider>,
  );
  return authFetch;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the clinic settings screen", () => {
  test("shows the stored letterhead, including a hotline kept as typed", async () => {
    renderPage();
    expect(await screen.findByDisplayValue("عيادة النيل")).toBeTruthy();
    // The API decides the phone's shape; whatever it returns is what lands back in the box.
    expect(screen.getByDisplayValue("+201001234567")).toBeTruthy();
    expect(screen.getByDisplayValue("16123")).toBeTruthy();
  });

  test("an empty second number clears it rather than leaving the stored one alone", async () => {
    const authFetch = renderPage();
    const field = await screen.findByDisplayValue("16123");
    await userEvent.clear(field);
    await userEvent.click(screen.getByTestId("save-clinic"));

    await waitFor(() => {
      const put = authFetch.mock.calls.find(([, init]) => init?.method === "PUT");
      // `null`, not `""`: the API reads an absent key as "leave alone", so an empty string would be
      // stored as an empty phone rather than as no phone.
      expect(JSON.parse(String(put?.[1]?.body)).secondaryPhone).toBeNull();
    });
  });

  test("a stored logo previews, and remove sends a DELETE without claiming the file is gone", async () => {
    const authFetch = renderPage();
    expect(await screen.findByTestId("clinic-logo-preview")).toBeTruthy();

    await userEvent.click(screen.getByTestId("clinic-logo-remove"));
    await waitFor(() => {
      const deleted = authFetch.mock.calls.find(([, init]) => init?.method === "DELETE");
      expect(deleted?.[0]).toBe("/api/clinic-identity/logo");
    });
    // Said on the screen, because "remove" ordinarily means destroyed and here it does not.
    expect(screen.getByText(/لا تحذف الملف المحفوظ/)).toBeTruthy();
  });

  test("with no logo stored there is nothing to preview and nothing to remove", async () => {
    renderPage({ ...IDENTITY, hasLogo: false });
    await screen.findByDisplayValue("عيادة النيل");
    expect(screen.queryByTestId("clinic-logo-preview")).toBeNull();
    expect(screen.queryByTestId("clinic-logo-remove")).toBeNull();
    expect(screen.getByText("لا توجد صورة محفوظة")).toBeTruthy();
  });
});
