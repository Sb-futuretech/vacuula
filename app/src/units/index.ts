import { useCallback, useSyncExternalStore } from 'react'

// Measurement units shown in the app. Robots always work in metric internally
// (m² for area, cm for spot size); conversion happens only for display.
export type Units = 'metric' | 'imperial'

export const UNITS: Units[] = ['metric', 'imperial']
export const DEFAULT_UNITS: Units = 'metric'
export const UNITS_STORAGE_KEY = 'vacuula.units'

const SQM_TO_SQFT = 10.7639
const CM_TO_FT = 1 / 30.48

const isUnits = (value: string | null): value is Units => value === 'metric' || value === 'imperial'

export function getUnits(): Units {
    try {
        const stored = localStorage.getItem(UNITS_STORAGE_KEY)
        return isUnits(stored) ? stored : DEFAULT_UNITS
    } catch {
        return DEFAULT_UNITS
    }
}

const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
}

export function setUnits(units: Units) {
    try { localStorage.setItem(UNITS_STORAGE_KEY, units) } catch { /* storage unavailable */ }
    listeners.forEach(fn => fn())
}

const round = (value: number, decimals: number) => {
    const f = 10 ** decimals
    return Math.round(value * f) / f
}

/** Area given in m², formatted in the selected units, e.g. "12.3 m²" or "132 ft²". */
export function formatArea(squareMetres: number, units: Units = getUnits()): string {
    if (units === 'imperial') return `${round(squareMetres * SQM_TO_SQFT, 0)} ft²`
    return `${round(squareMetres, 1)} m²`
}

/** Area per minute given in m²/min, one more decimal than an area, e.g. "0.68 m²/min" or "7.3 ft²/min". */
export function formatAreaPerMinute(squareMetres: number, units: Units = getUnits()): string {
    if (units === 'imperial') return `${round(squareMetres * SQM_TO_SQFT, 1)} ft²/min`
    return `${round(squareMetres, 2)} m²/min`
}

/** Length given in cm, formatted in the selected units, e.g. "120 cm" or "3.9 ft". */
export function formatLength(centimetres: number, units: Units = getUnits()): string {
    if (units === 'imperial') return `${round(centimetres * CM_TO_FT, 1)} ft`
    return `${round(centimetres, 0)} cm`
}

export function useUnits() {
    const units = useSyncExternalStore(subscribe, getUnits, () => DEFAULT_UNITS)
    const set = useCallback((u: Units) => setUnits(u), [])
    const area = useCallback((squareMetres: number) => formatArea(squareMetres, units), [units])
    const length = useCallback((centimetres: number) => formatLength(centimetres, units), [units])
    const areaPerMinute = useCallback((squareMetres: number) => formatAreaPerMinute(squareMetres, units), [units])
    return { units, setUnits: set, formatArea: area, formatLength: length, formatAreaPerMinute: areaPerMinute }
}
