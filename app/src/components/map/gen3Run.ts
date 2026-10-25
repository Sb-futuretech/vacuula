import type { Point, Zone } from './types'

// What a gen3 run's map holds, checked on a D7: the RunMap is a thin track of the robot's centre on
// a background of 128, plus 4x4 marker blocks: 100 = dock (only in runs that completed), 200 and 150
// = most likely start and end position. Every run has its own map id and its own grid: the part of
// the stored map it reached (smaller with doors closed). FloorMap cells: 1 = free, 2 = wall.

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

// ---- placing a run on its stored map ------------------------------------------------------------
const FREE = 1
const WALL = 2
const BLOCK = 4 // cells per block in the coarse search
const FINE_RANGE = BLOCK + 2 // cells searched around the coarse result
const MIN_WALL_MATCH = 0.6 // share of the run's walls that must land on stored walls
const MAX_FREE_ON_WALL = 0.03 // share of the run's free floor that may land on stored walls

export interface Grid { cells: number[], width: number, height: number }

// cells (or BLOCK-sized blocks) that are walls, optionally widened by `grow` in every direction
function wallMask({ cells, width, height }: Grid, block: number, grow: number) {
    const w = Math.ceil(width / block), h = Math.ceil(height / block)
    const mask = new Uint8Array(w * h)
    for (let i = 0; i < cells.length; i++) {
        if (cells[i] !== WALL) continue
        const x = Math.floor((i % width) / block), y = Math.floor(Math.floor(i / width) / block)
        for (let dy = -grow; dy <= grow; dy++)
            for (let dx = -grow; dx <= grow; dx++) {
                const gx = x + dx, gy = y + dy
                if (gx >= 0 && gy >= 0 && gx < w && gy < h) mask[gy * w + gx] = 1
            }
    }
    return { mask, w, h }
}

function wallPoints(grid: Grid, block: number): [number, number][] {
    const { mask, w } = wallMask(grid, block, 0)
    const points: [number, number][] = []
    mask.forEach((m, i) => { if (m) points.push([i % w, Math.floor(i / w)]) })
    return points
}

function bestOffset(points: [number, number][], target: { mask: Uint8Array, w: number, h: number },
    xs: [number, number], ys: [number, number]) {
    let best = { dx: 0, dy: 0, hits: -1 }
    for (let dy = ys[0]; dy <= ys[1]; dy++)
        for (let dx = xs[0]; dx <= xs[1]; dx++) {
            let hits = 0
            for (const [x, y] of points) {
                const tx = x + dx, ty = y + dy
                if (tx >= 0 && ty >= 0 && tx < target.w && ty < target.h && target.mask[ty * target.w + tx]) hits++
            }
            if (hits > best.hits) best = { dx, dy, hits }
        }
    return best
}

// Where a run's grid lies in its stored map's grid (stored cell = run cell + offset), found by laying
// the run's walls over the stored map's walls; undefined if they do not fit well enough. Both grids
// are assumed to have the same scale and orientation.
export function alignToStored(run: Grid, stored: Grid): { dx: number, dy: number } | undefined {
    const runPoints = wallPoints(run, 1)
    if (runPoints.length === 0) return undefined
    // coarse: blocks, over every overlap of the two grids
    const coarse = bestOffset(wallPoints(run, BLOCK), wallMask(stored, BLOCK, 1),
        [-Math.ceil(run.width / BLOCK), Math.ceil(stored.width / BLOCK)],
        [-Math.ceil(run.height / BLOCK), Math.ceil(stored.height / BLOCK)])
    // fine: cells, around the coarse result
    const cx = coarse.dx * BLOCK, cy = coarse.dy * BLOCK
    const exact = wallMask(stored, 1, 0)
    const { dx, dy } = bestOffset(runPoints, exact, [cx - FINE_RANGE, cx + FINE_RANGE], [cy - FINE_RANGE, cy + FINE_RANGE])
    return fits(run, stored, dx, dy) ? { dx, dy } : undefined
}

// enough of the run's walls lie on stored walls (one cell off is fine), and hardly any of its free
// floor lies on a stored wall
function fits(run: Grid, stored: Grid, dx: number, dy: number) {
    const near = wallMask(stored, 1, 1)
    let walls = 0, wallHits = 0, free = 0, freeOnWall = 0
    for (let i = 0; i < run.cells.length; i++) {
        const v = run.cells[i]
        if (v !== WALL && v !== FREE) continue
        const sx = i % run.width + dx, sy = Math.floor(i / run.width) + dy
        if (sx < 0 || sy < 0 || sx >= stored.width || sy >= stored.height) continue
        const s = sy * stored.width + sx
        if (v === WALL) { walls++; wallHits += near.mask[s] }
        else { free++; if (stored.cells[s] === WALL) freeOnWall++ }
    }
    return walls > 0 && wallHits >= walls * MIN_WALL_MATCH && freeOnWall <= free * MAX_FREE_ON_WALL
}

// run id -> its offset on its stored map (runs never change, aligning takes a moment)
const runOffsets: Record<string, { dx: number, dy: number } | null> = {}
export function runOffset(runId: string, run: Grid, stored: Grid) {
    if (!(runId in runOffsets)) runOffsets[runId] = alignToStored(run, stored) ?? null
    return runOffsets[runId] ?? undefined
}

// a stored map's zone, moved into a run's grid (normalised vertices of both)
export function zoneInRun(zone: Zone, offset: { dx: number, dy: number }, stored: Grid, run: Grid): Zone {
    return {
        ...zone,
        vertices: zone.vertices.map(([x, y]): Point => [(x * stored.width - offset.dx) / run.width, (y * stored.height - offset.dy) / run.height]),
    }
}
