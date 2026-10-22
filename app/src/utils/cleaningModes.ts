import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { Neato } from '../types'

// Cleaning/navigation mode picked by the user, shared between pages (home, map)
// and persisted per robot so it survives reloads.
export interface CleaningModes {
    gen3Mode: Neato.Gen3.CleaningMode
    gen3Navigation: Neato.Gen3.CleaningNavigationMode
    gen4Mode: Neato.Gen4.CleaningMode
    gen4Navigation: Neato.Gen4.CleaningNavigationMode
}

export const DEFAULT_CLEANING_MODES: CleaningModes = {
    gen3Mode: Neato.Gen3.CleaningMode.ECO,
    gen3Navigation: Neato.Gen3.CleaningNavigationMode.NORMAL,
    gen4Mode: Neato.Gen4.CleaningMode.ECO,
    gen4Navigation: Neato.Gen4.CleaningNavigationMode.NORMAL,
}

const storageKey = (serial: string) => `vacuula.cleaningModes.${serial}`

function readRaw(serial: string): string | null {
    try {
        return localStorage.getItem(storageKey(serial))
    } catch {
        return null
    }
}

function parse(raw: string | null): CleaningModes {
    if (!raw) return DEFAULT_CLEANING_MODES
    try {
        const modes: CleaningModes = { ...DEFAULT_CLEANING_MODES, ...JSON.parse(raw) }
        // Gen3 rejects Deep + Eco, never hand out that combination
        if (modes.gen3Navigation === Neato.Gen3.CleaningNavigationMode.DEEP && modes.gen3Mode === Neato.Gen3.CleaningMode.ECO)
            modes.gen3Mode = Neato.Gen3.CleaningMode.NORMAL
        return modes
    } catch {
        return DEFAULT_CLEANING_MODES
    }
}

const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
}

export function setCleaningModes(serial: string, patch: Partial<CleaningModes>) {
    const next = { ...parse(readRaw(serial)), ...patch }
    try { localStorage.setItem(storageKey(serial), JSON.stringify(next)) } catch { /* storage unavailable */ }
    listeners.forEach(fn => fn())
}

export function useCleaningModes(serial: string) {
    // snapshot is the raw string, so it is stable between renders when nothing changed
    const raw = useSyncExternalStore(subscribe, () => readRaw(serial))
    const modes = useMemo(() => parse(raw), [raw])
    const update = useCallback((patch: Partial<CleaningModes>) => setCleaningModes(serial, patch), [serial])
    return { ...modes, update }
}
