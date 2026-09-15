import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LocaleProvider } from "../../i18n/locale-context.tsx";
import { CompleteIntakeCard } from "./CompleteIntakeCard.tsx";

/**
 * «ملف ناقص» on the visit screen — the founder's review of #99.
 *
 * The doctor has the patient in front of them, so they may supply date of birth, sex and phone.
 * **Nothing else on the record is reachable here**, which is the assertion that matters: the rest
 * of the file is reception's, and a consultation is not the place to correct an address.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderCard(missing: string[] | undefined, onSaved = vi.fn()) {
  const authFetch = vi.fn(async () => json({ ok: true }));
  render(
    <LocaleProvider>
      <CompleteIntakeCard
        authFetch={authFetch}
        patientId="p1"
        missing={missing}
        dateOfBirth={null}
        gender={null}
        phoneE164="+201000000000"
        onSaved={onSaved}
      />
    </LocaleProvider>,
  );
  return { authFetch, onSaved };
}

afterEach(cleanup);

describe("completing a patient file from the visit screen", () => {
  test("a complete file offers nothing at all", () => {
    renderCard([]);
    expect(screen.queryByTestId("complete-intake")).toBeNull();
  });

  test("a payload with no such field does not take the screen down with it", () => {
    // A built client meeting an older API: the header must still render, because it carries the
    // allergy alert. The lesson `CoverageBadge` already records, applied to a new field.
    renderCard(undefined);
    expect(screen.queryByTestId("complete-intake")).toBeNull();
  });

  test("only the missing fields are offered, and only the three the doctor may fix", () => {
    // `nationality` and `fullNameAr` are intake fields too, and are deliberately absent: they are
    // reception's, and offering them here would make a consultation into data entry.
    renderCard(["dateOfBirth", "nationality", "fullNameAr"]);
    fireEvent.click(screen.getByTestId("complete-intake-open"));

    expect(screen.getByLabelText(/اليوم|Day/)).toBeTruthy();
    expect(screen.queryByTestId("intake-gender")).toBeNull();
    expect(screen.queryByTestId("intake-phone")).toBeNull();
    expect(screen.queryByLabelText(/الجنسية|Nationality/)).toBeNull();
    expect(screen.queryByLabelText(/العنوان|Address/)).toBeNull();
  });

  test("saving sends only those fields, through the endpoint reception already uses", async () => {
    const { authFetch, onSaved } = renderCard(["gender", "phoneE164"]);
    fireEvent.click(screen.getByTestId("complete-intake-open"));

    fireEvent.change(screen.getByTestId("intake-gender"), { target: { value: "FEMALE" } });
    fireEvent.change(screen.getByTestId("intake-phone"), { target: { value: "+201111111111" } });
    fireEvent.click(screen.getByTestId("complete-intake-save"));

    await waitFor(() => {
      const call = authFetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(call[0]).toBe("/api/patients/p1");
      expect(call[1].method).toBe("PATCH");
      const body = JSON.parse(call[1].body as string) as Record<string, unknown>;
      // Exactly these keys. A patch carrying anything else would be this screen editing a record
      // the doctor was never given.
      expect(Object.keys(body).sort()).toEqual(["gender", "phoneE164"]);
      expect(body).toEqual({ gender: "FEMALE", phoneE164: "+201111111111" });
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});
