/**
 * The decisions inside a backup run: the size floor that refuses a file that is not a backup, and
 * the retention split that decides which stored copies are deleted.
 *
 * Both are guards, so both are asserted in the failing direction as well as the passing one. The
 * retention half takes its reference instant as a parameter and the module never reads the clock —
 * a policy that deletes the clinic's only copy of its data has to be reproducible in a test.
 */

type RetentionSplit = { keep: string[]; expire: string[]; unparsed: string[] };

describe("the backup plan", () => {
  let plan: {
    SIZE_FLOORS: Record<string, number>;
    DAILY_RETAINED: number;
    MONTHLY_RETAINED: number;
    stampFor: (instant: Date) => string;
    parseStamp: (key: string) => Date | null;
    artefactNames: (stamp: string) => { dump: string; attachments: string };
    checkSize: (kind: string, bytes: number) => string | null;
    kindOf: (key: string) => string | null;
    selectForRetention: (keys: string[], referenceDate: Date) => RetentionSplit;
  };

  beforeAll(async () => {
    // By relative path, so Jest resolves it through its own registry and transforms it, exactly as
    // check-encoding.spec.ts reaches the repository's other bare-node script.
    plan = await import("../../../../scripts/backup/plan.mjs");
  });

  describe("the stamp", () => {
    test("is UTC, so a host that changes offset cannot reorder its own backups", () => {
      expect(plan.stampFor(new Date("2026-09-16T02:30:05Z"))).toBe("20260916T023005Z");
    });

    test("round-trips through a key", () => {
      const stamp = plan.stampFor(new Date("2026-09-16T02:30:05Z"));
      const { dump } = plan.artefactNames(stamp);
      expect(dump).toBe("clinic-os-20260916T023005Z.dump.age");
      expect(plan.parseStamp(dump)?.toISOString()).toBe("2026-09-16T02:30:05.000Z");
    });

    test("returns null for anything that is not ours, rather than throwing", () => {
      expect(plan.parseStamp("some-other-tool.tar.gz")).toBeNull();
      expect(plan.parseStamp("")).toBeNull();
    });
  });

  describe("telling the two artefacts apart", () => {
    test("reads each kind from its own key", () => {
      expect(plan.kindOf("clinic-os-20260916T023000Z.dump.age")).toBe("dump");
      expect(plan.kindOf("clinic-os-attachments-20260916T023000Z.tar.gz.age")).toBe("attachments");
    });

    test("claims nothing it does not own", () => {
      expect(plan.kindOf("clinic-os-20260916T023000Z.dump")).toBeNull();
      expect(plan.kindOf("wal/000000010000000000000042")).toBeNull();
      expect(plan.kindOf("clinic-os-notes.txt")).toBeNull();
    });
  });

  describe("the size floor — the guard that refuses a file that is not a backup", () => {
    test("accepts a dump above the floor", () => {
      expect(plan.checkSize("dump", plan.SIZE_FLOORS["dump"]! + 1)).toBeNull();
    });

    test("refuses a dump below it, naming both numbers", () => {
      const reason = plan.checkSize("dump", 1_500);
      expect(reason).toContain("1500 bytes");
      expect(reason).toContain("100000-byte floor");
    });

    test("refuses an empty tar, which is about 45 bytes", () => {
      expect(plan.checkSize("attachments", 45)).not.toBeNull();
    });

    test("refuses a size that is not a byte count", () => {
      expect(plan.checkSize("dump", Number.NaN)).toContain("not a byte count");
      expect(plan.checkSize("dump", -1)).toContain("not a byte count");
    });

    test("refuses an artefact kind it does not know", () => {
      expect(plan.checkSize("wal", 10_000_000)).toContain("Unknown artefact kind");
    });
  });

  describe("retention — 30 daily and 12 monthly", () => {
    const key = (iso: string) => `clinic-os-${iso}.dump.age`;

    /** One backup a day, at 02:30Z, for `days` days ending the day before `end`. */
    const nightly = (end: Date, days: number): string[] =>
      Array.from({ length: days }, (_, index) => {
        const at = new Date(end.getTime() - (index + 1) * 24 * 60 * 60 * 1000);
        at.setUTCHours(2, 30, 0, 0);
        return key(plan.stampFor(at));
      });

    test("keeps the last 30 days outright", () => {
      const reference = new Date("2026-09-16T03:00:00Z");
      const split = plan.selectForRetention(nightly(reference, 40), reference);

      // The 30 most recent days, plus whatever the monthly rule pins in the older ten.
      expect(split.keep.length).toBeGreaterThanOrEqual(plan.DAILY_RETAINED);
      expect(split.keep.slice(0, plan.DAILY_RETAINED)).toEqual(nightly(reference, plan.DAILY_RETAINED));
      expect(split.expire.length).toBeGreaterThan(0);
    });

    test("keeps one backup per month for twelve months, long after the daily window", () => {
      const reference = new Date("2026-09-16T03:00:00Z");
      const twoYears = nightly(reference, 730);
      const split = plan.selectForRetention(twoYears, reference);

      const months = new Set(split.keep.map((k) => plan.parseStamp(k)!.toISOString().slice(0, 7)));
      expect(months.size).toBe(plan.MONTHLY_RETAINED);

      // And the ones it dropped are genuinely older than the monthly window, not a gap inside it.
      const oldest = split.keep.map((k) => plan.parseStamp(k)!.getTime()).sort((a, b) => a - b)[0]!;
      for (const expired of split.expire) {
        const at = plan.parseStamp(expired)!.getTime();
        const sameMonth = split.keep.some(
          (k) => plan.parseStamp(k)!.toISOString().slice(0, 7) === plan.parseStamp(expired)!.toISOString().slice(0, 7),
        );
        expect(at < oldest || sameMonth).toBe(true);
      }
    });

    test("the monthly copy kept is the newest one in its month", () => {
      const reference = new Date("2026-09-16T03:00:00Z");
      const split = plan.selectForRetention(nightly(reference, 200), reference);
      const june = split.keep.filter((k) => k.includes("202606"));
      expect(june).toEqual(["clinic-os-20260630T023000Z.dump.age"]);
    });

    test("keeps a night's dump AND its attachment archive — they are one backup, not two copies", () => {
      // Found by running the job: both artefacts of a run share a stamp, so a single pool read them
      // as two copies of one day and kept one. The attachments half was uploaded, then deleted.
      const stamp = "20260916T023000Z";
      const both = [`clinic-os-${stamp}.dump.age`, `clinic-os-attachments-${stamp}.tar.gz.age`];
      const split = plan.selectForRetention(both, new Date("2026-09-16T03:00:00Z"));

      expect(split.expire).toEqual([]);
      expect(split.keep.sort()).toEqual(both.sort());
    });

    test("counts the two kinds separately over a long history", () => {
      const reference = new Date("2026-09-16T03:00:00Z");
      const dumps = nightly(reference, 400);
      const archives = dumps.map((k) => k.replace(/^clinic-os-(.+)\.dump\.age$/, "clinic-os-attachments-$1.tar.gz.age"));
      const split = plan.selectForRetention([...dumps, ...archives], reference);

      const kept = (kind: string) => split.keep.filter((k) => plan.kindOf(k) === kind).length;
      expect(kept("dump")).toBe(kept("attachments"));
      expect(kept("dump")).toBeGreaterThanOrEqual(plan.DAILY_RETAINED);
    });

    test("never expires a key it cannot read — something else owns it", () => {
      const reference = new Date("2026-09-16T03:00:00Z");
      const split = plan.selectForRetention([...nightly(reference, 400), "someone-elses-file.tar"], reference);
      expect(split.unparsed).toEqual(["someone-elses-file.tar"]);
      expect(split.expire).not.toContain("someone-elses-file.tar");
    });

    test("never expires a backup dated after the run that is pruning", () => {
      const reference = new Date("2026-09-16T03:00:00Z");
      const future = key("20270101T023000Z");
      const split = plan.selectForRetention([...nightly(reference, 400), future], reference);
      expect(split.keep).toContain(future);
      expect(split.expire).not.toContain(future);
    });

    test("is a pure function of its reference instant, not of the clock", () => {
      const keys = nightly(new Date("2026-09-16T03:00:00Z"), 400);
      const first = plan.selectForRetention(keys, new Date("2026-09-16T03:00:00Z"));
      const second = plan.selectForRetention(keys, new Date("2026-09-16T03:00:00Z"));
      expect(second).toEqual(first);
    });

    test("counts copies that exist, not calendar days — a cron that stopped must not wipe the dailies", () => {
      // Every backup is three months old: the job died in June and nobody noticed until September.
      const stale = nightly(new Date("2026-06-16T03:00:00Z"), 40);
      const split = plan.selectForRetention(stale, new Date("2026-09-16T03:00:00Z"));

      // Read as "within the last 30 calendar days" this keeps nothing but the monthlies, and a
      // prune run during an outage becomes the thing that destroys the backups.
      expect(split.keep.slice(0, plan.DAILY_RETAINED)).toEqual(stale.slice(0, plan.DAILY_RETAINED));
    });

    test("an empty bucket is not an error", () => {
      expect(plan.selectForRetention([], new Date("2026-09-16T03:00:00Z"))).toEqual({
        keep: [],
        expire: [],
        unparsed: [],
      });
    });
  });
});
