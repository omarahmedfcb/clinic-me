import { readdirSync } from "node:fs";
import path from "node:path";

/**
 * A migration dated in the future is a migration whose ordering is a lie.
 *
 * Prisma applies by name, so `20260919…` sorts after everything written today and before everything
 * written tomorrow — which is fine until tomorrow's real migration is written, lands with a smaller
 * timestamp, and is applied *after* the one that was supposed to precede it. A database that has
 * already run the future-dated one also refuses the correction: the drift guard sees a migration it
 * has applied and cannot find on disk, which is the right answer and an expensive one.
 *
 * It happened on 2026-09-18, in `20260919090000_bot_webhook_deliveries`, and nothing caught it.
 */
const MIGRATIONS = path.join(__dirname, "..", "..", "prisma", "migrations");

/** `20260918140000_name` → the instant it claims to have been written at, or null. */
function claimedInstant(directory: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_/.exec(directory);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second] = match;
  return new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)),
  );
}

function migrationDirectories(): string[] {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

describe("every migration is dated when it was written", () => {
  test("none is dated in the future", () => {
    // `now` is read here rather than passed in because this asserts a fact about the clock at CI
    // time: a migration written in good faith cannot be dated after the moment it is checked.
    const now = Date.now();
    const ahead = migrationDirectories().filter((directory) => {
      const instant = claimedInstant(directory);
      return instant !== null && instant.getTime() > now;
    });
    expect(ahead).toEqual([]);
  });

  test("every directory carries a parseable timestamp, so the check above cannot skip one", () => {
    // Without this, a rename to something the pattern does not match would pass the test above by
    // being invisible to it — the failure mode every derived guard in this project is written against.
    const unparseable = migrationDirectories().filter((directory) => claimedInstant(directory) === null);
    expect(unparseable).toEqual([]);
  });

  test("the timestamps are unique and strictly ordered by name", () => {
    const names = migrationDirectories();
    const timestamps = names.map((name) => name.slice(0, 14));
    expect(new Set(timestamps).size).toBe(timestamps.length);
    expect([...names].sort()).toEqual(names.slice().sort());
  });
});
