import { setSoundEnabled, soundEnabled } from "../../../web/src/features/notifications/sound-preference.ts";

/**
 * The notification sound preference.
 *
 * Two rules are load-bearing and neither is obvious from the code alone:
 *
 * **Off by default.** Reception is a shared, quiet, public-facing room, and a system that starts
 * making noise on a stranger's desk is one they resent before they trust it. So *anything* other
 * than an explicit "on" means silence — absent, unreadable, or a value nobody recognises.
 *
 * **Storage failure must not throw.** A private window, blocked site data or an embedded viewer can
 * make `localStorage` throw on access, not merely return null. An unguarded read there takes down
 * the shell's header — the notification bell would break the whole top bar for a preference nobody
 * had set.
 */

/** A `localStorage` that throws on everything, which is what a locked-down browser really does. */
const hostile: Storage = {
  get length(): number {
    throw new Error("storage disabled");
  },
  clear() {
    throw new Error("storage disabled");
  },
  getItem() {
    throw new Error("storage disabled");
  },
  key() {
    throw new Error("storage disabled");
  },
  removeItem() {
    throw new Error("storage disabled");
  },
  setItem() {
    throw new Error("storage disabled");
  },
};

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

describe("notification sound preference", () => {
  it("is off when nothing has been stored", () => {
    expect(soundEnabled(memoryStorage())).toBe(false);
  });

  it("is on only for an explicit 'on'", () => {
    expect(soundEnabled(memoryStorage({ "clinic-os.notifications.sound": "on" }))).toBe(true);
    expect(soundEnabled(memoryStorage({ "clinic-os.notifications.sound": "off" }))).toBe(false);
    // Anything unrecognised means silence, not "probably on".
    expect(soundEnabled(memoryStorage({ "clinic-os.notifications.sound": "true" }))).toBe(false);
    expect(soundEnabled(memoryStorage({ "clinic-os.notifications.sound": "" }))).toBe(false);
  });

  it("round-trips a choice in both directions", () => {
    const storage = memoryStorage();
    setSoundEnabled(storage, true);
    expect(soundEnabled(storage)).toBe(true);
    setSoundEnabled(storage, false);
    expect(soundEnabled(storage)).toBe(false);
  });

  describe("when storage itself throws", () => {
    it("reads as off rather than throwing", () => {
      expect(() => soundEnabled(hostile)).not.toThrow();
      expect(soundEnabled(hostile)).toBe(false);
    });

    /**
     * Writing must not throw either. The toggle still works for the session — it simply is not
     * remembered — which is a better outcome than a header that crashes when someone clicks it.
     */
    it("writes without throwing", () => {
      expect(() => setSoundEnabled(hostile, true)).not.toThrow();
    });
  });

  /**
   * The key is per device by living in `localStorage` at all: whether sound is appropriate depends
   * on the room the browser is in, not on who the person is. The same receptionist wants sound at
   * the front desk and silence on a laptop in a consulting room, and a server-side preference would
   * follow them into the wrong room. Pinned so a later "sync this to the user" refactor has to
   * delete an assertion that explains why not.
   */
  it("stores under a device-local key, not a user-scoped one", () => {
    const storage = memoryStorage();
    setSoundEnabled(storage, true);
    expect(storage.key(0)).toBe("clinic-os.notifications.sound");
  });
});
