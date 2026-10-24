// What a gen3 run's map holds, checked on a D7: the RunMap is a thin track of the robot's centre on
// a background of 128, plus 4x4 marker blocks: 100 = dock (only in runs that completed), 200 and 150
// = most likely start and end position. Every run has its own map id; runs on a stored map share
// that map's grid.

export const GEN3_RUN_BACKGROUND = 128
export const GEN3_RUN_DOCK = 100
export const GEN3_RUN_START = 200
export const GEN3_RUN_END = 150
export const GEN3_RUN_NOT_PATH = new Set([GEN3_RUN_BACKGROUND, GEN3_RUN_DOCK, GEN3_RUN_END, GEN3_RUN_START])

// Gen3 maps carry no resolution; the app assumes 40 mm per map cell everywhere
export const GEN3_MM_PER_CELL = 40
export const ROBOT_RADIUS_MM = 165

// a run whose dock lies further than this (in cells) from a stored map's dock was on another floor
const SAME_FLOOR_CELLS = 10

export type NormPoint = [number, number]

// centre of all cells with `value`, normalised to the grid; undefined if there are none
export function cellsCentre(cells: number[], width: number, height: number, value: number): NormPoint | undefined {
    let sumX = 0, sumY = 0, n = 0
    for (let i = 0; i < cells.length; i++) {
        if (cells[i] !== value) continue
        sumX += i % width
        sumY += Math.floor(i / width)
        n++
    }
    return n ? [(sumX / n + 0.5) / width, (sumY / n + 0.5) / height] : undefined
}

// a stored gen3 base, sent as [x, y] or { x, y } (normalised)
export function basePoint(base: unknown): NormPoint | undefined {
    const [x, y] = Array.isArray(base) ? base : [(base as any)?.x, (base as any)?.y]
    return typeof x === 'number' && typeof y === 'number' ? [x, y] : undefined
}

interface Floor { width: number, height: number, dock?: NormPoint }

// How far apart two maps' docks are (in cells) if they can be the same floor, else null: the grid
// size has to match and, when both docks are known, they must lie close together.
export function sameFloorDistance(a: Floor, b: Floor): number | null {
    if (a.width !== b.width || a.height !== b.height) return null
    if (!a.dock || !b.dock) return 0
    const distance = Math.hypot((a.dock[0] - b.dock[0]) * a.width, (a.dock[1] - b.dock[1]) * a.height)
    return distance <= SAME_FLOOR_CELLS ? distance : null
}
