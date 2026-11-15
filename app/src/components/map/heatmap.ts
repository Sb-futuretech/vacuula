import { useEffect, useState } from 'react'
import { Http, type RunCoverage } from '../../http'
import { cleaningLoader, persistentMapLoader } from '../../loaders/resources'
import { decodeRLE } from './utils'
import { GEN3_MM_PER_CELL, GEN3_RUN_DOCK, GEN3_RUN_NOT_PATH, ROBOT_RADIUS_MM, basePoint, cellsCentre, runOffset, sameFloorDistance } from './gen3Run'
import type { Neato } from '../../types'

const ROBOT_RADIUS_CELLS = ROBOT_RADIUS_MM / GEN3_MM_PER_CELL
// runs whose files are fetched at the same time while the heatmap is built
const FETCH_AT_ONCE = 6

export interface Heatmap {
    counts: Uint16Array // per cell: in how many of the runs it was covered
    floor: number[] // the stored map's cells (1 = free), to mark free floor no run reached
    runs: number // runs that went into the counts
    blackBoxRuns: number // of them, runs counted from their black box track (brush width) instead of the RunMap
    width: number
    height: number
}

// a run's black box coverage (gen3, track.json): kept per run, runs never change; null when it has none
const blackBoxCache = new Map<string, RunCoverage | null>()
async function blackBoxCoverage(serial: string, runId: string): Promise<RunCoverage | null> {
    if (!blackBoxCache.has(runId)) {
        const coverage = await Http.getRunTrack(serial, runId).then(res => res.data.coverage ?? null).catch(() => null)
        // a missing track may still come (the run is being saved): don't keep "none" for good
        if (coverage) blackBoxCache.set(runId, coverage)
        return coverage
    }
    return blackBoxCache.get(runId) ?? null
}

// cell offsets of a disc with the robot's radius
const DISC: [number, number][] = []
for (let dy = -Math.ceil(ROBOT_RADIUS_CELLS); dy <= Math.ceil(ROBOT_RADIUS_CELLS); dy++)
    for (let dx = -Math.ceil(ROBOT_RADIUS_CELLS); dx <= Math.ceil(ROBOT_RADIUS_CELLS); dx++)
        if (dx * dx + dy * dy <= ROBOT_RADIUS_CELLS * ROBOT_RADIUS_CELLS) DISC.push([dx, dy])

// Coverage of the stored map `mapId` over its last `maxRuns` gen3 runs: a run counts if it reports
// this map (placed by its walls, it may cover only part of it), or, for older runs, if it shares the
// map's grid (its dock block near the map's dock). A run with a black box track counts with what it
// cleaned by that (the brush width around its real way); others with their RunMap path widened to the
// robot's size. Both limited to free floor, like the home page's covered area.
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
            let blackBoxRuns = 0
            // the runs that may lie on this map, newest first; their files are fetched FETCH_AT_ONCE at a
            // time (one after the other took seconds over a VPN or a phone's WLAN: nearly all of the time
            // was waiting for answers, not computing), then counted in order until maxRuns
            const candidates = cleanings.filter(c => !c.run.persistent_map_id || c.run.persistent_map_id === mapId)
            // first the small files that tell whether a run lies on this map (its run map, and its floor to
            // align it); the big black box track (up to 120 KB) only for the runs that do
            const fetchRun = (cleaning: Neato.Gen3.CleaningRun) => Promise.all([
                cached(cleaningLoader.peek(serial, cleaning.id), () => cleaningLoader.request(serial, cleaning.id)),
                cleaning.run.persistent_map_id ? floorOf(cleaning.id) : undefined,
            ])
            for (let start = 0; start < candidates.length && runs < maxRuns && !cancelled; start += FETCH_AT_ONCE) {
                const batch = candidates.slice(start, start + FETCH_AT_ONCE)
                const fetched = await Promise.all(batch.map(fetchRun))
                // which of them lie on this map, and where: runs that name the map only cover the part
                // they reached and are aligned by their walls; older runs must share the grid
                const placed = batch.map((cleaning, n) => {
                    const [runMap, runFloor] = fetched[n]
                    if (!runMap) return null
                    const path = decodeRLE(runMap.rle)
                    let offset: { dx: number, dy: number } | undefined
                    if (cleaning.run.persistent_map_id) {
                        if (runFloor) offset = runOffset(cleaning.id, () => ({ cells: decodeRLE(runFloor.rle), width: runFloor.width, height: runFloor.height }),
                            () => ({ cells: floor, width, height }))
                    } else {
                        const own = { width: runMap.width, height: runMap.height, dock: cellsCentre(path, runMap.width, runMap.height, GEN3_RUN_DOCK) }
                        if (sameFloorDistance(own, storedFloor) !== null) offset = { dx: 0, dy: 0 }
                    }
                    return offset ? { cleaning, runMap, path, offset } : null
                }).filter(p => p !== null).slice(0, maxRuns - runs)
                // their black box tracks, together
                const tracks = await Promise.all(placed.map(p => blackBoxCoverage(serial, p.cleaning.id)))
                if (cancelled) break

                placed.forEach(({ runMap, path, offset }, n) => {
                    covered.fill(0)
                    const bb = tracks[n]
                    if (bb?.cleaned && bb.width === runMap.width) {
                        // what it cleaned by its black box track, cells of the run map
                        let i = 0
                        for (const [value, count] of bb.cleaned) {
                            if (value === 1) for (let k = i; k < i + count; k++) {
                                const cx = k % runMap.width + offset.dx, cy = Math.floor(k / runMap.width) + offset.dy
                                if (cx < 0 || cy < 0 || cx >= width || cy >= height) continue
                                const c = cy * width + cx
                                if (floor[c] === 1) covered[c] = 1
                            }
                            i += count
                        }
                        blackBoxRuns++
                    } else {
                        // its RunMap path, widened to the robot's size
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
                    }
                    for (let c = 0; c < covered.length; c++) counts[c] += covered[c]
                    runs++
                })
            }
            if (!cancelled) setHeatmap({ counts, floor, runs, blackBoxRuns, width, height })
        })()
            .catch(err => console.error('Failed to build the coverage heatmap', err))
            .finally(() => { if (!cancelled) setLoading(false) })
        return () => { cancelled = true }
    }, [serial, mapId, enabled, maxRuns])

    return { heatmap, loading }
}
