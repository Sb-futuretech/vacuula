import { useEffect, useRef, useState } from 'react'
import styles from './map.module.scss'
import { FaMinus, FaPlus, FaUndo, FaRegQuestionCircle } from 'react-icons/fa'
import { MdOutlineFitScreen, MdStraighten, MdTouchApp } from 'react-icons/md'
import { PiBoundingBox } from 'react-icons/pi'
import { useTranslation } from 'react-i18next'
import Drawer from '../../components/drawer/drawer'
import MapRulers from './MapRulers'
import PointEditor from './PointEditor'
import { DRAWING } from '../../components/map/constants'
import { GEN3_MM_PER_CELL } from '../../components/map/gen3Run'
import type { NoGoLine, Point, UseState, Zone } from '../../components/map/types'
import { distToSegment, getCrosshairWorldCoords, getWorldCoords, pointInPolygon, polygonArea } from '../../components/map/utils'

// how close (CSS px) a tap has to land to a no-go line to pick it
const LINE_HIT_PX = 16
import { useMap, type ExtraDrawFn } from '../../components/map/useMap'

// [x, y] direction per arrow key; map y grows downwards
const ARROW_DIRECTIONS: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
}

// Single source of truth for the page's mode union — map.tsx imports this rather
// than declaring its own copy.
export type MapMode = 'map-edit' | 'boundaries' | 'boundary-info' | 'boundary-edit'

interface MapCanvasProps {
    mapId: string   // required, no `?` — this component simply doesn't exist without a map
    runId?: string  // genuinely optional: a map can be viewed with no run overlay
    mode: MapMode
    extraDraw?: ExtraDrawFn
    redrawKey?: unknown
    currentLinePoints: Point[]
    setCurrentLinePoints: UseState<Point[]>
    closedAsPolygon: boolean
    setClosedAsPolygon: UseState<boolean>
    setDrawerOpen: (open: boolean) => void
    allowClose?: boolean // false for a No-Go Line: the points can't be closed into a polygon
    maxPoints?: number // robot-side vertex limit, undefined = unlimited
    selectedPoint: number | null // null = the last point
    setSelectedPoint: (index: number | null) => void
    mmPerPixel?: number // map resolution; gen3 maps have none (GEN3_MM_PER_CELL)
    boundaries?: (NoGoLine | Zone)[] // the map's zones and lines, for picking one by tapping it
    onBoundaryTap?: (id: string | null) => void // tap while viewing the features; null = nothing there
    onAddHere?: (at: Point) => void // the "add feature here" pill offered after a tap on empty map
    centerOn?: Point | null // a new value moves the map so this point sits under the crosshair
}

// Owns everything that genuinely can't exist without a selected map: the hook, the
// canvas element + its pan/zoom handlers, and the boundary-drawing action buttons
// (they all need canvasRef/zoom/offset to translate screen taps into map coords).
export default function MapCanvas({
    mapId,
    runId,
    mode,
    extraDraw,
    redrawKey,
    currentLinePoints,
    setCurrentLinePoints,
    closedAsPolygon,
    setClosedAsPolygon,
    setDrawerOpen,
    allowClose = true,
    maxPoints,
    selectedPoint,
    setSelectedPoint,
    mmPerPixel = GEN3_MM_PER_CELL,
    boundaries,
    onBoundaryTap,
    onAddHere,
    centerOn
}: MapCanvasProps) {
    // TODO: decide on how exactly i want this to work, for now just show the button if there is at least 3 points.
    const [showCloseAsPolygon, setShowCloseAsPolygon] = useState(false)
    const [helpOpen, setHelpOpen] = useState(false)
    // rulers: always while drawing, otherwise switched on with the ruler button
    const [showRulers, setShowRulers] = useState(false)
    const rulersOn = mode === 'boundary-edit' || showRulers
    // "tap a zone or line" bubble next to the help button: shown while viewing the features
    // until something gets picked (on the map or in the list) or the bubble is tapped
    const [tapHintDone, setTapHintDone] = useState(false)
    useEffect(() => {
        if (mode === 'boundary-info' || mode === 'boundary-edit') setTapHintDone(true)
    }, [mode])
    const showTapHint = !tapHintDone && mode === 'boundaries' && !!onBoundaryTap && (boundaries?.length ?? 0) > 0
    const { t } = useTranslation()

    const { canvasRef, mapSize, zoom, offset, isDragging, hasMoved, canvasHandlers, resetView, zoomStep, setOffset } = useMap({
        mapId,
        runId,
        extraDraw,
        redrawKey,
        backgroundToken: '--map-editor-bg'
    })

    const atPointLimit = maxPoints !== undefined && currentLinePoints.length >= maxPoints

    // canvas size in CSS pixels, for the rulers
    const [canvasBox, setCanvasBox] = useState({ width: 0, height: 0 })
    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        const observer = new ResizeObserver(() => setCanvasBox({ width: canvas.clientWidth, height: canvas.clientHeight }))
        observer.observe(canvas)
        return () => observer.disconnect()
    }, [canvasRef])

    // index of the drawn point at canvas position x/y (CSS px), -1 if none; `reach` scales the hit radius
    const pointAt = (x: number, y: number, reach: number) => !mapSize ? -1 : currentLinePoints.findIndex(([px, py]) =>
        Math.hypot(offset.x + px * mapSize.width * zoom - x, offset.y + py * mapSize.height * zoom - y) <= DRAWING.POINT_RADIUS * reach)

    // the zone or line at canvas position x/y (CSS px): a nearby line first (thin, drawn on top),
    // else the smallest zone containing the tap; null if none
    const boundaryAt = (x: number, y: number): string | null => {
        if (!mapSize || !boundaries) return null
        const toScreen = ([px, py]: Point): [number, number] =>
            [offset.x + px * mapSize.width * zoom, offset.y + py * mapSize.height * zoom]
        let line: string | null = null
        let lineDist = LINE_HIT_PX
        for (const b of boundaries) {
            if (b.type !== 'polyline') continue
            const pts = b.vertices.map(toScreen)
            for (let i = 1; i < pts.length; i++) {
                const d = distToSegment([x, y], pts[i - 1], pts[i])
                if (d < lineDist) { lineDist = d; line = b.id }
            }
        }
        if (line) return line
        let zone: string | null = null
        let zoneArea = Infinity
        for (const b of boundaries) {
            if (b.type !== 'polygon') continue
            const pts = b.vertices.map(toScreen)
            if (!pointInPolygon([x, y], pts)) continue
            const area = polygonArea(pts)
            if (area < zoneArea) { zoneArea = area; zone = b.id }
        }
        return zone
    }
    const pickable = !!onBoundaryTap && (mode === 'boundaries' || mode === 'boundary-info')

    // "add feature here" pill at an empty spot that was tapped while nothing was selected;
    // gone again on the next tap, on pan/zoom and on any mode change
    const [addHere, setAddHere] = useState<{ x: number, y: number, at: Point } | null>(null)
    useEffect(() => setAddHere(null), [zoom, offset.x, offset.y, mode])

    // a tap (no pan) while viewing the features, at canvas position x/y (CSS px)
    const tapViewing = (x: number, y: number) => {
        const id = boundaryAt(x, y)
        const at = mapSize ? getWorldCoords(x, y, offset, zoom, mapSize) : null
        const onMap = at && at[0] >= 0 && at[0] <= 1 && at[1] >= 0 && at[1] <= 1
        setAddHere(!id && mode === 'boundaries' && onAddHere && onMap ? { x, y, at } : null)
        onBoundaryTap?.(id)
    }

    // move the map so `centerOn` sits under the crosshair (the canvas centre)
    useEffect(() => {
        const canvas = canvasRef.current
        if (!centerOn || !canvas || !mapSize) return
        setOffset({
            x: canvas.width / 2 - centerOn[0] * mapSize.width * zoom,
            y: canvas.height / 2 - centerOn[1] * mapSize.height * zoom,
        })
    }, [centerOn])

    const deletePoint = (index: number) => {
        if (closedAsPolygon && currentLinePoints.length <= 3) setClosedAsPolygon(false)
        setCurrentLinePoints(prev => prev.filter((_, i) => i !== index))
        setSelectedPoint(null)
    }

    // Mouse (touch: see onTouchEnd): a click that did not pan the map picks the point under the
    // cursor, or adds a new point there; while viewing the features it picks the zone or line
    // under the cursor. Pointer events tell mouse and touch apart.
    const clickStartRef = useRef<{ x: number, y: number } | null>(null)
    const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
        clickStartRef.current = e.pointerType === 'mouse' && e.button === 0 ? { x: e.clientX, y: e.clientY } : null
    }
    const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const start = clickStartRef.current
        clickStartRef.current = null
        if (!start || !mapSize || (mode !== 'boundary-edit' && !pickable)) return
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) >= DRAWING.MIN_MOVEMENT) return // panned

        const rect = e.currentTarget.getBoundingClientRect()
        const x = e.clientX - rect.left
        const y = e.clientY - rect.top
        if (mode !== 'boundary-edit') {
            tapViewing(x, y)
            return
        }
        const hit = pointAt(x, y, 2.5)
        if (hit !== -1) {
            setSelectedPoint(hit)
            return
        }
        if (closedAsPolygon || atPointLimit) return
        setSelectedPoint(null)
        setCurrentLinePoints(prev => [...prev, getWorldCoords(x, y, offset, zoom, mapSize)])
    }

    const addPointAtCrosshair = () => {
        const coords = getCrosshairWorldCoords(canvasRef, offset, zoom, mapSize)
        setCurrentLinePoints(prev => maxPoints !== undefined && prev.length >= maxPoints ? prev : [...prev, coords])
    }

    const undo = () => {
        if (closedAsPolygon) {
            setClosedAsPolygon(false)
            return
        }
        if (currentLinePoints.length > 0) {
            setCurrentLinePoints(currentLinePoints.slice(0, -1))
        }
    }

    const closeAsPolygon = () => {
        setClosedAsPolygon(true)
        setDrawerOpen(true)
    }

    // While drawing: arrows nudge the selected point (shift: 5x), Backspace/Delete removes it,
    // Enter closes the zone, Escape drops the selection. Returns false for any other key.
    const handleDrawingKey = (e: KeyboardEvent) => {
        const active = selectedPoint ?? currentLinePoints.length - 1
        const arrow = ARROW_DIRECTIONS[e.key]
        if (arrow) {
            if (!mapSize) return true
            const px = DRAWING.NUDGE_MM * (e.shiftKey ? 5 : 1) / mmPerPixel
            setCurrentLinePoints(prev => prev.map((p, i) => i === active
                ? [p[0] + arrow[0] * px / mapSize.width, p[1] + arrow[1] * px / mapSize.height]
                : p))
        } else if (e.key === 'Backspace' || e.key === 'Delete') {
            if (active < 0) return true
            deletePoint(active)
        } else if (e.key === 'Enter') {
            if (allowClose && currentLinePoints.length > 2 && !closedAsPolygon) closeAsPolygon()
        } else if (e.key === 'Escape') {
            setSelectedPoint(null)
        } else return false
        return true
    }

    // + / - zoom, 0 fits the map. Returns false for any other key.
    const handleZoomKey = (e: KeyboardEvent) => {
        if (e.key === '+' || e.key === '=') zoomStep(DRAWING.ZOOM_STEP)
        else if (e.key === '-') zoomStep(1 / DRAWING.ZOOM_STEP)
        else if (e.key === '0') resetView()
        else return false
        return true
    }

    // re-subscribed every render so the handlers always see the current points
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement
            // typing in a form field (e.g. the zone name) or using an open sheet must not move points or zoom
            if (e.metaKey || e.ctrlKey || target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
                || target.closest('[role="dialog"]')) return
            if ((mode === 'boundary-edit' && handleDrawingKey(e)) || handleZoomKey(e)) e.preventDefault()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    })

    const onTouchMove = (e: React.TouchEvent) => {
        canvasHandlers.onTouchMove(e)
        if (currentLinePoints.length > 1 && mapSize) {
            const coords = getCrosshairWorldCoords(canvasRef, offset, zoom, mapSize)
            const [fx, fy] = currentLinePoints[0]
            const distance = Math.sqrt((coords[0] - fx) ** 2 + (coords[1] - fy) ** 2)
            setShowCloseAsPolygon(distance < DRAWING.CLOSE_THRESHOLD)
        }
    }

    // a tap (no pan) on a drawn point selects it for the position editor; anywhere else adds a
    // point at the crosshair as before. While viewing the features a tap picks a zone or line.
    const onTouchEnd = (e: React.TouchEvent<HTMLCanvasElement>) => {
        canvasHandlers.onTouchEnd(e)
        if (hasMoved || (mode !== 'boundary-edit' && !pickable)) return
        const touch = e.changedTouches[0]
        if (mode !== 'boundary-edit') {
            if (touch) {
                const rect = e.currentTarget.getBoundingClientRect()
                tapViewing(touch.clientX - rect.left, touch.clientY - rect.top)
            }
            return
        }
        if (touch) {
            const rect = e.currentTarget.getBoundingClientRect()
            const hit = pointAt(touch.clientX - rect.left, touch.clientY - rect.top, 4) // fingers are less precise
            if (hit !== -1) {
                setSelectedPoint(hit)
                return
            }
        }
        setSelectedPoint(null)
        addPointAtCrosshair()
    }

    return (
        <>
            <canvas
                ref={canvasRef}
                className={styles.canvas}
                onMouseDown={canvasHandlers.onMouseDown}
                onMouseMove={canvasHandlers.onMouseMove}
                onMouseUp={canvasHandlers.onMouseUp}
                onMouseLeave={canvasHandlers.onMouseLeave}
                onDoubleClick={mode === 'boundary-edit' ? undefined : canvasHandlers.onDoubleClick}
                onPointerDown={onPointerDown}
                onPointerUp={onPointerUp}
                onTouchStart={canvasHandlers.onTouchStart}
                onTouchMove={onTouchMove}
                onTouchEnd={onTouchEnd}
                style={{
                    cursor: mode === 'boundary-edit' ? 'crosshair' : isDragging ? 'grabbing' : 'grab',
                    touchAction: 'none'
                }}
            />

            {rulersOn && mapSize && (
                <MapRulers zoom={zoom} offset={offset} mapSize={mapSize} mmPerPixel={mmPerPixel}
                    width={canvasBox.width} height={canvasBox.height} />
            )}

            {mode === 'boundary-edit' && mapSize && selectedPoint !== null && currentLinePoints[selectedPoint] && (
                <PointEditor
                    index={selectedPoint}
                    point={currentLinePoints[selectedPoint]}
                    previous={selectedPoint > 0 ? currentLinePoints[selectedPoint - 1] : null}
                    mapSize={mapSize}
                    mmPerPixel={mmPerPixel}
                    onChange={p => setCurrentLinePoints(prev => prev.map((q, i) => i === selectedPoint ? p : q))}
                    onDelete={() => deletePoint(selectedPoint)}
                    onDone={() => setSelectedPoint(null)}
                />
            )}

            {addHere && (
                <button className={styles.addHerePill} style={{ left: addHere.x, top: addHere.y }}
                    onClick={() => { onAddHere?.(addHere.at); setAddHere(null) }}>
                    <FaPlus size={12} /> {t('map.addHere')}
                </button>
            )}

            <div className={styles.zoomButtons}>
                <button onClick={() => zoomStep(DRAWING.ZOOM_STEP)} aria-label="Zoom in"><FaPlus size={16} /></button>
                <button onClick={() => zoomStep(1 / DRAWING.ZOOM_STEP)} aria-label="Zoom out"><FaMinus size={16} /></button>
                <button onClick={resetView} aria-label="Fit map"><MdOutlineFitScreen size={18} /></button>
                {mode !== 'boundary-edit' && (
                    <button onClick={() => setShowRulers(on => !on)} aria-label={t('map.rulers')} aria-pressed={showRulers}
                        className={showRulers ? styles.zoomButtonOn : undefined}><MdStraighten size={18} /></button>
                )}
                <div className={styles.helpButtonWrap}>
                    <button onClick={() => { setHelpOpen(true); setTapHintDone(true) }} aria-label={t('map.help')}><FaRegQuestionCircle size={17} /></button>
                    {showTapHint && (
                        <div className={styles.tapBubble} role="status" onClick={() => setTapHintDone(true)}>
                            <MdTouchApp size={20} />
                            <span>{t('map.tapBubble')}</span>
                        </div>
                    )}
                </div>
            </div>

            {mode === 'boundary-edit' && (
                <div className={styles.actionButtons}>
                    <div onClick={undo} className={styles.undo}>
                        <FaUndo size={20} color="var(--text)" />
                    </div>
                    <div onClick={addPointAtCrosshair} className={`${styles.add} ${closedAsPolygon || atPointLimit ? styles.disabled : ''}`}>
                        <FaPlus size={40} color="var(--text)" />
                    </div>
                    {allowClose && (
                        <div onClick={closeAsPolygon} className={`${styles.closePolygon} ${((currentLinePoints.length > 2) && !closedAsPolygon) ? '' : styles.disabled}`}>
                            <PiBoundingBox size={20} color="var(--text)" />
                        </div>
                    )}
                </div>
            )}

            <Drawer open={helpOpen} handle={false} onOpenChange={setHelpOpen} title={t('map.helpTitle')}>
                <div className={styles.mapHelp}>
                    <div className={styles.mapHelpSection}>
                        <div className={styles.mapHelpHead}>{t('map.helpMoveTitle')}</div>
                        <div className={styles.mapHelpText}>{t('map.helpMove')}</div>
                        <div className={styles.mapHelpRow}><span className={styles.mapHelpIcon}><MdStraighten size={15} /></span><span>{t('map.helpRuler')}</span></div>
                    </div>
                    <div className={styles.mapHelpSection}>
                        <div className={styles.mapHelpHead}>{t('map.helpSelectTitle')}</div>
                        <div className={styles.mapHelpRow}><span className={styles.mapHelpIcon}><MdTouchApp size={16} /></span><span>{t('map.helpSelect')}</span></div>
                    </div>
                    <div className={styles.mapHelpSection}>
                        <div className={styles.mapHelpHead}>{t('map.helpDrawTitle')}</div>
                        <div className={styles.mapHelpRow}><span className={styles.mapHelpIcon}><FaPlus size={15} /></span><span>{t('map.helpDraw1')}</span></div>
                        <div className={styles.mapHelpRow}><span className={styles.mapHelpIcon}><FaUndo size={15} /></span><span>{t('map.helpDraw2')}</span></div>
                        <div className={styles.mapHelpRow}><span className={styles.mapHelpIcon}><PiBoundingBox size={15} /></span><span>{t('map.helpDraw3')}</span></div>
                        <div className={styles.mapHelpText}>{t('map.helpDraw4')}</div>
                    </div>
                </div>
            </Drawer>
        </>
    )
}