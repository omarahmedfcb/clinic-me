/**
 * The chime itself. Browser-only, and split from `sound-preference.ts` for that reason.
 *
 * The preference functions are pure and are unit-tested by the API's test project, whose tsconfig
 * has no DOM lib — so a single module mixing `localStorage` rules with `AudioContext` fails
 * `npm run typecheck` on the API side while passing on the web side. Same seam `domain/` keeps, and
 * the same one `download.ts` needed: the part worth testing should not drag a browser in with it.
 */

/**
 * A short chime, synthesised rather than fetched.
 *
 * No audio file: a fetched asset is a network request that can fail exactly when the notification
 * arrives, and a bundled one is bytes shipped to every user for a feature that is off by default.
 * Two short sine tones through the Web Audio API are a few lines and always available.
 */
export class NotificationSound {
  private context: AudioContext | null = null;

  /**
   * Prepare the audio context inside a real user gesture.
   *
   * Called from the login button's handler. Creating and resuming an `AudioContext` there is what
   * satisfies the autoplay policy for the rest of the session; doing it later, from a poll, is
   * exactly the case browsers block.
   */
  unlock(): void {
    try {
      this.context ??= new AudioContext();
      if (this.context.state === "suspended") void this.context.resume();
    } catch {
      // No Web Audio. play() will report it.
    }
  }

  /**
   * Play the chime. Resolves `true` when it sounded, `false` when the browser refused.
   *
   * **Never throws and never resolves optimistically.** The caller renders a banner on `false`,
   * which is the whole point: the failure has to be visible.
   */
  async play(): Promise<boolean> {
    try {
      this.context ??= new AudioContext();
      if (this.context.state === "suspended") await this.context.resume();
      if (this.context.state !== "running") return false;

      const now = this.context.currentTime;
      for (const [index, frequency] of [880, 1174].entries()) {
        const oscillator = this.context.createOscillator();
        const gain = this.context.createGain();
        oscillator.frequency.value = frequency;
        oscillator.type = "sine";
        // A short envelope rather than a square start, which clicks.
        const start = now + index * 0.12;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.12, start + 0.02);
        gain.gain.linearRampToValueAtTime(0, start + 0.11);
        oscillator.connect(gain).connect(this.context.destination);
        oscillator.start(start);
        oscillator.stop(start + 0.12);
      }
      return true;
    } catch {
      return false;
    }
  }
}

/** One instance for the app: an AudioContext per notification would exhaust the browser's limit. */
export const notificationSound = new NotificationSound();
