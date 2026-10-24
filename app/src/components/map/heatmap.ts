import { useEffect, useState } from 'react'
import { Http } from '../../http'
import { cleaningLoader, persistentMapLoader } from '../../loaders/resources'
import { decodeRLE } from './utils'
import { GEN3_RUN_NOT_PATH } from './useMap'
import type { Neato } from '../../types'

// robot radius in map cells, with the same 40 mm per cell assumption as drawCoverage
const ROBOT_RADIUS_CELLS = 165 / 40
// a run whose dock block lies further than this (cells) from the map's dock was on another floor
const SAME_DOCK_CELLS = 10
const GEN3_RUN_DOCK = 100

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

const xy = (base: unknown): [number, number] =>
    Array.isArray(base) ? [base[0], base[1]] : [(base as any)?.x, (base as any)?.y]

// Coverage of the stored map `mapId` over its last `maxRuns` gen3 runs: a run counts if it has the
// map's grid size and (when it has a dock block) its dock where the map's dock is. Each run's path is
// widened to the robot's size and limited to free floor, like the home page's covered area.
export function useCoverageHeatmap(serial: string, mapId: string | undefined, enabled: boolean, maxRuns: number) {
    const [heatmap, setHeatmap] = useState<Heatmap>()
    const [loading, setLoading] = useState(false)

    useEffect(() => {
        setHeatmap(undefined)
        if (!enabled || !mapId) return
        let cancelled = false
        setLoading(true)
        ;(async () => {
            const stored = await persistentMapLoader.request(serial, mapId)
            const { width, height } = stored
            const floor = decodeRLE(stored.rle)
            const [baseX, baseY] = xy(stored.base)
            const counts = new Uint16Array(width * height)
            const covered = new Uint8Array(width * height)

            const cleanings = ((await Http.getCleanings(serial)).data as Neato.Gen3.CleaningRun[])
                .sort((a, b) => b.run.start_at.localeCompare(a.run.start_at))
            let runs = 0
            for (const cleaning of cleanings) {
                if (cancelled || runs >= maxRuns) break
                const runFloor = await persistentMapLoader.request(serial, cleaning.id).catch(() => undefined)
                if (!runFloor || runFloor.width !== width || runFloor.height !== height) continue
                const runMap = await cleaningLoader.request(serial, cleaning.id).catch(() => undefined)
                if (!runMap) continue
                const path = decodeRLE(runMap.rle)
                if (path.length !== width * height) continue

                // dock block of the run, to rule out a different floor with the same grid size
                let dx = 0, dy = 0, dn = 0
                for (let i = 0; i < path.length; i++) if (path[i] === GEN3_RUN_DOCK) { dx += i % width; dy += Math.floor(i / width); dn++ }
                if (dn && Math.hypot(dx / dn - baseX * width, dy / dn - baseY * height) > SAME_DOCK_CELLS) continue

                covered.fill(0)
                for (let i = 0; i < path.length; i++) {
                    if (path[i] === 0 || GEN3_RUN_NOT_PATH.has(path[i])) continue
                    const x = i % width, y = Math.floor(i / width)
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
