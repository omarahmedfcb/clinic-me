import { useCallback, useEffect, useState } from "react";
import { useSession } from "../auth/session.tsx";
import { isDoctorRole, ownDoctorId } from "../auth/own-doctor.ts";
import { loadDoctors, type DoctorSummary } from "../schedules/schedules-api.ts";
import { loadDay, type DayDescription } from "./day-view-api.ts";
import { today } from "./day-dates.ts";

export function useDayView() {
  const { authFetch, me } = useSession();

  const [doctors, setDoctors] = useState<DoctorSummary[] | null>(null);
  const [doctorId, setDoctorId] = useState<string | null>(null);
  const [date, setDate] = useState(today());
  const [day, setDay] = useState<DayDescription | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  /** Which appointment's detail panel is open. Null closes it. */
  const [openId, setOpenId] = useState<string | null>(null);

  const selected = (doctors ?? []).find((d) => d.id === doctorId) ?? null;
  const ownDoctorLabel =
    selected === null
      ? null
      : `${selected.title} ${selected.fullName} — ${selected.specialty}`;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await loadDoctors(authFetch);
        if (cancelled) return;
        setDoctors(list);
        // A doctor is pinned to themselves; only reception/admin/owner default to "the first
        // doctor in the list". Falling back to list[0] for a doctor is exactly the bug this fixes.
        const pinned = isDoctorRole(me) ? ownDoctorId(me, list) : null;
        setDoctorId((current) =>
          isDoctorRole(me) ? pinned : (current ?? list[0]?.id ?? null),
        );
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authFetch]);

  const refresh = useCallback(
    async (id: string, on: string): Promise<void> => {
      setLoading(true);
      setFailed(false);
      try {
        setDay(await loadDay(authFetch, id, on));
      } catch {
        // A 404 here is the `own` rule for a doctor looking at a colleague, not a fault.
        setDay(null);
        setFailed(true);
      } finally {
        setLoading(false);
      }
    },
    [authFetch],
  );

  useEffect(() => {
    if (doctorId === null) return;
    void refresh(doctorId, date);
  }, [doctorId, date, refresh]);

  return {
    me,
    doctors,
    doctorId,
    setDoctorId,
    date,
    setDate,
    day,
    loading,
    failed,
    openId,
    setOpenId,
    ownDoctorLabel,
    refresh,
  };
}
