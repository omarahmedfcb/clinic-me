// Orders one appointment's status changes by their own chain: each toStatus is the next fromStatus.
// Changes in one transaction share a timestamp and their ids carry no order; the chain is the truth.
export interface ChainLink {
  fromStatus: string | null;
  toStatus: string | null;
}

/** The changes in causal order, or null when they do not form exactly one chain. */
export function orderByChain<T extends ChainLink>(events: readonly T[]): T[] | null {
  const remaining = [...events];
  const starts = remaining.filter((e) => !remaining.some((o) => o !== e && o.toStatus === e.fromStatus));
  if (starts.length !== 1) return remaining.length === 0 ? [] : null;

  const ordered = [starts[0]!];
  remaining.splice(remaining.indexOf(starts[0]!), 1);
  while (remaining.length > 0) {
    const next = remaining.filter((e) => e.fromStatus === ordered.at(-1)!.toStatus);
    if (next.length !== 1) return null;
    ordered.push(next[0]!);
    remaining.splice(remaining.indexOf(next[0]!), 1);
  }
  return ordered;
}
