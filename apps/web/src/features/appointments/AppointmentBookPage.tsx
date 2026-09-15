// «المواعيد» — the appointment book. Phase 5 PR 13, amended after review.
// A month of counts; a day opens a drawer laid out by the hour, where a booking is made or moved.

import { useCallback, useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Card } from "../../design-system/display.tsx";
import { Select } from "../../design-system/fields.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import { useSession } from "../auth/session.tsx";
import { isDoctorRole } from "../auth/own-doctor.ts";
import { DayDrawer } from "./DayDrawer.tsx";
import { MonthGrid } from "./MonthGrid.tsx";
import { SlotDialog } from "./SlotDialog.tsx";
import { loadDay, loadMonth, type DayBooking, type MonthBook } from "./book-api.ts";

/** `YYYY-MM` for the month containing an instant, in the reader's own clock. */
function monthOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(month: string, by: number): string {
  const [year, index] = month.split("-").map(Number) as [number, number];
  const shifted = new Date(Date.UTC(year, index - 1 + by, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The dialog carries its own date rather than reading the selected day.
 *
 * Opening it over the drawer makes the drawer's dismissable layer report a close, and a dialog
 * whose existence depended on the selection then unmounted itself the moment it opened.
 */
type Dialog =
  | { kind: "move"; date: string; booking: DayBooking }
  | { kind: "new"; date: string; prefer?: { doctorId: string; fromIso: string } };

export function AppointmentBookPage({ today = new Date() }: { today?: Date } = {}) {
  const { t } = useLocale();
  const { authFetch, me } = useSession();

  // The month this opens on takes its reference instant as a parameter rather than reading the
  // clock, which is the rule CLAUDE.md states for anything whose output is checked against an
  // expectation — here it is what lets the screen be tested on a fixed month.
  const [month, setMonth] = useState(() => monthOf(today));
  const [doctorId, setDoctorId] = useState("");
  const [book, setBook] = useState<MonthBook | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [bookings, setBookings] = useState<DayBooking[]>([]);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [failed, setFailed] = useState(false);

  // A doctor account *is* one doctor: `own-doctor.ts` states why offering it a list of colleagues
  // contradicts the `own` level the rest of the system is built on. The server pins the read either
  // way — `own-doctor-scoping.integration.spec.ts` proves a colleague's id is 404 here.
  const pinned = isDoctorRole(me);

  const refreshMonth = useCallback(async () => {
    try {
      setBook(await loadMonth(authFetch, month, doctorId === "" ? undefined : doctorId));
      setFailed(false);
    } catch {
      setBook(null);
      setFailed(true);
    }
  }, [authFetch, month, doctorId]);

  useEffect(() => {
    void refreshMonth();
  }, [refreshMonth]);

  const refreshDay = useCallback(async () => {
    if (selected === null) {
      setBookings([]);
      return;
    }
    try {
      setBookings(await loadDay(authFetch, selected, doctorId));
    } catch {
      setBookings([]);
      setFailed(true);
    }
  }, [authFetch, selected, doctorId]);

  useEffect(() => {
    void refreshDay();
  }, [refreshDay]);

  const readOnly = book?.readOnly !== false;

  return (
    <main className="mx-auto max-w-5xl" data-testid="appointment-book">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-ink">{t("book.title")}</h1>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" data-testid="prev-month" onClick={() => setMonth(shiftMonth(month, -1))}>
            {t("book.previous")}
          </Button>
          <span className="numeric text-sm text-ink" data-testid="current-month">
            {month}
          </span>
          <Button size="sm" variant="ghost" data-testid="next-month" onClick={() => setMonth(shiftMonth(month, 1))}>
            {t("book.next")}
          </Button>
        </div>
      </div>

      {/* One doctor or all of them — reception and admin only. A doctor has no picker at all. */}
      {!pinned && (
        <div className="mb-3 max-w-xs">
          <Select
            label={t("book.doctor")}
            value={doctorId}
            placeholder={t("book.allDoctors")}
            options={(book?.doctors ?? []).map((doctor) => ({ value: doctor.id, label: doctor.name }))}
            data-testid="doctor-filter"
            onChange={(event) => setDoctorId(event.target.value)}
          />
        </div>
      )}

      {failed && (
        // Never "nothing is booked": what is known is that the server refused to say, and a month
        // of empty squares is the one sentence this screen must not put in front of reception.
        <p role="alert" className="mb-3 text-sm text-danger" data-testid="book-failed">
          {t("book.loadFailed")}
        </p>
      )}

      <Card>
        <MonthGrid
          month={month}
          days={book?.days ?? []}
          selected={selected}
          onSelect={(date) => setSelected(date)}
        />
      </Card>

      {selected !== null && (
        <DayDrawer
          authFetch={authFetch}
          date={selected}
          bookings={bookings}
          doctors={book?.doctors ?? []}
          doctorId={doctorId}
          readOnly={readOnly}
          now={today}
          onClose={() => {
            // The dialog opening is reported here as a close. The day stays open behind it.
            if (dialog === null) setSelected(null);
          }}
          onNew={(prefer) =>
            setDialog(
              prefer === undefined
                ? { kind: "new", date: selected }
                : { kind: "new", date: selected, prefer },
            )
          }
          onMove={(booking) => setDialog({ kind: "move", date: selected, booking })}
        />
      )}

      {dialog !== null && (
        <SlotDialog
          authFetch={authFetch}
          date={dialog.date}
          doctors={book?.doctors ?? []}
          moving={dialog.kind === "move" ? dialog.booking : null}
          {...(dialog.kind === "new" && dialog.prefer !== undefined ? { prefer: dialog.prefer } : {})}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void refreshDay();
            void refreshMonth();
          }}
        />
      )}
    </main>
  );
}
