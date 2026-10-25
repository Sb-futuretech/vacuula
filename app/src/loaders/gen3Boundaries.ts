import { GEN3_COMMANDS } from '../http/gen3'
import type { NoGoLine, Zone } from '../components/map/types'
import { decodeRobotText } from '../utils/robotText'

export type Boundaries = (NoGoLine | Zone)[]

// "serial:mapId" -> boundaries
export const gen3Boundaries: Record<string, Boundaries> = {}
const k = (serial: string, mapId: string) => `${serial}:${mapId}`
// concurrent requests for one map share a single robot command (the robot answers parallel
// getMapBoundaries for the same map with command_not_found)
const inFlight: Record<string, Promise<Boundaries>> = {}

// fetch one map from the robot and save it in the cache
export function fetchGen3MapBoundaries(serial: string, mapId: string) {
    const key = k(serial, mapId)
    inFlight[key] ??= GEN3_COMMANDS.getMapBoundaries(serial, mapId)
        .then(res => gen3Boundaries[key] = (res.data.data.boundaries ?? [])
            .map(b => b.name ? { ...b, name: decodeRobotText(b.name) } : b))
        .finally(() => delete inFlight[key])
    return inFlight[key]
}

// the cached boundaries, fetched only if there are none yet
export const getGen3MapBoundaries = (serial: string, mapId: string) =>
    gen3Boundaries[k(serial, mapId)] ? Promise.resolve(gen3Boundaries[k(serial, mapId)]) : fetchGen3MapBoundaries(serial, mapId)

// fetch all maps one at a time, skipping the ones already cached
export async function fetchAllGen3Boundaries(serial: string, maps: { id: string }[]) {
    for (const map of maps) {
        if (gen3Boundaries[k(serial, map.id)]) continue
        try {
            await fetchGen3MapBoundaries(serial, map.id)
        } catch (err) {
            console.error('Failed to fetch boundaries for map', map.id, err)
        }
    }
}

export const getCachedZones = (serial: string, mapId: string): Zone[] =>
    (gen3Boundaries[k(serial, mapId)] ?? []).filter((b): b is Zone => b.type === 'polygon')