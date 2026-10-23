import { useEffect, useState } from 'react'
import styles from './map.module.scss'
import { FaMinus, FaPlus, FaUndo } from 'react-icons/fa'
import { MdOutlineFitScreen } from 'react-icons/md'
import { PiBoundingBox } from 'react-icons/pi'
import { DRAWING } from '../../components/map/constants'
import type { Point, UseState } from '../../components/map/types'
import { getCrosshairWorldCoords } from '../../components/map/utils'
import { useMap, type ExtraDrawFn } from '../../components/map/useMap'

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
    setDrawerOpen
}: MapCanvasProps) {
    // TODO: decide on how exactly i want this to work, for now just show the button if there is at least 3 points.
    const [showCloseAsPolygon, setShowCloseAsPolygon] = useState(false)

    const { canvasRef, mapSize, zoom, offset, isDragging, hasMoved, canvasHandlers, resetView, zoomStep } = useMap({
        mapId,
        runId,
        extraDraw,
        redrawKey,
        backgroundToken: '--map-editor-bg'
    })

    // + / - zoom, 0 fits the map; ignored while typing in a form field
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement
            if (e.metaKey || e.ctrlKey || target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
            if (e.key === '+' || e.key === '=') zoomStep(DRAWING.ZOOM_STEP)
            else if (e.key === '-') zoomStep(1 / DRAWING.ZOOM_STEP)
            else if (e.key === '0') resetView()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [zoomStep, resetView])

    const addPointAtCrosshair = () => {
        const coords = getCrosshairWorldCoords(canvasRef, offset, zoom, mapSize)
        setCurrentLinePoints(prev => [...prev, coords])
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

    const onTouchMove = (e: React.TouchEvent) => {
        canvasHandlers.onTouchMove(e)
        if (currentLinePoints.length > 1 && mapSize) {
            const coords = getCrosshairWorldCoords(canvasRef, offset, zoom, mapSize)
            const [fx, fy] = currentLinePoints[0]
            const distance = Math.sqrt((coords[0] - fx) ** 2 + (coords[1] - fy) ** 2)
            setShowCloseAsPolygon(distance < DRAWING.CLOSE_THRESHOLD)
        }
    }

    const onTouchEnd = (e: React.TouchEvent) => {
        canvasHandlers.onTouchEnd(e)
        if (mode === 'boundary-edit' && !hasMoved) addPointAtCrosshair()
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
                onDoubleClick={canvasHandlers.onDoubleClick}
                onTouchStart={canvasHandlers.onTouchStart}
                onTouchMove={onTouchMove}
                onTouchEnd={onTouchEnd}
                style={{
                    cursor: mode === 'boundary-edit' ? 'crosshair' : isDragging ? 'grabbing' : 'grab',
                    touchAction: 'none'
                }}
            />

            <div className={styles.zoomButtons}>
                <button onClick={() => zoomStep(DRAWING.ZOOM_STEP)} aria-label="Zoom in"><FaPlus size={16} /></button>
                <button onClick={() => zoomStep(1 / DRAWING.ZOOM_STEP)} aria-label="Zoom out"><FaMinus size={16} /></button>
                <button onClick={resetView} aria-label="Fit map"><MdOutlineFitScreen size={18} /></button>
            </div>

            {mode === 'boundary-edit' && (
                <div className={styles.actionButtons}>
                    <div onClick={undo} className={styles.undo}>
                        <FaUndo size={20} color="var(--text)" />
                    </div>
                    <div onClick={addPointAtCrosshair} className={`${styles.add} ${closedAsPolygon ? styles.disabled : ''}`}>
                        <FaPlus size={40} color="var(--text)" />
                    </div>
                    <div onClick={closeAsPolygon} className={`${styles.closePolygon} ${((currentLinePoints.length > 2) && !closedAsPolygon) ? '' : styles.disabled}`}>
                        <PiBoundingBox size={20} color="var(--text)" />
                    </div>
                </div>
            )}
        </>
    )
}