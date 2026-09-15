/**
 * A small deterministic pseudo-random generator, so that two runs of the seed against two fresh
 * databases produce the same clinic. `Math.random()` would make every developer's seeded data
 * different, which turns "the appointment on the 14th looks wrong" into a conversation nobody
 * else can reproduce.
 *
 * This is mulberry32: 32-bit state, one multiply-shift round. It is not cryptographic and must
 * never be used for anything that needs real entropy -- ids come from uuidv7(), and passwords are
 * hashed with Argon2id. It exists purely to make fake data repeatable.
 */
export class Prng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with the given probability. */
  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /** One element of a non-empty array. */
  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) {
      throw new Error("Prng.pick called with an empty array.");
    }
    return item;
  }

  /**
   * One element chosen by relative weight. Used for status distributions, where "most past
   * appointments completed, a few were no-shows" is the realistic shape and a uniform pick is not.
   */
  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = this.next() * total;
    for (const [value, weight] of entries) {
      roll -= weight;
      if (roll < 0) return value;
    }
    const last = entries[entries.length - 1];
    if (last === undefined) {
      throw new Error("Prng.weighted called with no entries.");
    }
    return last[0];
  }
}
