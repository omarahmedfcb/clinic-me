// Types for drug-catalogue-rows.mjs, which stays plain JavaScript so the generator runs with bare node.

type Damaged = Readonly<Record<string, readonly string[]>>;
type Corrections = Readonly<Record<string, Readonly<Record<string, readonly [string, string]>>>>;
type Touched = { drug: string; field: string };

export const KNOWN_DAMAGED: Damaged;
export const KNOWN_CORRECTIONS: Corrections;

export function isMangled(value: string): boolean;

export function buildRows(
  drugs: readonly Record<string, unknown>[],
  knownDamaged?: Damaged,
  knownCorrections?: Corrections,
): { rows: string[]; blanked: Touched[]; corrected: Touched[] };
