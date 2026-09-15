import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LocaleProvider } from "../../i18n/locale-context.tsx";
import { ConsultationsPage } from "./ConsultationsPage.tsx";

/**
 * The «الكشوف» section, which was a "قريبًا" badge until 2026-09-09.
 *
 * The failure worth guarding is the empty one. A doctor who has started nothing yet opens this
 * screen first, and a blank panel would read as a broken page rather than as an answer — so the
 * empty state must say there is nothing open **and** point at the queue, which is the only place a
 * consultation can start.
 */

const OPEN_VISIT = {
  appointmentId: "11111111-1111-4111-8111-111111111111",
  patientId: "22222222-2222-4222-8222-222222222222",
  patientName: "مريم حسن",
  status: "IN_CONSULTATION" as const,
  visitId: null,
};

function renderPage(body: unknown, onGoToQueue = () => {}) {
  return render(
    <LocaleProvider>
      <ConsultationsPage
        authFetch={async () =>
          new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
        }
        onGoToQueue={onGoToQueue}
      />
    </LocaleProvider>,
  );
}

afterEach(cleanup);

describe("the doctor's open consultations", () => {
  test("with nothing open, says so and offers the queue", async () => {
    const onGoToQueue = vi.fn();
    renderPage([], onGoToQueue);

    await screen.findByTestId("no-open-consultations");
    screen.getByTestId("go-to-queue").click();
    expect(onGoToQueue).toHaveBeenCalledTimes(1);
  });

  test("a single open consultation is listed, not collapsed away", async () => {
    // The tab strip hides itself below two, because beside the visit you are already on one tab is
    // not a choice. Here it is the whole content, and hiding it would produce the empty state for
    // a doctor who has a patient in the room.
    renderPage([OPEN_VISIT]);

    await waitFor(() => expect(screen.queryByText("مريم حسن")).not.toBeNull());
    expect(screen.queryByTestId("no-open-consultations")).toBeNull();
  });

  test("the empty state waits for the answer rather than flashing first", async () => {
    // Null is "not asked yet"; [] is "asked, and there are none". Collapsing them shows "you have
    // no patients" on every visit to the screen for as long as the request takes.
    render(
      <LocaleProvider>
        <ConsultationsPage authFetch={() => new Promise(() => {})} onGoToQueue={() => {}} />
      </LocaleProvider>,
    );
    expect(screen.queryByTestId("no-open-consultations")).toBeNull();
  });

  /** R-B: the doctor's section gained a second tab, and the strip is the only way between them. */
  test("the «مرضاي» tab is offered, and selecting it is the caller's navigation", async () => {
    const onSelectTab = vi.fn();
    render(
      <LocaleProvider>
        <ConsultationsPage
          authFetch={async () =>
            new Response("[]", { headers: { "content-type": "application/json" } })
          }
          onGoToQueue={() => {}}
          onSelectTab={onSelectTab}
        />
      </LocaleProvider>,
    );

    const mine = await screen.findByTestId("visits-tab-MINE");
    expect(screen.getByTestId("visits-tab-OPEN").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(mine);
    expect(onSelectTab).toHaveBeenCalledWith("MINE");
  });

  test("on the «مرضاي» tab the open-consultations list is not rendered at all", async () => {
    render(
      <LocaleProvider>
        <ConsultationsPage
          authFetch={async () =>
            new Response(JSON.stringify({ patients: [], total: 0 }), {
              headers: { "content-type": "application/json" },
            })
          }
          onGoToQueue={() => {}}
          tab="MINE"
        />
      </LocaleProvider>,
    );

    await screen.findByTestId("my-patients");
    expect(screen.queryByTestId("no-open-consultations")).toBeNull();
  });
});
