// A QR encoder, byte mode, error-correction level M, versions 1–10. ISO/IEC 18004.
//
// Hand-written rather than a dependency: the one thing this needs to draw is an `otpauth://` URI,
// and every package for it also brings a renderer, a CLI and a canvas shim.

/**
 * What is implemented, and what is deliberately not.
 *
 * **Byte mode only.** An `otpauth://` URI is mixed case with punctuation, so alphanumeric mode
 * cannot encode it and numeric mode is irrelevant. Adding modes that nothing calls would be
 * untested code in the one place a silent failure is invisible — a QR either scans or it does not.
 *
 * **Level M, versions 1–10.** The URIs this draws run 90–160 bytes, which is version 6–8 at M.
 * Ten is comfortable headroom; `encodeQr` throws rather than truncating if a caller ever exceeds it,
 * because a truncated QR scans perfectly and yields the wrong secret.
 */

/** Level M: EC codewords per block, and the block structure `[group1, group2]`. */
const LEVEL_M = [
  null,
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
] as const;

/** Alignment-pattern centre coordinates per version. Version 1 has none. */
const ALIGNMENT_CENTRES = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
] as const;

const size = (version: number): number => version * 4 + 17;

const dataCapacity = (version: number): number => {
  const level = LEVEL_M[version];
  if (level == null) throw new Error(`No level-M table for version ${version}`);
  return level.blocks.reduce((sum, group) => sum + group.count * group.dataCodewords, 0);
};

// ---------------------------------------------------------------------------------------------
// GF(256) — the field Reed-Solomon works over. Primitive polynomial 0x11D, the QR standard's.
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

/** The generator polynomial for `degree` EC codewords: (x - a^0)(x - a^1)…(x - a^(degree-1)). */
function generator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      // Most-significant-first, so multiplying by x keeps the index and multiplying by the constant
      // a^i moves one along. The two were the other way round in the first version, which builds
      // the *reciprocal* polynomial — its roots are a^-i, so every syndrome came out non-zero while
      // the QR still looked perfectly plausible and still round-tripped through a reader that does
      // no error correction. Found by the syndrome check, which is the only thing that could.
      next[j] = (next[j] as number) ^ (poly[j] as number);
      next[j + 1] = (next[j + 1] as number) ^ mul(poly[j] as number, EXP[i] as number);
    }
    poly = next;
  }
  return poly;
}

/** The Reed-Solomon remainder — the EC codewords for one block. */
export function remainder(data: readonly number[], ecLength: number): number[] {
  const gen = generator(ecLength);
  const out = new Array<number>(ecLength).fill(0);

  for (const byte of data) {
    const factor = byte ^ (out[0] as number);
    out.shift();
    out.push(0);
    for (let i = 0; i < ecLength; i += 1) {
      out[i] = (out[i] as number) ^ mul(gen[i + 1] as number, factor);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The bit stream
// ---------------------------------------------------------------------------------------------

class Bits {
  readonly bits: number[] = [];

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  }
}

/** The smallest version 1–10 whose level-M data capacity holds `bytes`, or null. */
export function chooseVersion(byteLength: number): number | null {
  for (let version = 1; version <= 10; version += 1) {
    // Mode indicator (4) + character count + payload, in bits.
    const countBits = version < 10 ? 8 : 16;
    if (4 + countBits + byteLength * 8 <= dataCapacity(version) * 8) return version;
  }
  return null;
}

/** Data codewords for `text`: mode, count, payload, terminator, padding. */
export function dataCodewords(text: string, version: number): number[] {
  const payload = [...new TextEncoder().encode(text)];
  const capacity = dataCapacity(version);

  const stream = new Bits();
  stream.push(0b0100, 4); // byte mode
  stream.push(payload.length, version < 10 ? 8 : 16);
  for (const byte of payload) stream.push(byte, 8);

  // Terminator: up to four zero bits, then pad to a byte boundary.
  const room = capacity * 8 - stream.bits.length;
  stream.push(0, Math.min(4, room));
  while (stream.bits.length % 8 !== 0) stream.bits.push(0);

  const codewords: number[] = [];
  for (let i = 0; i < stream.bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (stream.bits[i + j] as number);
    codewords.push(byte);
  }

  // The specified pad bytes, alternating, until the block is full.
  const PAD = [0xec, 0x11];
  while (codewords.length < capacity) codewords.push(PAD[(codewords.length - stream.bits.length / 8) % 2] as number);
  return codewords;
}

/** Data and EC codewords, split into blocks and interleaved as the spec requires. */
export function interleave(data: readonly number[], version: number): number[] {
  const level = LEVEL_M[version];
  if (level == null) throw new Error(`No level-M table for version ${version}`);

  const blocks: { data: number[]; ec: number[] }[] = [];
  let at = 0;
  for (const group of level.blocks) {
    for (let i = 0; i < group.count; i += 1) {
      const chunk = data.slice(at, at + group.dataCodewords);
      at += group.dataCodewords;
      blocks.push({ data: chunk, ec: remainder(chunk, level.ecPerBlock) });
    }
  }

  const out: number[] = [];
  const longest = Math.max(...blocks.map((block) => block.data.length));
  for (let i = 0; i < longest; i += 1) {
    for (const block of blocks) if (i < block.data.length) out.push(block.data[i] as number);
  }
  for (let i = 0; i < level.ecPerBlock; i += 1) {
    for (const block of blocks) out.push(block.ec[i] as number);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------------------------

type Grid = { modules: boolean[][]; reserved: boolean[][]; n: number };

function blank(version: number): Grid {
  const n = size(version);
  return {
    n,
    modules: Array.from({ length: n }, () => new Array<boolean>(n).fill(false)),
    reserved: Array.from({ length: n }, () => new Array<boolean>(n).fill(false)),
  };
}

function place(grid: Grid, row: number, column: number, dark: boolean, reserve = true): void {
  (grid.modules[row] as boolean[])[column] = dark;
  if (reserve) (grid.reserved[row] as boolean[])[column] = true;
}

function finder(grid: Grid, atRow: number, atColumn: number): void {
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const row = atRow + r;
      const column = atColumn + c;
      if (row < 0 || row >= grid.n || column < 0 || column >= grid.n) continue;
      const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      place(grid, row, column, inRing || inCore);
    }
  }
}

function functionPatterns(grid: Grid, version: number): void {
  finder(grid, 0, 0);
  finder(grid, 0, grid.n - 7);
  finder(grid, grid.n - 7, 0);

  // Timing patterns.
  for (let i = 8; i < grid.n - 8; i += 1) {
    place(grid, 6, i, i % 2 === 0);
    place(grid, i, 6, i % 2 === 0);
  }

  // Alignment patterns, skipping the three that would sit on a finder.
  const centres = ALIGNMENT_CENTRES[version] ?? [];
  for (const row of centres) {
    for (const column of centres) {
      const onFinder =
        (row === 6 && column === 6) ||
        (row === 6 && column === grid.n - 7) ||
        (row === grid.n - 7 && column === 6);
      if (onFinder) continue;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          place(grid, row + r, column + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
        }
      }
    }
  }

  // The dark module, always.
  place(grid, grid.n - 8, 8, true);

  // Reserve the format-information areas; their values are written after masking.
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      (grid.reserved[8] as boolean[])[i] = true;
      (grid.reserved[i] as boolean[])[8] = true;
    }
  }
  for (let i = 0; i < 8; i += 1) {
    (grid.reserved[8] as boolean[])[grid.n - 1 - i] = true;
    (grid.reserved[grid.n - 1 - i] as boolean[])[8] = true;
  }

  // Version information, versions 7 and up.
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >> i) & 1) === 1;
      const row = Math.floor(i / 3);
      const column = grid.n - 11 + (i % 3);
      place(grid, row, column, dark);
      place(grid, column, row, dark);
    }
  }
}

/** The 18-bit version string: 6 data bits and a (18,6) Golay remainder. */
export function versionBits(version: number): number {
  let remainderBits = version;
  for (let i = 0; i < 12; i += 1) {
    remainderBits = (remainderBits << 1) ^ ((remainderBits >>> 11) * 0x1f25);
  }
  return ((version << 12) | remainderBits) >>> 0;
}

/** The 15-bit format string for level M and a mask, BCH-coded and XOR-masked. */
export function formatBits(mask: number): number {
  // Level M is `00` in the format's error-correction field.
  const data = (0b00 << 3) | mask;
  let remainderBits = data;
  for (let i = 0; i < 10; i += 1) {
    remainderBits = (remainderBits << 1) ^ ((remainderBits >>> 9) * 0x537);
  }
  return (((data << 10) | remainderBits) ^ 0x5412) >>> 0;
}

function writeFormat(grid: Grid, mask: number): void {
  const bits = formatBits(mask);
  for (let i = 0; i <= 5; i += 1) place(grid, 8, i, ((bits >> i) & 1) === 1);
  place(grid, 8, 7, ((bits >> 6) & 1) === 1);
  place(grid, 8, 8, ((bits >> 7) & 1) === 1);
  place(grid, 7, 8, ((bits >> 8) & 1) === 1);
  for (let i = 9; i < 15; i += 1) place(grid, 14 - i, 8, ((bits >> i) & 1) === 1);

  for (let i = 0; i < 8; i += 1) place(grid, grid.n - 1 - i, 8, ((bits >> i) & 1) === 1);
  for (let i = 8; i < 15; i += 1) place(grid, 8, grid.n - 15 + i, ((bits >> i) & 1) === 1);
  place(grid, grid.n - 8, 8, true);
}

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

/** Writes the codeword bits along the spec's upward/downward zigzag, skipping reserved modules. */
function placeData(grid: Grid, codewords: readonly number[]): void {
  let bit = 0;
  let upward = true;

  for (let right = grid.n - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern and is not part of the zigzag.
    const pair = right === 6 ? 5 : right;
    for (let step = 0; step < grid.n; step += 1) {
      const row = upward ? grid.n - 1 - step : step;
      for (const column of [pair, pair - 1]) {
        if ((grid.reserved[row] as boolean[])[column]) continue;
        const byte = codewords[bit >> 3] ?? 0;
        const dark = ((byte >> (7 - (bit & 7))) & 1) === 1;
        (grid.modules[row] as boolean[])[column] = dark;
        bit += 1;
      }
    }
    upward = !upward;
  }
}

/** The spec's four penalty rules. Lower is better; the encoder picks the lowest. */
function penalty(grid: Grid): number {
  const { modules, n } = grid;
  let score = 0;

  // Rule 1: runs of five or more of one colour, in each direction.
  for (const byRow of [true, false]) {
    for (let a = 0; a < n; a += 1) {
      let run = 1;
      for (let b = 1; b < n; b += 1) {
        const current = byRow ? (modules[a] as boolean[])[b] : (modules[b] as boolean[])[a];
        const previous = byRow ? (modules[a] as boolean[])[b - 1] : (modules[b - 1] as boolean[])[a];
        if (current === previous) {
          run += 1;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else run = 1;
      }
    }
  }

  // Rule 2: 2x2 blocks of one colour.
  for (let r = 0; r < n - 1; r += 1) {
    for (let c = 0; c < n - 1; c += 1) {
      const v = (modules[r] as boolean[])[c];
      if (
        v === (modules[r] as boolean[])[c + 1] &&
        v === (modules[r + 1] as boolean[])[c] &&
        v === (modules[r + 1] as boolean[])[c + 1]
      ) {
        score += 3;
      }
    }
  }

  // Rule 3: the finder-like 1:1:3:1:1 pattern with four light modules either side.
  const PATTERN = [true, false, true, true, true, false, true];
  const run = (cells: boolean[], at: number, length: number): boolean[] => cells.slice(at, at + length);
  const matches = (cells: boolean[]): boolean => {
    for (let i = 0; i < 7; i += 1) if (cells[i] !== PATTERN[i]) return false;
    return true;
  };
  for (const byRow of [true, false]) {
    for (let a = 0; a < n; a += 1) {
      const line: boolean[] = [];
      for (let b = 0; b < n; b += 1) {
        line.push((byRow ? (modules[a] as boolean[])[b] : (modules[b] as boolean[])[a]) as boolean);
      }
      for (let b = 0; b + 7 <= n; b += 1) {
        if (!matches(run(line, b, 7))) continue;
        const before = line.slice(Math.max(0, b - 4), b);
        const after = line.slice(b + 7, b + 11);
        if ((before.length === 4 && before.every((x) => !x)) || (after.length === 4 && after.every((x) => !x))) {
          score += 40;
        }
      }
    }
  }

  // Rule 4: deviation from an even split of dark and light.
  let dark = 0;
  for (const row of modules) for (const cell of row) if (cell) dark += 1;
  const percent = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

export interface QrMatrix {
  /** `true` is a dark module. Row-major, `size` by `size`. */
  modules: boolean[][];
  size: number;
  version: number;
  mask: number;
}

/**
 * Encodes `text` as a QR matrix.
 *
 * Throws rather than truncating when the text will not fit: a truncated QR scans perfectly and
 * yields the wrong string, which for an `otpauth://` secret means an authenticator that produces
 * codes nobody accepts and no indication why.
 */
export function encodeQr(text: string): QrMatrix {
  const byteLength = new TextEncoder().encode(text).length;
  const version = chooseVersion(byteLength);
  if (version === null) {
    throw new Error(`${byteLength} bytes will not fit in a version-10 level-M QR (max ${dataCapacity(10)}).`);
  }

  const codewords = interleave(dataCodewords(text, version), version);

  let best: QrMatrix | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let mask = 0; mask < 8; mask += 1) {
    const grid = blank(version);
    functionPatterns(grid, version);
    placeData(grid, codewords);

    const rule = MASKS[mask] as (row: number, column: number) => boolean;
    for (let r = 0; r < grid.n; r += 1) {
      for (let c = 0; c < grid.n; c += 1) {
        if ((grid.reserved[r] as boolean[])[c]) continue;
        if (rule(r, c)) (grid.modules[r] as boolean[])[c] = !(grid.modules[r] as boolean[])[c];
      }
    }
    writeFormat(grid, mask);

    const score = penalty(grid);
    if (score < bestScore) {
      bestScore = score;
      best = { modules: grid.modules, size: grid.n, version, mask };
    }
  }

  if (best === null) throw new Error("No mask was produced, which cannot happen.");
  return best;
}

/**
 * The matrix as an SVG string, with the quiet zone the standard requires.
 *
 * One `<path>` of rectangles rather than a `<rect>` per module: a version-7 QR is 45×45, so the
 * naive form is two thousand elements in the DOM for a decoration.
 */
export function qrSvg(text: string, { scale = 6, quiet = 4 } = {}): string {
  const qr = encodeQr(text);
  const span = qr.size + quiet * 2;

  let path = "";
  for (let r = 0; r < qr.size; r += 1) {
    for (let c = 0; c < qr.size; c += 1) {
      if ((qr.modules[r] as boolean[])[c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}" width="${span * scale}" `,
    `height="${span * scale}" shape-rendering="crispEdges" role="img" aria-label="QR">`,
    `<rect width="${span}" height="${span}" fill="#ffffff"/>`,
    `<path d="${path}" fill="#000000"/>`,
    "</svg>",
  ].join("");
}
