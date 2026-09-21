import { describe, expect, test } from "vitest";
import { chooseVersion, dataCodewords, encodeQr, formatBits, interleave, qrSvg, remainder } from "./qr.ts";

/**
 * **A QR either scans or it does not, and a wrong one looks exactly like a right one.**
 *
 * That is the whole reason this file is as long as it is. A hand-written encoder can produce a
 * plausible black-and-white pattern with a transposed table inside it, and nothing about looking at
 * it says so — which is the failure shape this project keeps writing guards against.
 *
 * Three independent kinds of evidence, because no one of them is enough:
 *
 * 1. **Reed-Solomon syndromes.** For a correct codeword the polynomial evaluates to zero at each
 *    root of the generator. This is arithmetic over GF(256) and shares nothing with the encoder's
 *    block tables — if the EC codewords were wrong, it fails.
 * 2. **A reader written backwards from the spec**, below, which unmasks and walks the zigzag in
 *    reverse and recovers the payload. It exercises placement, masking and the format bits.
 * 3. **The fixed patterns**, checked at their known coordinates.
 *
 * What none of them can prove is that a phone will read it. That is stated rather than implied, and
 * it is why `OPERATOR_TOTP=off` exists: the review is not blocked on this being right.
 */

// ---------------------------------------------------------------------------------------------
// 1. Reed-Solomon, checked by its own definition
// ---------------------------------------------------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255] as number;
}
const mul = (a: number, b: number): number =>
  a === 0 || b === 0 ? 0 : (EXP[(LOG[a] as number) + (LOG[b] as number)] as number);

/** `p(a^i)` for a codeword polynomial, most-significant first. Zero for every root, if correct. */
function evaluateAt(codeword: readonly number[], power: number): number {
  let value = 0;
  for (const byte of codeword) value = mul(value, EXP[power] as number) ^ byte;
  return value;
}

describe("the Reed-Solomon codewords satisfy their own definition", () => {
  test("every syndrome is zero, for several lengths and payloads", () => {
    const cases = [
      { data: [0x40, 0xd2, 0x75, 0x47, 0x76, 0x17, 0x32, 0x06, 0x27, 0x26, 0x96, 0xc6, 0xc6, 0x96, 0x70, 0xec], ec: 10 },
      { data: [...new Array(28).keys()].map((n) => (n * 7 + 3) & 0xff), ec: 16 },
      { data: [...new Array(44).keys()].map((n) => (n * 31 + 11) & 0xff), ec: 26 },
    ];

    const failures: string[] = [];
    for (const { data, ec } of cases) {
      const full = [...data, ...remainder(data, ec)];
      for (let i = 0; i < ec; i += 1) {
        if (evaluateAt(full, i) !== 0) failures.push(`ec=${ec} syndrome ${i} = ${evaluateAt(full, i)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("and a corrupted codeword does NOT satisfy it, so the check is not vacuous", () => {
    const data = [0x40, 0xd2, 0x75, 0x47, 0x76, 0x17, 0x32, 0x06, 0x27, 0x26, 0x96, 0xc6, 0xc6, 0x96, 0x70, 0xec];
    const full = [...data, ...remainder(data, 10)];
    full[3] = ((full[3] as number) ^ 0x5a) & 0xff;

    const syndromes = [...new Array(10).keys()].map((i) => evaluateAt(full, i));
    expect(syndromes.some((value) => value !== 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. A reader, written from the spec in the opposite direction
// ---------------------------------------------------------------------------------------------

const MASKS: ((row: number, column: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

const ALIGNMENT_CENTRES: number[][] = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

const LEVEL_M_BLOCKS: { ecPerBlock: number; blocks: { count: number; dataCodewords: number }[] }[] = [
  { ecPerBlock: 0, blocks: [] },
  { ecPerBlock: 10, blocks: [{ count: 1, dataCodewords: 16 }] },
  { ecPerBlock: 16, blocks: [{ count: 1, dataCodewords: 28 }] },
  { ecPerBlock: 26, blocks: [{ count: 1, dataCodewords: 44 }] },
  { ecPerBlock: 18, blocks: [{ count: 2, dataCodewords: 32 }] },
  { ecPerBlock: 24, blocks: [{ count: 2, dataCodewords: 43 }] },
  { ecPerBlock: 16, blocks: [{ count: 4, dataCodewords: 27 }] },
  { ecPerBlock: 18, blocks: [{ count: 4, dataCodewords: 31 }] },
  { ecPerBlock: 22, blocks: [{ count: 2, dataCodewords: 38 }, { count: 2, dataCodewords: 39 }] },
  { ecPerBlock: 22, blocks: [{ count: 3, dataCodewords: 36 }, { count: 2, dataCodewords: 37 }] },
  { ecPerBlock: 26, blocks: [{ count: 4, dataCodewords: 43 }, { count: 1, dataCodewords: 44 }] },
];

/** Which modules a reader must skip: the function patterns and the reserved areas. */
function reservedMap(version: number, n: number): boolean[][] {
  const reserved = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const mark = (r: number, c: number): void => {
    if (r >= 0 && r < n && c >= 0 && c < n) (reserved[r] as boolean[])[c] = true;
  };

  for (const [atRow, atColumn] of [[0, 0], [0, n - 7], [n - 7, 0]] as const) {
    for (let r = -1; r <= 7; r += 1) for (let c = -1; c <= 7; c += 1) mark(atRow + r, atColumn + c);
  }
  for (let i = 0; i < n; i += 1) {
    mark(6, i);
    mark(i, 6);
  }
  for (const row of ALIGNMENT_CENTRES[version] as number[]) {
    for (const column of ALIGNMENT_CENTRES[version] as number[]) {
      if ((row === 6 && column === 6) || (row === 6 && column === n - 7) || (row === n - 7 && column === 6)) continue;
      for (let r = -2; r <= 2; r += 1) for (let c = -2; c <= 2; c += 1) mark(row + r, column + c);
    }
  }
  for (let i = 0; i <= 8; i += 1) {
    mark(8, i);
    mark(i, 8);
  }
  for (let i = 0; i < 8; i += 1) {
    mark(8, n - 1 - i);
    mark(n - 1 - i, 8);
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      mark(Math.floor(i / 3), n - 11 + (i % 3));
      mark(n - 11 + (i % 3), Math.floor(i / 3));
    }
  }
  return reserved;
}

/** Recovers the byte-mode payload from a matrix. No error correction — the data must be intact. */
function readQr(matrix: { modules: boolean[][]; size: number; version: number; mask: number }): string {
  const { modules, size: n, version, mask } = matrix;
  const reserved = reservedMap(version, n);
  const rule = MASKS[mask] as (row: number, column: number) => boolean;

  // Walk the zigzag, unmasking as we go.
  const bits: number[] = [];
  let upward = true;
  for (let right = n - 1; right >= 1; right -= 2) {
    const pair = right === 6 ? 5 : right;
    for (let step = 0; step < n; step += 1) {
      const row = upward ? n - 1 - step : step;
      for (const column of [pair, pair - 1]) {
        if ((reserved[row] as boolean[])[column]) continue;
        const dark = (modules[row] as boolean[])[column] as boolean;
        bits.push((rule(row, column) ? !dark : dark) ? 1 : 0);
      }
    }
    upward = !upward;
  }

  const interleaved: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (bits[i + j] as number);
    interleaved.push(byte);
  }

  // De-interleave: rebuild each block's data run, in the order `interleave` wrote them.
  const level = LEVEL_M_BLOCKS[version] as { ecPerBlock: number; blocks: { count: number; dataCodewords: number }[] };
  const lengths: number[] = [];
  for (const group of level.blocks) for (let i = 0; i < group.count; i += 1) lengths.push(group.dataCodewords);

  const blocks: number[][] = lengths.map(() => []);
  let at = 0;
  const longest = Math.max(...lengths);
  for (let i = 0; i < longest; i += 1) {
    for (let b = 0; b < lengths.length; b += 1) {
      if (i < (lengths[b] as number)) {
        (blocks[b] as number[]).push(interleaved[at] as number);
        at += 1;
      }
    }
  }
  const data = blocks.flat();

  // Mode, count, payload.
  const stream: number[] = [];
  for (const byte of data) for (let i = 7; i >= 0; i -= 1) stream.push((byte >> i) & 1);

  const take = (start: number, length: number): number => {
    let value = 0;
    for (let i = 0; i < length; i += 1) value = (value << 1) | (stream[start + i] as number);
    return value;
  };

  const mode = take(0, 4);
  if (mode !== 0b0100) throw new Error(`Expected byte mode, read ${mode.toString(2)}`);
  const countBits = version < 10 ? 8 : 16;
  const length = take(4, countBits);

  const bytes: number[] = [];
  for (let i = 0; i < length; i += 1) bytes.push(take(4 + countBits + i * 8, 8));
  return new TextDecoder().decode(new Uint8Array(bytes));
}

describe("a QR reads back as what was encoded", () => {
  const CASES = [
    "hi",
    "otpauth://totp/clinic-os%3A%2B201000000000?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=clinic-os&algorithm=SHA1&digits=6&period=30",
    "https://example.test/a-medium-length-url-that-lands-in-a-middle-version",
    "x".repeat(200),
  ];

  test("every case round-trips through an independently written reader", () => {
    const results = CASES.map((text) => ({ text, read: readQr(encodeQr(text)) }));
    expect(results).toEqual(CASES.map((text) => ({ text, read: text })));
  });

  test("the reader is not trivially agreeing — a flipped data module breaks it", () => {
    // Without this, a reader that returned its input would pass the test above.
    const qr = encodeQr(CASES[1] as string);
    // A module well inside the data area, away from every function pattern.
    const row = qr.size - 3;
    const column = qr.size - 3;
    (qr.modules[row] as boolean[])[column] = !(qr.modules[row] as boolean[])[column];
    expect(readQr(qr)).not.toBe(CASES[1]);
  });

  test("the otpauth URI lands in a version this encoder supports, with room to spare", () => {
    const qr = encodeQr(CASES[1] as string);
    expect(qr.version).toBeGreaterThanOrEqual(6);
    expect(qr.version).toBeLessThanOrEqual(10);
  });

  test("text that will not fit throws rather than truncating", () => {
    // A truncated QR scans perfectly and yields the wrong secret, which is the worst outcome
    // available: an authenticator producing codes nobody accepts, with no indication why.
    expect(() => encodeQr("y".repeat(400))).toThrow(/will not fit/);
  });
});

describe("the fixed patterns are where the standard puts them", () => {
  const qr = encodeQr("otpauth://totp/x?secret=ABCDEFGHIJKLMNOP");

  test("three finders, each a 7x7 ring with a 3x3 core", () => {
    const at = (r: number, c: number): boolean => (qr.modules[r] as boolean[])[c] as boolean;
    const corners = [
      [0, 0],
      [0, qr.size - 7],
      [qr.size - 7, 0],
    ] as const;

    const findings = corners.map(([row, column]) => ({
      corner: `${row},${column}`,
      topLeft: at(row, column),
      ringGap: at(row + 1, column + 1),
      core: at(row + 3, column + 3),
    }));
    expect(findings).toEqual(
      corners.map(([row, column]) => ({ corner: `${row},${column}`, topLeft: true, ringGap: false, core: true })),
    );
  });

  test("the timing patterns alternate", () => {
    const row6 = [];
    for (let c = 8; c < qr.size - 8; c += 1) row6.push((qr.modules[6] as boolean[])[c]);
    expect(row6.every((dark, i) => dark === (i % 2 === 0))).toBe(true);
  });

  test("the dark module is dark", () => {
    expect((qr.modules[qr.size - 8] as boolean[])[8]).toBe(true);
  });
});

describe("the format and version strings are BCH-correct", () => {
  test("every format string has a zero remainder once unmasked", () => {
    // The 15 bits are a (15,5) BCH code XORed with 0x5412. Dividing the unmasked value by the
    // generator must leave nothing — arithmetic, not a table this file also wrote.
    const failures: string[] = [];
    for (let mask = 0; mask < 8; mask += 1) {
      let value = formatBits(mask) ^ 0x5412;
      for (let i = 14; i >= 10; i -= 1) {
        if ((value >> i) & 1) value ^= 0x537 << (i - 10);
      }
      if (value !== 0) failures.push(`mask ${mask} -> remainder ${value}`);
    }
    expect(failures).toEqual([]);
  });

  test("the level bits say M, and each mask is carried", () => {
    for (let mask = 0; mask < 8; mask += 1) {
      const data = (formatBits(mask) ^ 0x5412) >> 10;
      expect({ mask, level: data >> 3, carried: data & 0b111 }).toEqual({ mask, level: 0b00, carried: mask });
    }
  });
});

describe("the SVG", () => {
  test("is one path, has the quiet zone, and contains no raster", () => {
    const svg = qrSvg("otpauth://totp/x?secret=ABCDEFGH");
    expect(svg.startsWith("<svg")).toBe(true);
    expect([...svg.matchAll(/<path /g)].length).toBe(1);
    for (const marker of ["<image", "data:image", ";base64"]) expect(svg.includes(marker)).toBe(false);

    // The quiet zone is four modules each side, so the viewBox exceeds the module count by eight.
    const span = Number(/viewBox="0 0 (\d+)/.exec(svg)?.[1]);
    expect(span - encodeQr("otpauth://totp/x?secret=ABCDEFGH").size).toBe(8);
  });
});

describe("version selection", () => {
  test("grows with the payload and refuses beyond ten", () => {
    expect(chooseVersion(10)).toBe(1);
    expect(chooseVersion(200)).toBe(10);
    expect(chooseVersion(400)).toBeNull();
  });

  test("the data block is padded to exactly the version's capacity", () => {
    const codewords = dataCodewords("hello", 4);
    expect(codewords.length).toBe(64);
    expect(interleave(codewords, 4).length).toBe(64 + 2 * 18);
  });
});
