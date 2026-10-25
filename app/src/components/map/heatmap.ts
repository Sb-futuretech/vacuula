import { useEffect, useState } from 'react'
import { Http } from '../../http'
import { cleaningLoader, persistentMapLoader } from '../../loaders/resources'
import { decodeRLE } from './utils'
import { GEN3_MM_PER_CELL, GEN3_RUN_DOCK, GEN3_RUN_NOT_PATH, ROBOT_RADIUS_MM, basePoint, cellsCentre, runOffset, sameFloorDistance } from './gen3Run'
import type { Neato } from '../../types'

const ROBOT_RADIUS_CELLS = ROBOT_RADIUS_MM / GEN3_MM_PER_CELL

export interface Heatmap {
    counts: Uint16Array // per cell: in how many of the runs it was covered
    floor: number[] // the stored map's cells (1 = free), to mark free floor no run reached
    runs: number // runs that went into the counts
    width: number
    height: number
}

// cell offsets of a disc with the robot's radius
const DISC: [number, number][] = []
for (let dy = -Math.ceil(ROBOT_RADIUS_CELLS); dy <= Math.ceil(ROBOT_RADIUS_CELLS); dy++)
    for (let dx = -Math.ceil(ROBOT_RADIUS_CELLS); dx <= Math.ceil(ROBOT_RADIUS_CELLS); dx++)
        if (dx * dx + dy * dy <= ROBOT_RADIUS_CELLS * ROBOT_RADIUS_CELLS) DISC.push([dx, dy])

// Coverage of the stored map `mapId` over its last `maxRuns` gen3 runs: a run counts if it reports
// this map (placed by its walls, it may cover only part of it), or, for older runs, if it shares the
// map's grid (its dock block near the map's dock). Each run's path is widened to the robot's size and
// limited to free floor, like the home page's covered area.
export function useCoverageHeatmap(serial: string, mapId: string | undefined, enabled: boolean, maxRuns: number) {
    const [heatmap, setHeatmap] = useState<Heatmap>()
    const [loading, setLoading] = useState(false)

    useEffect(() => {
        setHeatmap(undefined)
        setLoading(false) // a cancelled earlier build leaves it on
        if (!enabled || !mapId) return
        let cancelled = false
        setLoading(true)
        ;(async () => {
            // runs never change: take what was loaded before instead of downloading every run again
            const cached = <T,>(peek: T | undefined, request: () => Promise<T>) => peek !== undefined ? Promise.resolve(peek) : request().catch(() => undefined)
            const floorOf = (id: string) => cached(persistentMapLoader.peek(serial, id), () => persistentMapLoader.request(serial, id))
            const stored = await floorOf(mapId)
            if (!stored) return
            const { width, height } = stored
            const floor = decodeRLE(stored.rle)
            const storedFloor = { width, height, dock: basePoint(stored.base) }
            const counts = new Uint16Array(width * height)
            const covered = new Uint8Array(width * height)

            const cleanings = ((await Http.getCleanings(serial)).data as Neato.Gen3.CleaningRun[])
                .sort((a, b) => b.run.start_at.localeCompare(a.run.start_at))
            let runs = 0
            for (const cleaning of cleanings) {
                if (cancelled || runs >= maxRuns) break
                const reportedMap = cleaning.run.persistent_map_id
                if (reportedMap && reportedMap !== mapId) continue
                const runMap = await cached(cleaningLoader.peek(serial, cleaning.id), () => cleaningLoader.request(serial, cleaning.id))
                if (!runMap) continue
                const path = decodeRLE(runMap.rle)

                // where the run's grid lies on the stored map: runs that name the map only cover the
                // part they reached and are aligned by their walls; older runs must share the grid
                let offset: { dx: number, dy: number } | undefined
                if (reportedMap) {
                    const runFloor = await floorOf(cleaning.id)
                    if (runFloor) offset = runOffset(cleaning.id, { cells: decodeRLE(runFloor.rle), width: runFloor.width, height: runFloor.height }, { cells: floor, width, height })
                } else {
                    const runFloor = { width: runMap.width, height: runMap.height, dock: cellsCentre(path, runMap.width, runMap.height, GEN3_RUN_DOCK) }
                    if (sameFloorDistance(runFloor, storedFloor) !== null) offset = { dx: 0, dy: 0 }
                }
                if (!offset) continue

                covered.fill(0)
                for (let i = 0; i < path.length; i++) {
                    if (path[i] === 0 || GEN3_RUN_NOT_PATH.has(path[i])) continue
                    const x = i % runMap.width + offset.dx, y = Math.floor(i / runMap.width) + offset.dy
                    for (const [ox, oy] of DISC) {
                        const cx = x + ox, cy = y + oy
                        if (cx < 0 || cy < 0 || cx >= width || cy >= height) continue
                        const c = cy * width + cx
                        if (floor[c] === 1) covered[c] = 1
                    }
                }
                for (let c = 0; c < covered.length; c++) counts[c] += covered[c]
                runs++
            }
            if (!cancelled) setHeatmap({ counts, floor, runs, width, height })
        })()
            .catch(err => console.error('Failed to build the coverage heatmap', err))
            .finally(() => { if (!cancelled) setLoading(false) })
        return () => { cancelled = true }
    }, [serial, mapId, enabled, maxRuns])

    return { heatmap, loading }
}
