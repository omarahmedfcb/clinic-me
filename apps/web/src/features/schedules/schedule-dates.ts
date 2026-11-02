// Calendar-date arithmetic for the schedule screen, on YYYY-MM-DD strings at UTC noon.
// Shared by SchedulesPage and use-schedule-editor.

export const today = (): string => new Date().toISOString().slice(0, 10);

/** Saturday of the week containing `date` — the Egyptian week starts there. */
export function weekStartOf(date: string): string {
  const at = new Date(`${date}T12:00:00Z`);
  const shift = (at.getUTCDay() + 1) % 7; // Saturday = 6 -> 0
  at.setUTCDate(at.getUTCDate() - shift);
  return at.toISOString().slice(0, 10);
}

export const addDays = (date: string, days: number): string => {
  const at = new Date(`${date}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
};
