/**
 * The restore drill's judgements. Every one of these is a way a backup can restore successfully and
 * still be worthless, so each is asserted in the failing direction as well as the passing one.
 *
 * The case the old §7 procedure passed — every row back, every file gone — is pinned twice: once on
 * the file count against the source, and once on files against the `attachments` rows that point
 * at them.
 */

describe("the restore drill's checks", () => {
  let verify: {
    newestCompletePair: (keys: string[]) => { stamp: string; dump: string; attachments: string } | null;
    compareRowCounts: (source: Record<string, number>, restored: Record<string, number>) => string[];
    compareStorageKeys: (input: { referenced: string[]; restoredFiles: string[] }) => {
      missing: string[];
      orphans: string[];
    };
    storageKeyProblems: (input: { referenced: string[]; restoredFiles: string[] }) => string[];
    compareDigests: (source: Record<string, string>, restored: Record<string, string>) => string[];
  };

  beforeAll(async () => {
    verify = await import("../../../../scripts/backup/verify.mjs");
  });

  const dump = (stamp: string) => `clinic-os-${stamp}.dump.age`;
  const archive = (stamp: string) => `clinic-os-attachments-${stamp}.tar.gz.age`;

  describe("choosing which backup to restore", () => {
    test("takes the newest stamp that has both artefacts", () => {
      const pair = verify.newestCompletePair([
        dump("20260914T023000Z"),
        archive("20260914T023000Z"),
        dump("20260916T023000Z"),
        archive("20260916T023000Z"),
      ]);
      expect(pair?.stamp).toBe("20260916T023000Z");
    });

    test("skips a night whose archive never uploaded, rather than pairing across nights", () => {
      // The dangerous case: newest-of-each independently would pair the 16th's dump with the 14th's
      // files, and every attachment written on the 15th would be missing without a word.
      const pair = verify.newestCompletePair([
        dump("20260914T023000Z"),
        archive("20260914T023000Z"),
        dump("20260916T023000Z"),
      ]);
      expect(pair?.stamp).toBe("20260914T023000Z");
      expect(pair?.dump).toBe(dump("20260914T023000Z"));
      expect(pair?.attachments).toBe(archive("20260914T023000Z"));
    });

    test("returns null when no night is complete, rather than restoring half a backup", () => {
      expect(verify.newestCompletePair([dump("20260916T023000Z")])).toBeNull();
      expect(verify.newestCompletePair([])).toBeNull();
      expect(verify.newestCompletePair(["someone-elses-file.tar"])).toBeNull();
    });
  });

  describe("row counts", () => {
    test("says nothing when every table matches", () => {
      expect(verify.compareRowCounts({ patients: 120, visits: 340 }, { patients: 120, visits: 340 })).toEqual([]);
    });

    test("names the table and both numbers when a count differs", () => {
      const problems = verify.compareRowCounts({ patients: 120 }, { patients: 119 });
      expect(problems).toEqual(["patients: source 120, restored 119"]);
    });

    test("catches a table that did not restore at all", () => {
      expect(verify.compareRowCounts({ patients: 120, visits: 340 }, { patients: 120 })[0]).toContain(
        "visits: missing from the restore",
      );
    });

    test("catches a table in the restore that is not in the source", () => {
      expect(verify.compareRowCounts({ patients: 120 }, { patients: 120, ghost: 1 })[0]).toContain(
        "ghost: present in the restore and not in the source",
      );
    });

    test("an empty table that is empty in both is not a mismatch", () => {
      expect(verify.compareRowCounts({ audit_logs: 0 }, { audit_logs: 0 })).toEqual([]);
    });
  });

  describe("stored files — every referenced key, not the attachments table", () => {
    const scan = "tenant-a/scans/s1.pdf";
    const logo = "tenant-a/branding/logo/t/logo.png";

    test("passes when every referenced key has a file", () => {
      expect(verify.storageKeyProblems({ referenced: [scan, logo], restoredFiles: [scan, logo] })).toEqual([]);
    });

    test("fails a restore that brought back every row and not one file", () => {
      // DEPLOY.md §7's stated blind spot: the rows are all there, so a count-only drill reports
      // success while every download fails.
      const problems = verify.storageKeyProblems({ referenced: [scan, logo], restoredFiles: [] });
      expect(problems).toHaveLength(2);
      expect(problems.join(" ")).toContain("absent from the attachment archive");
    });

    test("fails when a single referenced file is missing", () => {
      const problems = verify.storageKeyProblems({ referenced: [scan, logo], restoredFiles: [scan] });
      expect(problems).toEqual([`${logo}: referenced by the restored database and absent from the attachment archive`]);
    });

    test("a logo with ZERO attachment rows is NOT a mismatch — the 2026-09-16 false positive", () => {
      // Run against clinic_os_review the drill failed on healthy data: the `attachments` table is
      // empty there and the storage root holds ten files, because logos, signatures, stamps,
      // profile photos and contracts live under it too. Six columns reference that root.
      expect(verify.storageKeyProblems({ referenced: [logo], restoredFiles: [logo] })).toEqual([]);
    });

    test("an orphan file is tolerated, not failed — §7 takes the dump first", () => {
      // A file uploaded between the dump and the tar is in the archive and not in the dump. That is
      // the inconsistency §7 deliberately chose, because nothing in the product looks for it.
      const split = verify.compareStorageKeys({ referenced: [scan], restoredFiles: [scan, logo] });
      expect(split.missing).toEqual([]);
      expect(split.orphans).toEqual([logo]);
      expect(verify.storageKeyProblems({ referenced: [scan], restoredFiles: [scan, logo] })).toEqual([]);
    });
  });

  describe("bytes, not just names", () => {
    test("passes identical digests", () => {
      expect(verify.compareDigests({ "a/scan.pdf": "abc" }, { "a/scan.pdf": "abc" })).toEqual([]);
    });

    test("catches a file restored with different bytes", () => {
      // A truncated or corrupted file has the right name and the wrong contents, which a file count
      // cannot distinguish from a good restore.
      expect(verify.compareDigests({ "a/scan.pdf": "abc" }, { "a/scan.pdf": "def" })[0]).toContain(
        "restored bytes differ",
      );
    });

    test("catches a file that is absent from the archive", () => {
      expect(verify.compareDigests({ "a/scan.pdf": "abc" }, {})[0]).toContain("not in the restored archive");
    });
  });
});
