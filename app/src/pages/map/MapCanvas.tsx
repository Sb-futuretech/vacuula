import { useEffect, useRef, useState } from 'react'
import styles from './map.module.scss'
import { FaMinus, FaPlus, FaUndo, FaRegQuestionCircle } from 'react-icons/fa'
import { MdOutlineFitScreen } from 'react-icons/md'
import { PiBoundingBox } from 'react-icons/pi'
import { useTranslation } from 'react-i18next'
import Drawer from '../../components/drawer/drawer'
import MapRulers from './MapRulers'
import PointEditor from './PointEditor'
import { DRAWING } from '../../components/map/constants'
import { GEN3_MM_PER_CELL } from '../../components/map/gen3Run'
import type { Point, UseState } from '../../components/map/types'
import { getCrosshairWorldCoords, getWorldCoords } from '../../components/map/utils'
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
export type MapMode = 'maps' | 'map-edit' | 'boundaries' | 'boundary-info' | 'boundary-edit'

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
    mmPerPixel = GEN3_MM_PER_CELL
}: MapCanvasProps) {
    // TODO: decide on how exactly i want this to work, for now just show the button if there is at least 3 points.
    const [showCloseAsPolygon, setShowCloseAsPolygon] = useState(false)
    const [helpOpen, setHelpOpen] = useState(false)
    const { t } = useTranslation()

    const { canvasRef, mapSize, zoom, offset, isDragging, hasMoved, canvasHandlers, resetView, zoomStep } = useMap({
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

    const deletePoint = (index: number) => {
        if (closedAsPolygon && currentLinePoints.length <= 3) setClosedAsPolygon(false)
        setCurrentLinePoints(prev => prev.filter((_, i) => i !== index))
        setSelectedPoint(null)
    }

    // Mouse (touch: see onTouchEnd): a click that did not pan the map picks the point under the
    // cursor, or adds a new point there. Pointer events tell mouse and touch apart.
    const clickStartRef = useRef<{ x: number, y: number } | null>(null)
    const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
        clickStartRef.current = e.pointerType === 'mouse' && e.button === 0 ? { x: e.clientX, y: e.clientY } : null
    }
    const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const start = clickStartRef.current
        clickStartRef.current = null
        if (!start || mode !== 'boundary-edit' || !mapSize) return
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) >= DRAWING.MIN_MOVEMENT) return // panned

        const rect = e.currentTarget.getBoundingClientRect()
        const x = e.clientX - rect.left
        const y = e.clientY - rect.top
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
            // typing in a form field (e.g. the zone name) must not move points or zoom
            if (e.metaKey || e.ctrlKey || target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
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
    // point at the crosshair as before
    const onTouchEnd = (e: React.TouchEvent<HTMLCanvasElement>) => {
        canvasHandlers.onTouchEnd(e)
        if (mode !== 'boundary-edit' || hasMoved) return
        const touch = e.changedTouches[0]
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

            {mode === 'boundary-edit' && mapSize && (
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

            <div className={styles.zoomButtons}>
                <button onClick={() => zoomStep(DRAWING.ZOOM_STEP)} aria-label="Zoom in"><FaPlus size={16} /></button>
                <button onClick={() => zoomStep(1 / DRAWING.ZOOM_STEP)} aria-label="Zoom out"><FaMinus size={16} /></button>
                <button onClick={resetView} aria-label="Fit map"><MdOutlineFitScreen size={18} /></button>
                {mode === 'boundary-edit' && (
                    <button onClick={() => setHelpOpen(true)} aria-label={t('map.help')}><FaRegQuestionCircle size={17} /></button>
                )}
            </div>

            {mode === 'boundary-edit' && (
                <div className={styles.actionButtons}>
                    {maxPoints !== undefined && (
                        <span className={`${styles.pointCount} ${atPointLimit ? styles.limit : ''}`}>
                            {currentLinePoints.length}/{maxPoints}
                        </span>
                    )}
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

            <Drawer open={helpOpen} handle={false} onOpenChange={setHelpOpen} openHeightPercent={72} title={t('map.helpTitle')}>
                <div className={styles.mapHelp}>
                    <div className={styles.mapHelpSection}>
                        <div className={styles.mapHelpHead}>{t('map.helpMoveTitle')}</div>
                        <div className={styles.mapHelpText}>{t('map.helpMove')}</div>
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