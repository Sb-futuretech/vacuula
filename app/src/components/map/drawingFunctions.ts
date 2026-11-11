import { COLORS, DRAWING, readMapToken } from './constants'
import type { Zone, NoGoLine, Point } from './types'
import type { Problem } from '../../http'
import { normalizeHex, withAlpha } from './color'
import { GEN3_MM_PER_CELL, ROBOT_RADIUS_MM } from './gen3Run'
import { calcRelevancy } from './utils'
import dockUrl from '../../assets/dock.svg'

/* ---------------- SHAPE TYPES ---------------- */

export type CellShape = 'heart' | 'circle' | 'square'

/* ---------------- SHAPE CACHE ---------------- */

const SHAPE_CACHE = new Map<string, Path2D>()

function getShape(type: CellShape, size: number): Path2D {
    const key = `${type}:${size}`

    const cached = SHAPE_CACHE.get(key)
    if (cached) return cached

    const path = new Path2D()
    const s = size
    const cx = 0
    const cy = 0

    if (type === 'square') {
        path.rect(-s, -s, s * 2, s * 2)
    }
    
    else if (type === 'circle') {
        path.arc(cx, cy, s / 2, 0, Math.PI * 2)
    }

    else if (type === 'heart') {
        path.moveTo(cx, cy + s / 4)
        path.bezierCurveTo(
            cx - s / 2, cy - s / 4,
            cx - s, cy + s / 2,
            cx, cy + s
        )
        path.bezierCurveTo(
            cx + s, cy + s / 2,
            cx + s / 2, cy - s / 4,
            cx, cy + s / 4
        )
    }

    SHAPE_CACHE.set(key, path)
    return path
}

/* ---------------- VIEWPORT ---------------- */

function getVisibleBounds(
    canvas: HTMLCanvasElement,
    zoom: number,
    offset: { x: number; y: number }
) {
    return {
        minX: Math.floor((-offset.x) / zoom),
        minY: Math.floor((-offset.y) / zoom),
        maxX: Math.ceil((canvas.width - offset.x) / zoom),
        maxY: Math.ceil((canvas.height - offset.y) / zoom)
    }
}

/* ---------------- MAIN MAP ---------------- */
const GOLDEN_RATIO_CONJUGATE = 0.6180339887498949

// Deterministic, distinct color per raw path-map pixel value — same value
// always gets the same color, so we don't need to ship/parse runmap.json's
// "legend" on the frontend at all.
export function colorForPathValue(value: number): string {
    const hue = (value * GOLDEN_RATIO_CONJUGATE) % 1
    // Saturation / lightness come from the theme (--map-run-sat / --map-run-light
    // in theme.css) so dark and light mode can pick the tone that contrasts
    // best with their floor and surround. Fallback = the original dark-mode look.
    const sat = parseFloat(COLORS.RUN_SAT) || 75
    const light = parseFloat(COLORS.RUN_LIGHT) || 55
    return `hsl(${Math.round(hue * 360)}, ${sat}%, ${light}%)`
}

// Build the set of raw path-map values to skip when overlaying the run.
// `ignoreCount` = how many of the *lowest* distinct non-zero values to
// treat as noise (e.g. ignoreCount=1 hides whichever path value is
// smallest, ignoreCount=2 hides the two smallest, etc).
// Build the set of raw path-map values to skip when overlaying the run.
// `ignoreCount` = how many of the *highest* distinct non-zero values to
// treat as noise (e.g. ignoreCount=1 hides whichever path value is
// largest, ignoreCount=2 hides the two largest, etc).
export function computeIgnoredRunValues(runCells: number[] | null, ignoreCount: number): Set<number> {
    if (!runCells || ignoreCount <= 0) return new Set()

    const distinct = Array.from(new Set(runCells.filter(v => v !== 0))).sort((a, b) => b - a) // descending now
    return new Set(distinct.slice(0, ignoreCount))
}


interface RunOverlayOptions {
    getRunColor?: (value: number) => string
    ignoreRunValues?: Set<number>
    opacity?: number
}

export function drawMap(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    cells: number[],
    zoom: number,
    offset: { x: number; y: number },
    mapSize: { height: number, width: number },
    shape: CellShape = 'circle',
    runCells?: number[] | null,
    runOptions?: RunOverlayOptions,
    backgroundToken?: string
) {
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    // The map is drawn like an image: always on its own background so the
    // wall/floor colours keep the same contrast in every app theme.
    ctx.fillStyle = backgroundToken ? readMapToken(backgroundToken) : COLORS.BACKGROUND
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    const bounds = getVisibleBounds(canvas, zoom, offset)

    const startX = Math.max(0, bounds.minX)
    const startY = Math.max(0, bounds.minY)
    const endX = Math.min(mapSize.width, bounds.maxX)
    const endY = Math.min(mapSize.height, bounds.maxY)

    // Only trust the overlay if it's genuinely the same grid as the floor map.
    const hasRun = !!runCells && runCells.length === cells.length
    const getRunColor = runOptions?.getRunColor ?? colorForPathValue
    const ignoreRunValues = runOptions?.ignoreRunValues
    const runOpacity = runOptions?.opacity ?? (parseFloat(COLORS.RUN_OPACITY) || DRAWING.RUN_OVERLAY_OPACITY)

    const scale = zoom
    const ox = offset.x
    const oy = offset.y
    const size = Math.max(1, scale * 0.5)
    const floorSize = Math.max(1, scale * 0.45)
    const wallSize = Math.max(1.5, scale * 0.75)

    for (let y = startY; y < endY; y++) {
        const row = y * mapSize.width

        for (let x = startX; x < endX; x++) {
            const idx = row + x
            const floorValue = cells[idx]
            const cx = ox + x * scale + scale / 2
            const cy = oy + y * scale + scale / 2

            // 1. Floor map is ALWAYS drawn (unless truly unexplored) — this
            //    is the base layer regardless of whether a run is loaded.
            if (floorValue !== 0) {
                const isWall = floorValue !== 1
                ctx.fillStyle = isWall ? COLORS.WALL : COLORS.EMPTY
                ctx.save()
                ctx.translate(cx, cy)
                ctx.fill(getShape(shape, isWall ? wallSize : floorSize))
                ctx.restore()
            }

            // 2. Run/path overlay — blended on top at reduced opacity, never
            //    replacing the floor color outright.
            if (hasRun) {
                const runValue = runCells![idx]
                if (runValue !== 0 && !ignoreRunValues?.has(runValue)) {
                    ctx.save()
                    ctx.globalAlpha = runOpacity
                    ctx.fillStyle = getRunColor(runValue)
                    ctx.translate(cx, cy)
                    ctx.fill(getShape(shape, size))
                    ctx.restore()
                }
            }
        }
    }
}

// /* ---------------- GRID ---------------- */

// function drawGrid(
//     ctx: CanvasRenderingContext2D,
//     zoom: number,
//     offset: { x: number; y: number },
//     canvas: HTMLCanvasElement
// ) {
//     ctx.strokeStyle = COLORS.GRID
//     ctx.lineWidth = DRAWING.GRID_LINE_WIDTH

//     const bounds = getVisibleBounds(canvas, zoom, offset)

//     const startX = Math.max(0, bounds.minX)
//     const startY = Math.max(0, bounds.minY)
//     const endX = Math.min(mapData.width, bounds.maxX)
//     const endY = Math.min(mapData.height, bounds.maxY)

//     const ox = offset.x
//     const oy = offset.y

//     for (let y = startY; y <= endY; y++) {
//         ctx.beginPath()
//         ctx.moveTo(ox + startX * zoom, oy + y * zoom)
//         ctx.lineTo(ox + endX * zoom, oy + y * zoom)
//         ctx.stroke()
//     }

//     for (let x = startX; x <= endX; x++) {
//         ctx.beginPath()
//         ctx.moveTo(ox + x * zoom, oy + startY * zoom)
//         ctx.lineTo(ox + x * zoom, oy + endY * zoom)
//         ctx.stroke()
//     }
// }

/* ---------------- ZONES ---------------- */

function drawZone(
    ctx: CanvasRenderingContext2D,
    zone: Zone,
    zoom: number,
    offset: { x: number; y: number },
    mapSize: { height: number, width: number },
    outlineOnly = false, // no fill, so what lies below (coverage, heatmap) stays fully visible
) {
    if (zone.vertices.length < 3) return

    // Outline in the zone's colour; interior in the same colour at low alpha so
    // the floor cells stay visible. Both go through the colour helpers: an
    // invalid fillStyle would be silently ignored by the canvas and the
    // interior would keep whatever opaque colour was set before.
    const outline = normalizeHex(zone.color) ?? COLORS.LINE_COLOR
    ctx.fillStyle = withAlpha(zone.color, DRAWING.ZONE_FILL_ALPHA, COLORS.POLYGON_FILL)
    ctx.strokeStyle = outline

    const sx = mapSize.width * zoom
    const sy = mapSize.height * zoom

    ctx.beginPath()

    const first = zone.vertices[0]
    ctx.moveTo(offset.x + first[0] * sx, offset.y + first[1] * sy)

    for (let i = 1; i < zone.vertices.length; i++) {
        const p = zone.vertices[i]
        ctx.lineTo(offset.x + p[0] * sx, offset.y + p[1] * sy)
    }

    ctx.closePath()
    if (!outlineOnly) ctx.fill()
    ctx.stroke()
}

export function drawZones(
    ctx: CanvasRenderingContext2D,
    zones: Zone[],
    zoom: number,
    offset: { x: number; y: number },
    mapSize: { height: number, width: number },
    outlineOnly = false,
) {
    // ctx.fillStyle = COLORS.POLYGON_FILL
    // ctx.strokeStyle = COLORS.LINE_COLOR
    ctx.lineWidth = Math.max(DRAWING.MIN_LINE_WIDTH, zoom * DRAWING.POLYGON_LINE_WIDTH_SCALE)

    for (const p of zones) {
        drawZone(ctx, p, zoom, offset, mapSize, outlineOnly)
    }
}

/* ---------------- POLYLINES ---------------- */

function drawNoGoLine(
    ctx: CanvasRenderingContext2D,
    nogoLine: NoGoLine,
    zoom: number,
    offset: { x: number; y: number },
    mapSize: { height: number, width: number },
) {
    if (nogoLine.vertices.length < 2) return

    ctx.strokeStyle = normalizeHex(nogoLine.color) ?? COLORS.LINE_COLOR

    const sx = mapSize.width * zoom
    const sy = mapSize.height * zoom

    ctx.beginPath()

    const first = nogoLine.vertices[0]
    ctx.moveTo(offset.x + first[0] * sx, offset.y + first[1] * sy)

    for (let i = 1; i < nogoLine.vertices.length; i++) {
        const p = nogoLine.vertices[i]
        ctx.lineTo(offset.x + p[0] * sx, offset.y + p[1] * sy)
    }

    ctx.stroke()
}

export function drawNoGoLines(
    ctx: CanvasRenderingContext2D,
    nogoLines: NoGoLine[],
    zoom: number,
    offset: { x: number; y: number },
    mapSize: { height: number, width: number },
) {
    // ctx.strokeStyle = COLORS.LINE_COLOR
    ctx.lineWidth = Math.max(DRAWING.MIN_LINE_WIDTH, zoom * DRAWING.POLYLINE_LINE_WIDTH_SCALE)

    for (const p of nogoLines) {
        drawNoGoLine(ctx, p, zoom, offset, mapSize)
    }
}

/* ---------------- IN PROGRESS ---------------- */

export function drawInProgressPolyline(
    ctx: CanvasRenderingContext2D,
    pts: Point[],
    zoom: number,
    offset: { x: number; y: number },
    mapSize: { height: number, width: number },
    selected: number = pts.length - 1,
) {
    if (!pts.length) return

    const sx = mapSize.width * zoom
    const sy = mapSize.height * zoom

    ctx.strokeStyle = COLORS.IN_PROGRESS
    ctx.lineWidth = Math.max(DRAWING.MIN_LINE_WIDTH, zoom * DRAWING.IN_PROGRESS_LINE_WIDTH_SCALE)

    if (pts.length > 1) {
        ctx.beginPath()

        const first = pts[0]
        ctx.moveTo(offset.x + first[0] * sx, offset.y + first[1] * sy)

        for (let i = 1; i < pts.length; i++) {
            const p = pts[i]
            ctx.lineTo(offset.x + p[0] * sx, offset.y + p[1] * sy)
        }

        ctx.stroke()
    }

    ctx.fillStyle = COLORS.IN_PROGRESS

    for (const p of pts) {
        ctx.beginPath()
        ctx.arc(
            offset.x + p[0] * sx,
            offset.y + p[1] * sy,
            DRAWING.POINT_RADIUS,
            0,
            Math.PI * 2
        )
        ctx.fill()
    }

    // ring around the selected point: the one the arrow keys move
    const ring = pts[selected]
    if (ring) {
        ctx.strokeStyle = COLORS.IN_PROGRESS
        ctx.lineWidth = DRAWING.MIN_LINE_WIDTH
        ctx.beginPath()
        ctx.arc(offset.x + ring[0] * sx, offset.y + ring[1] * sy, DRAWING.POINT_RADIUS * 2.2, 0, Math.PI * 2)
        ctx.stroke()
    }
}

/* ---------------- CROSSHAIR ---------------- */

export function drawCrosshair(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement
) {
    const cx = canvas.width / 2
    const cy = canvas.height / 2

    ctx.strokeStyle = COLORS.CROSSHAIR
    ctx.lineWidth = 2

    ctx.beginPath()
    ctx.moveTo(cx - DRAWING.CROSSHAIR_SIZE, cy)
    ctx.lineTo(cx + DRAWING.CROSSHAIR_SIZE, cy)
    ctx.stroke()

    ctx.beginPath()
    ctx.moveTo(cx, cy - DRAWING.CROSSHAIR_SIZE)
    ctx.lineTo(cx, cy + DRAWING.CROSSHAIR_SIZE)
    ctx.stroke()

    ctx.fillStyle = COLORS.CROSSHAIR
    ctx.beginPath()
    ctx.arc(cx, cy, DRAWING.CROSSHAIR_CENTER_RADIUS, 0, Math.PI * 2)
    ctx.fill()
}

/* ---------------- BASE (DOCK + ROBOT) ---------------- */

const DOCK_VIEWBOX = { x: -10, y: -18, w: 20, h: 36 }
const DOCK_UNIT_R = 16

let dockImage: HTMLImageElement | null = null
let dockReady = false
const dockReadyListeners = new Set<() => void>()

function getDockImage(): HTMLImageElement {
    if (!dockImage) {
        dockImage = new Image()
        dockImage.onload = () => {
            dockReady = true
            dockReadyListeners.forEach(fn => fn())
            dockReadyListeners.clear()
        }
        dockImage.src = dockUrl
    }
    return dockImage
}

export function onDockImageReady(fn: () => void) {
    if (dockReady) return
    dockReadyListeners.add(fn)
    getDockImage()
}

export interface BasePose {
    /** Dock centre, normalised to the map grid (0..1 of width / height). */
    x: number
    y: number
    /** Dock heading in degrees (robot's base.dir). 0 = robot faces +X. */
    dir: number
}

export function drawBase(
    ctx: CanvasRenderingContext2D,
    base: BasePose,
    zoom: number,
    offset: { x: number; y: number },
    mapSize: { height: number, width: number },
    resolution: number,
) {
    const img = getDockImage()
    if (!dockReady) return

    const cx = offset.x + base.x * mapSize.width * zoom
    const cy = offset.y + base.y * mapSize.height * zoom

    // Robot radius in screen px: (mm / mm-per-cell) cells * px-per-cell.
    const rPx = (ROBOT_RADIUS_MM / (resolution || GEN3_MM_PER_CELL)) * zoom
    const s = rPx / DOCK_UNIT_R

    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(base.dir * Math.PI / 180)
    ctx.drawImage(img, DOCK_VIEWBOX.x * s, DOCK_VIEWBOX.y * s, DOCK_VIEWBOX.w * s, DOCK_VIEWBOX.h * s)
    ctx.restore()
}

// The cells of an RLE [value, count] over a grid of `width` that have value 1, as one path of rects
function rleCells(rle: [number, number][], width: number, zoom: number, offset: { x: number; y: number }): Path2D {
    const path = new Path2D()
    let i = 0
    for (const [value, count] of rle) {
        if (value === 1) {
            // a run of cells may wrap over rows
            let left = count, at = i
            while (left > 0) {
                const x = at % width, y = Math.floor(at / width)
                const n = Math.min(left, width - x)
                path.rect(offset.x + x * zoom, offset.y + y * zoom, n * zoom, zoom)
                left -= n
                at += n
            }
        }
        i += count
    }
    return path
}

// The floor a run cleaned (gen3, from its black box track with the brush width), drawn like the
// covered area from the RunMap, which it replaces
export function drawCleaned(
    ctx: CanvasRenderingContext2D,
    rle: [number, number][],
    width: number,
    zoom: number,
    offset: { x: number; y: number },
    color: string,
) {
    ctx.save()
    ctx.globalAlpha = parseFloat(COLORS.RUN_OPACITY) || DRAWING.RUN_OVERLAY_OPACITY
    ctx.fillStyle = color
    ctx.fill(rleCells(rle, width, zoom, offset))
    ctx.restore()
}

// Free floor a run did not clean (gen3): RLE [value, count] over the run map, 1 = missed
export function drawMissed(
    ctx: CanvasRenderingContext2D,
    rle: [number, number][],
    width: number,
    zoom: number,
    offset: { x: number; y: number },
) {
    ctx.save()
    ctx.fillStyle = 'rgba(230, 60, 60, 0.45)'
    ctx.fill(rleCells(rle, width, zoom, offset))
    ctx.restore()
}

// Floor type (gen3, from the brush load): high pile dark, runner light; hard floor is left as it is
export const FLOOR_COLORS = { 2: 'rgba(214, 170, 110, 0.55)', 3: 'rgba(140, 90, 45, 0.6)' } as const
export function drawFloorType(
    ctx: CanvasRenderingContext2D,
    cells: [number, number, 1 | 2 | 3][],
    zoom: number,
    offset: { x: number; y: number },
) {
    const paths = { 2: new Path2D(), 3: new Path2D() }
    for (const [u, v, k] of cells) if (k !== 1) paths[k].rect(offset.x + u * zoom, offset.y + v * zoom, zoom, zoom)
    ctx.save()
    for (const k of [2, 3] as const) {
        ctx.fillStyle = FLOOR_COLORS[k]
        ctx.fill(paths[k])
    }
    ctx.restore()
}

// Problems the robot noted (gen3, black box), one symbol each
export const PROBLEM_ICONS: Record<Problem['kind'], string> = {
    bump: '💥', tilt: '⚠️', lost: '❓', unreachable: '⛔', slip: '〰️', stuck: '🆘', dock_tilted: '🔌', off_base: '🔌',
}

// The symbols where problems happened; with `cluster`, the same kind close together (within 4 cells,
// about 16 cm) is one symbol with a count, so places where it happens often stand out
export function drawProblems(
    ctx: CanvasRenderingContext2D,
    problems: Problem[],
    zoom: number,
    offset: { x: number; y: number },
    cluster = false,
) {
    const groups = new Map<string, { kind: Problem['kind'], u: number, v: number, n: number }>()
    for (const p of problems) {
        const key = cluster ? `${p.kind}:${Math.round(p.u / 4)}:${Math.round(p.v / 4)}` : `${groups.size}`
        const g = groups.get(key)
        if (g) { g.u = (g.u * g.n + p.u) / (g.n + 1); g.v = (g.v * g.n + p.v) / (g.n + 1); g.n++ }
        else groups.set(key, { kind: p.kind, u: p.u, v: p.v, n: 1 })
    }
    ctx.save()
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const g of groups.values()) {
        const x = offset.x + g.u * zoom, y = offset.y + g.v * zoom
        const size = Math.min(26, 13 + 3 * Math.log2(g.n))
        ctx.font = `${size}px sans-serif`
        ctx.fillText(PROBLEM_ICONS[g.kind] ?? '•', x, y)
        if (g.n > 1) {
            ctx.font = 'bold 10px sans-serif'
            ctx.fillStyle = '#fff'
            ctx.strokeStyle = 'rgba(0,0,0,0.7)'
            ctx.lineWidth = 3
            ctx.strokeText(String(g.n), x + size * 0.55, y - size * 0.45)
            ctx.fillText(String(g.n), x + size * 0.55, y - size * 0.45)
        }
    }
    ctx.restore()
}

// Small arrows along a line of screen points, pointing the way it was drawn: every `spacing` px of
// its length, so the direction of a route can be seen.
function drawArrowsAlong(ctx: CanvasRenderingContext2D, pts: [number, number][], spacing: number, size: number) {
    let next = spacing / 2
    let walked = 0
    ctx.beginPath()
    for (let i = 1; i < pts.length; i++) {
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]
        const len = Math.hypot(x1 - x0, y1 - y0)
        if (len === 0) continue
        const a = Math.atan2(y1 - y0, x1 - x0)
        while (walked + len >= next) {
            const f = (next - walked) / len
            const x = x0 + (x1 - x0) * f, y = y0 + (y1 - y0) * f
            ctx.moveTo(x + Math.cos(a) * size, y + Math.sin(a) * size)
            ctx.lineTo(x + Math.cos(a + 2.5) * size, y + Math.sin(a + 2.5) * size)
            ctx.lineTo(x + Math.cos(a - 2.5) * size, y + Math.sin(a - 2.5) * size)
            ctx.closePath()
            next += spacing
        }
        walked += len
    }
    ctx.fill()
}

// arrows on a route: about every 40 cm of the way (10 cells), but never closer than 28 px on screen
const ARROW_EVERY_CELLS = 10

// The way the robot drove during a run (gen3, from its black box): a fine line over the covered area.
// Points are cells of the run's map.
export function drawRunTrack(
    ctx: CanvasRenderingContext2D,
    cells: [number, number][],
    zoom: number,
    offset: { x: number; y: number },
) {
    if (cells.length < 2) return
    ctx.save()
    ctx.beginPath()
    cells.forEach(([u, v], i) => {
        const x = offset.x + u * zoom, y = offset.y + v * zoom
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
    })
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.strokeStyle = withAlpha(COLORS.WALL, 0.7)
    ctx.lineWidth = Math.max(1, Math.min(2.5, zoom * 0.25))
    ctx.stroke()
    ctx.fillStyle = withAlpha(COLORS.WALL, 0.85)
    drawArrowsAlong(ctx, cells.map(([u, v]) => [offset.x + u * zoom, offset.y + v * zoom]),
        Math.max(28, ARROW_EVERY_CELLS * zoom), Math.max(3.5, Math.min(7, zoom * 0.9)))
    ctx.restore()
}

// The robot itself at the origin of ctx: the mascot (upright, so it never stands on its head) with a
// small arrow outside it the way it faces, or without an image a disc with a line that way. Heading in
// degrees on screen (0 = right, clockwise); null: no direction known.
function drawRobotBody(ctx: CanvasRenderingContext2D, rPx: number, heading: number | null,
    img: HTMLImageElement | undefined, dashed: boolean) {
    if (img) {
        const size = Math.max(30, rPx * 2.6)
        ctx.drawImage(img, -size / 2, -size / 2, size, size)
        if (heading !== null) {
            ctx.rotate(heading * Math.PI / 180)
            const r = size / 2 + 2
            const w = Math.max(4, size * 0.14)
            ctx.beginPath()
            ctx.moveTo(r + w * 1.4, 0)
            ctx.lineTo(r, -w)
            ctx.lineTo(r, w)
            ctx.closePath()
            ctx.fillStyle = COLORS.CROSSHAIR
            ctx.fill()
            ctx.lineWidth = 1.5
            ctx.strokeStyle = '#ffffff'
            ctx.stroke()
        }
        return
    }
    ctx.beginPath()
    ctx.arc(0, 0, rPx, 0, Math.PI * 2)
    ctx.fillStyle = COLORS.CROSSHAIR
    ctx.fill()
    ctx.lineWidth = 2
    ctx.strokeStyle = '#ffffff'
    if (dashed) ctx.setLineDash([4, 3])
    ctx.stroke()
    ctx.setLineDash([])
    if (heading !== null) {
        ctx.rotate(heading * Math.PI / 180)
        ctx.beginPath()
        ctx.moveTo(0, 0)
        ctx.lineTo(rPx, 0)
        ctx.stroke()
    }
}

// The robot where it is now (live, gen3) and the way it took during this clean. Positions are map
// cells; heading in degrees on screen (0 = right, clockwise).
export function drawLiveRobot(
    ctx: CanvasRenderingContext2D,
    points: [number, number][],
    heading: number,
    zoom: number,
    offset: { x: number; y: number },
    resolution: number,
    img?: HTMLImageElement,
) {
    const at = ([u, v]: [number, number]) => [offset.x + u * zoom, offset.y + v * zoom] as const
    const rPx = Math.max(6, (ROBOT_RADIUS_MM / (resolution || GEN3_MM_PER_CELL)) * zoom)
    ctx.save()
    if (points.length > 1) {
        ctx.beginPath()
        points.forEach((p, i) => {
            const [x, y] = at(p)
            if (i === 0) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
        })
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        ctx.strokeStyle = withAlpha(COLORS.CROSSHAIR, 0.45)
        ctx.lineWidth = Math.max(2, rPx * 0.35)
        ctx.stroke()
        ctx.fillStyle = withAlpha(COLORS.CROSSHAIR, 0.8)
        drawArrowsAlong(ctx, points.map(at).map(([x, y]) => [x, y] as [number, number]),
            Math.max(28, ARROW_EVERY_CELLS * zoom), Math.max(3.5, Math.min(7, zoom * 0.9)))
    }
    const [x, y] = at(points[points.length - 1])
    ctx.translate(x, y)
    ctx.globalAlpha = img ? 1 : 0.9
    drawRobotBody(ctx, rPx, heading, img, false)
    ctx.restore()
}

// The robot while it does not clean: on its dock (solid), or faded where it was last seen, with a label
// (it logs its position only while cleaning, so it may have been carried away since).
export function drawRestRobot(
    ctx: CanvasRenderingContext2D,
    [u, v]: [number, number],
    heading: number | null,
    zoom: number,
    offset: { x: number; y: number },
    faded: boolean,
    label?: string,
    img?: HTMLImageElement,
) {
    const rPx = Math.max(6, (ROBOT_RADIUS_MM / GEN3_MM_PER_CELL) * zoom)
    ctx.save()
    ctx.translate(offset.x + u * zoom, offset.y + v * zoom)
    ctx.save()
    ctx.globalAlpha = faded ? 0.45 : (img ? 1 : 0.9)
    drawRobotBody(ctx, rPx, heading, img, faded)
    ctx.restore()
    if (label) {
        ctx.font = '600 12px system-ui, sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        const y = (img ? Math.max(30, rPx * 2.6) / 2 : rPx) + 6
        const w = ctx.measureText(label).width + 12
        ctx.fillStyle = 'rgba(0, 0, 0, 0.65)'
        ctx.beginPath()
        ctx.roundRect(-w / 2, y - 3, w, 20, 6)
        ctx.fill()
        ctx.fillStyle = '#ffffff'
        ctx.fillText(label, 0, y + 1)
    }
    ctx.restore()
}

// An image (e.g. the mascot) where the robot docks, drawn instead of the dock symbol.
export function drawMarker(
    ctx: CanvasRenderingContext2D,
    img: HTMLImageElement,
    base: BasePose,
    zoom: number,
    offset: { x: number; y: number },
    mapSize: { height: number, width: number },
    resolution: number,
) {
    const cx = offset.x + base.x * mapSize.width * zoom
    const cy = offset.y + base.y * mapSize.height * zoom
    // twice the robot's size on the map, but never too small to recognise
    const size = Math.max(32, 4 * (ROBOT_RADIUS_MM / (resolution || GEN3_MM_PER_CELL)) * zoom)
    ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size)
}

// Adds one rectangle per horizontal run of cells x0 <= x < x1 in row y for which `on(x)` holds: an area
// of cells as few rectangles, filled as one path
function addRowRuns(path: Path2D, y: number, x0: number, x1: number, on: (x: number) => boolean,
    zoom: number, offset: { x: number; y: number }) {
    let runStart = -1
    for (let x = x0; x <= x1; x++) {
        const hit = x < x1 && on(x)
        if (hit && runStart < 0) runStart = x
        if (!hit && runStart >= 0) {
            path.rect(offset.x + runStart * zoom, offset.y + y * zoom, (x - runStart) * zoom, zoom)
            runStart = -1
        }
    }
}

// Area the robot cleaned: the run's path is a thin track, so every path cell becomes a disc of the
// robot's size. All discs are filled as one path, so overlaps merge into one smooth band instead of
// stacking their opacity. The band is clipped to free floor, so it never spills over walls.
export function drawCoverage(
    ctx: CanvasRenderingContext2D,
    floorCells: number[],
    runCells: number[],
    ignore: Set<number>,
    zoom: number,
    offset: { x: number; y: number },
    mapSize: { height: number, width: number },
    resolution: number,
) {
    const rCells = ROBOT_RADIUS_MM / (resolution || GEN3_MM_PER_CELL)
    const r = rCells * zoom
    const { width, height } = mapSize
    let pathValue: number | undefined
    let minX = width, minY = height, maxX = -1, maxY = -1
    const discs = new Path2D()
    for (let i = 0; i < runCells.length; i++) {
        const v = runCells[i]
        if (v === 0 || ignore.has(v)) continue
        pathValue ??= v
        const x = i % width, y = Math.floor(i / width)
        minX = Math.min(minX, x); maxX = Math.max(maxX, x)
        minY = Math.min(minY, y); maxY = Math.max(maxY, y)
        const cx = offset.x + (x + 0.5) * zoom
        const cy = offset.y + (y + 0.5) * zoom
        discs.moveTo(cx + r, cy)
        discs.arc(cx, cy, r, 0, Math.PI * 2)
    }
    if (pathValue === undefined) return

    // free floor around the path, one rectangle per horizontal run of free cells
    const pad = Math.ceil(rCells)
    const floor = new Path2D()
    for (let y = Math.max(0, minY - pad); y <= Math.min(height - 1, maxY + pad); y++) {
        addRowRuns(floor, y, Math.max(0, minX - pad), Math.min(width - 1, maxX + pad) + 1, x => floorCells[y * width + x] === 1, zoom, offset)
    }

    ctx.save()
    ctx.clip(floor)
    ctx.globalAlpha = parseFloat(COLORS.RUN_OPACITY) || DRAWING.RUN_OVERLAY_OPACITY
    ctx.fillStyle = colorForPathValue(pathValue)
    ctx.fill(discs)
    ctx.restore()
}

// "Plan" look: the floor as one continuous area instead of a dot per cell. Unexplored cells stay
// background. Walls are drawn separately (drawPlanWalls) so they can go on top of an overlay.
export function drawPlanFloor(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    cells: number[],
    zoom: number,
    offset: { x: number; y: number },
    mapSize: { height: number, width: number },
    backgroundToken?: string,
) {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = backgroundToken ? readMapToken(backgroundToken) : COLORS.BACKGROUND
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    // one rectangle per horizontal run of non-unknown cells: walls are part of the floor area too
    const floor = new Path2D()
    for (let y = 0; y < mapSize.height; y++) {
        addRowRuns(floor, y, 0, mapSize.width, x => cells[y * mapSize.width + x] !== 0, zoom, offset)
    }
    ctx.fillStyle = COLORS.EMPTY
    ctx.fill(floor)
}

// Walls as solid lines: the D7's wall pixels are dashed, so a cell between two wall cells (left/right,
// up/down or diagonally opposite) counts as wall too. That closes the gaps without making walls
// thicker; the wall cells are then filled as one area, one rectangle per horizontal run.
const OPPOSITE_PAIRS: [number, number][] = [[1, 0], [0, 1], [1, 1], [1, -1]]

export function drawPlanWalls(
    ctx: CanvasRenderingContext2D,
    cells: number[],
    zoom: number,
    offset: { x: number; y: number },
    mapSize: { height: number, width: number },
) {
    const { width, height } = mapSize
    const isWall = (x: number, y: number) => x >= 0 && x < width && y >= 0 && y < height && cells[y * width + x] === 2
    const wall = (x: number, y: number) => isWall(x, y)
        || OPPOSITE_PAIRS.some(([dx, dy]) => isWall(x - dx, y - dy) && isWall(x + dx, y + dy))

    const walls = new Path2D()
    for (let y = 0; y < height; y++) addRowRuns(walls, y, 0, width, x => wall(x, y), zoom, offset)
    ctx.fillStyle = COLORS.WALL
    ctx.fill(walls)
}

// Small flag where a run started (used when that was away from the dock).
export function drawStartFlag(
    ctx: CanvasRenderingContext2D,
    at: { x: number; y: number },
    zoom: number,
    offset: { x: number; y: number },
    mapSize: { height: number, width: number },
) {
    const x = offset.x + at.x * mapSize.width * zoom
    const y = offset.y + at.y * mapSize.height * zoom
    const h = Math.max(18, zoom * 5) // pole height
    ctx.save()
    ctx.strokeStyle = COLORS.LINE_COLOR
    ctx.fillStyle = COLORS.LINE_COLOR
    ctx.lineWidth = Math.max(1.5, h / 10)
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x, y - h)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(x, y - h)
    ctx.lineTo(x + h * 0.6, y - h * 0.78)
    ctx.lineTo(x, y - h * 0.56)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
}

// Zones over a run: the ones the robot cleaned in that run at full strength, the others faded,
// each with its name in the middle.
export function drawZoneOverlay(
    ctx: CanvasRenderingContext2D,
    zones: Zone[],
    visited: Set<string>,
    zoom: number,
    offset: { x: number; y: number },
    mapSize: { height: number, width: number },
) {
    // outlines only, so the covered area below stays visible: zones the run went through solid,
    // the others dashed and faint
    ctx.save()
    const width = Math.max(DRAWING.MIN_LINE_WIDTH, zoom * DRAWING.POLYGON_LINE_WIDTH_SCALE)
    for (const zone of zones) {
        const wasVisited = visited.has(zone.id)
        ctx.globalAlpha = wasVisited ? 1 : 0.45
        ctx.lineWidth = wasVisited ? width * 1.5 : width
        ctx.setLineDash(wasVisited ? [] : [width * 3, width * 2])
        drawZone(ctx, zone, zoom, offset, mapSize, true)
    }
    ctx.setLineDash([])

    ctx.font = `600 ${Math.max(11, Math.min(16, zoom * 3))}px Arial, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.shadowColor = 'rgba(0, 0, 0, 0.8)'
    ctx.shadowBlur = 3
    for (const zone of zones) {
        if (!zone.name || zone.vertices.length < 3) continue
        const [cx, cy] = calcRelevancy(zone.vertices)
        ctx.globalAlpha = visited.has(zone.id) ? 1 : 0.6
        ctx.fillStyle = '#ffffff'
        ctx.fillText(zone.name, offset.x + cx * mapSize.width * zoom, offset.y + cy * mapSize.height * zoom)
    }
    ctx.restore()
}

// Coverage over several runs: free floor shaded by how many of the runs cleaned it (four steps,
// in the accent colour), free floor no run reached in red.
export function drawHeatmap(
    ctx: CanvasRenderingContext2D,
    heatmap: { counts: Uint16Array, floor: number[], runs: number, width: number },
    zoom: number,
    offset: { x: number; y: number },
) {
    if (!heatmap.runs) return
    const steps = [new Path2D(), new Path2D(), new Path2D(), new Path2D()]
    const never = new Path2D()
    const { counts, floor, runs, width } = heatmap
    for (let i = 0; i < counts.length; i++) {
        if (floor[i] !== 1) continue
        const x = offset.x + (i % width) * zoom
        const y = offset.y + Math.floor(i / width) * zoom
        if (counts[i] === 0) never.rect(x, y, zoom, zoom)
        else steps[Math.min(3, Math.floor(counts[i] / runs * 4 - 1e-9))].rect(x, y, zoom, zoom)
    }
    ctx.save()
    ctx.fillStyle = readMapToken('--accent') || COLORS.LINE_COLOR
    steps.forEach((path, i) => {
        ctx.globalAlpha = HEATMAP_ALPHAS[i]
        ctx.fill(path)
    })
    ctx.globalAlpha = 0.28
    ctx.fillStyle = '#ff5a5a'
    ctx.fill(never)
    ctx.restore()
}

// opacity of the four coverage steps, rarely → often
export const HEATMAP_ALPHAS = [0.18, 0.34, 0.52, 0.75]
