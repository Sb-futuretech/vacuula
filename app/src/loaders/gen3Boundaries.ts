import { GEN3_COMMANDS } from '../http/gen3'
import type { NoGoLine, Zone } from '../components/map/types'
import { decodeRobotText } from '../utils/robotText'

export type Boundaries = (NoGoLine | Zone)[]

// "serial:mapId" -> boundaries
export const gen3Boundaries: Record<string, Boundaries> = {}
const k = (serial: string, mapId: string) => `${serial}:${mapId}`

// fetch one map from the robot and save it in the cache
export async function fetchGen3MapBoundaries(serial: string, mapId: string) {
    const res = await GEN3_COMMANDS.getMapBoundaries(serial, mapId)
    gen3Boundaries[k(serial, mapId)] = (res.data.data.boundaries ?? [])
        .map(b => b.name ? { ...b, name: decodeRobotText(b.name) } : b)
    return gen3Boundaries[k(serial, mapId)]
}

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