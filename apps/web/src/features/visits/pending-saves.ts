
import { useEffect, useRef } from "react";

type PendingSave = () => Promise<boolean>;

const pending = new Map<string, Set<PendingSave>>();

function register(visitId: string, save: PendingSave): () => void {
    const saves = pending.get(visitId) ?? new Set<PendingSave>();
    saves.add(save);
    pending.set(visitId, saves);
    return () => {
        saves.delete(save);
        if (saves.size === 0) pending.delete(visitId);
    };
}

/** Saves what this visit's sections still hold. False when any of them could not be saved. */
export async function runPendingSaves(visitId: string): Promise<boolean> {
    const saves = [...(pending.get(visitId) ?? [])];
    const results = await Promise.all(saves.map((save) => save()));
    return results.every(Boolean);
}

/** `saveIfChanged` must return true when there was nothing to save or the save worked. */
export function usePendingSave(visitId: string, saveIfChanged: PendingSave): void {
    const latest = useRef(saveIfChanged);
    latest.current = saveIfChanged;
    useEffect(() => register(visitId, () => latest.current()), [visitId]);
}