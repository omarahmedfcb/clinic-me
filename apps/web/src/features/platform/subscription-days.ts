// Day arithmetic for the subscription range, on `YYYY-MM-DD` strings so no timezone can shift a date.
// The server is the authority (api: subscription-dates.ts); this only lets the form say so first.

/** Today's date on the operator's own clock, as `YYYY-MM-DD`. */
export function todayIso(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Whether a start/end pair is acceptable on its face: both set, neither before today, end not before start. */
export function rangeIsAcceptable(startsOn: string, endsOn: string, today: string = todayIso()): boolean {
  return startsOn !== "" && endsOn !== "" && startsOn >= today && endsOn >= startsOn;
}
