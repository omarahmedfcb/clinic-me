import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LocaleProvider } from "../../i18n/locale-context.tsx";

/**
 * A search that finds nothing offers to register the patient — PR 7a's third guard.
 *
 * The gap it closes: `POST /patients` existed and nothing in the client called it, so a walk-in
 * whose name was not already recorded could not be booked at all. The dialog showed an empty list
 * and no way forward, which is the same shape as the visit screen shipping with no entry point.
 *
 * Also asserts the offer is absent before a search has run. An untouched dialog inviting you to
 * register someone nobody has looked for would produce duplicates, which is what the search exists
 * to prevent.
 */

vi.mock("../auth/session.tsx", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../auth/session.tsx");
  return { ...actual, useSession: () => ({ me: { permissions: {} }, authFetch: async () => new Response("[]") }) };
});


const { BookAppointmentDialog } = await import("./BookAppointmentDialog.tsx");

function renderDialog() {
  return render(
    <LocaleProvider>
      <BookAppointmentDialog
        open
        onOpenChange={() => {}}
        doctors={[{ id: "d1", fullName: "هشام محمود الديب", isActive: true } as never]}
        pinnedDoctorId={null}
        busy={false}
        // Every call answers with an empty array: no services, no slots, and crucially no patients.
        authFetch={async () => new Response("[]", { headers: { "content-type": "application/json" } })}
        onBook={() => {}}
      />
    </LocaleProvider>,
  );
}

const intakeButton = () => screen.queryByRole("button", { name: /مريض جديد|New patient/ });

afterEach(cleanup);

describe("booking with no matching patient", () => {
  test("offers to register one", async () => {
    renderDialog();

    fireEvent.change(screen.getByLabelText(/المريض|Patient/), {
      target: { value: "اسم غير مسجل" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^بحث$|^Search$/ }));

    await waitFor(() => expect(intakeButton()).not.toBeNull());
  });

  test("offers before a search has run too, since Q41", () => {
    // This asserted the opposite until 2026-09-09, and the reasoning it carried was real: an
    // untouched dialog inviting you to register someone nobody has looked for produces duplicates.
    //
    // The founder's ruling overrides it on a fact the old placement ignored — a receptionist with a
    // walk-in in front of them already knows the patient is new, and making them search for someone
    // they know is absent, in order to be shown the button, is a step that existed only because the
    // button lived inside the empty state.
    renderDialog();
    expect(intakeButton()).not.toBeNull();
  });

  test("the search still comes first, which is what keeps duplicates down", () => {
    // The duplicate risk did not go away; what changed is what mitigates it. The search box and its
    // button are both before the intake button in DOM order, so the cheap thing is still the first
    // thing — and the intake dialog itself refuses a second patient on a known household phone (D28).
    renderDialog();
    const search = screen.getByRole("button", { name: /^بحث$|^Search$/ });
    const intake = intakeButton();
    expect(intake).not.toBeNull();
    expect(search.compareDocumentPosition(intake as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});

