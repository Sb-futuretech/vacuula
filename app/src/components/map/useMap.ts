import { useRef, useState, useCallback, useEffect } from 'react'
import { DRAWING } from './constants'
import { useCanvasViewport } from './useCanvasViewport'
import { decodeRLE, calcFitZoomAndOffset, calcFitToBounds, getRunBounds } from './utils'
import { drawMap, drawCoverage, drawPlanFloor, drawPlanWalls, computeIgnoredRunValues, colorForPathValue, type CellShape } from './drawingFunctions'
import type { Offset } from './types'
import { GEN3_MM_PER_CELL, GEN3_RUN_DOCK, GEN3_RUN_END, GEN3_RUN_NOT_PATH, GEN3_RUN_START, cellsCentre } from './gen3Run'
import { useCleaning, usePersistentMap } from '../../loaders/resources'
import { useRobot } from '../../context/useRobot'
import { RobotType } from '../../types'
import { loadSelectedMapShape } from '../../pages/settings/mapshapes'

export interface MapSize { width: number; height: number }

export type ExtraDrawFn = (
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    zoom: number,
    offset: Offset,
    mapSize: MapSize,
    runMarkers?: RunMarkers // dock / end position read from the run (gen3)
) => void

// normalised positions of the gen3 run's marker blocks, if present
export interface RunMarkers { dock?: [number, number], start?: [number, number], end?: [number, number] }

interface UseMapOptions {
    mapId: string
    runId?: string
    shape?: CellShape
    fitOnLoad?: boolean
    extraDraw?: ExtraDrawFn
    // bump this to force a redraw when extraDraw's closed-over state changes
    // (boundaries, mode, currentLinePoints, etc.) without re-registering the RAF effect's deps.
    redrawKey?: unknown
    // CSS token used for the canvas background (default: --map-bg, the Runs panel)
    backgroundToken?: string
    // fit the view to the cells the run cleaned instead of the whole floor
    fitToRun?: boolean
    // normalised point that has to stay in view when fitting to the run, if the run has no dock marker
    fitInclude?: [number, number]
    // draw the run as the area the robot covered instead of its thin path
    coverage?: boolean
    // "plan" look: continuous floor and wall lines instead of the cell shapes
    plan?: boolean
}

export function useMap({
    mapId,
    runId,
    shape = loadSelectedMapShape(),
    fitOnLoad = true,
    extraDraw,
    redrawKey,
    backgroundToken,
    fitToRun,
    fitInclude,
    coverage,
    plan
}: UseMapOptions) {
    const canvasRef = useRef<HTMLCanvasElement | undefined>(undefined)
    const cellsRef = useRef<number[] | null>(null)
    const runCellsRef = useRef<number[] | null>(null)
    const runIgnoreSetRef = useRef<Set<number>>(new Set())
    const userInteractedRef = useRef(false)
    const extraDrawRef = useRef(extraDraw)
    extraDrawRef.current = extraDraw

    const [mapSize, setMapSize] = useState<MapSize>()
    const [runMarkers, setRunMarkers] = useState<RunMarkers>({})

    const { robot } = useRobot(); // TODO: in the future, the map should not know about the robot but meh for now

    const {
        zoom, offset, isDragging, hasMoved,
        handleMouseDown, handleMouseMove, handleMouseUp, handleWheel, handleGesture, handleDoubleClick,
        handleTouchStart, handleTouchMove, handleTouchEnd,
        centerView, zoomBy, setZoom, setOffset
    } = useCanvasViewport({ initialZoom: 4, initialOffset: { x: 0, y: 0 } })

    const draw = useCallback((currentZoom: number = zoom, currentOffset: Offset = offset) => {
        const canvas = canvasRef.current
        if (!canvas || !cellsRef.current || !mapSize) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return

        const covered = coverage && runCellsRef.current?.length === cellsRef.current.length
        if (plan) drawPlanFloor(ctx, canvas, cellsRef.current, currentZoom, currentOffset, mapSize, backgroundToken)
        else drawMap(
            ctx, canvas, cellsRef.current, currentZoom, currentOffset, mapSize,
            shape, covered ? null : runCellsRef.current,
            { getRunColor: colorForPathValue, ignoreRunValues: runIgnoreSetRef.current },
            backgroundToken
        )
        if (covered) drawCoverage(ctx, cellsRef.current, runCellsRef.current!, runIgnoreSetRef.current, currentZoom, currentOffset, mapSize, GEN3_MM_PER_CELL)
        // walls on top, so they stay sharp over the covered area
        if (plan) drawPlanWalls(ctx, cellsRef.current, currentZoom, currentOffset, mapSize)

        extraDrawRef.current?.(ctx, canvas, currentZoom, currentOffset, mapSize, runMarkers)
    }, [mapSize, shape, backgroundToken, runMarkers, coverage, plan])

    const onMouseDown = useCallback((e: React.MouseEvent) => {
        userInteractedRef.current = true
        handleMouseDown(e)
    }, [handleMouseDown])
    const onTouchStart = useCallback((e: React.TouchEvent) => {
        userInteractedRef.current = true
        handleTouchStart(e)
    }, [handleTouchStart])
    // wheel + Safari pinch need non-passive native listeners to keep the page itself from zooming
    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        const onWheel = (e: WheelEvent) => {
            userInteractedRef.current = true
            handleWheel(e)
        }
        const onGesture = (e: Event) => {
            userInteractedRef.current = true
            handleGesture(e)
        }
        canvas.addEventListener('wheel', onWheel, { passive: false })
        canvas.addEventListener('gesturestart', onGesture)
        canvas.addEventListener('gesturechange', onGesture)
        return () => {
            canvas.removeEventListener('wheel', onWheel)
            canvas.removeEventListener('gesturestart', onGesture)
            canvas.removeEventListener('gesturechange', onGesture)
        }
    }, [mapSize])

    const onDoubleClick = useCallback((e: React.MouseEvent) => {
        userInteractedRef.current = true
        handleDoubleClick(e)
    }, [handleDoubleClick])

    // zoom around the middle of the canvas (buttons, keyboard)
    const zoomStep = useCallback((factor: number) => {
        const canvas = canvasRef.current
        if (!canvas) return
        userInteractedRef.current = true
        zoomBy(factor, canvas.width / 2, canvas.height / 2)
    }, [zoomBy])

    const { data: persistantMapData, refresh: updatePersistantMapData } = usePersistentMap(mapId);
    const { data: cleaningData, refresh: updateCleaningData } = useCleaning(runId ?? '');

    useEffect(() => {
        updatePersistantMapData();
    }, [mapId])

    useEffect(() => {
        if (!runId) return;
        updateCleaningData()
    }, [runId])
    

    // Load floor map
    useEffect(() => {
        if (!persistantMapData) return
        cellsRef.current = decodeRLE(persistantMapData.rle)
        setMapSize({ height: persistantMapData.height, width: persistantMapData.width })
    }, [persistantMapData])

    useEffect(() => {
        // TODO: should size be matched?
        if (!cleaningData) return;
        const runCells = decodeRLE(cleaningData.rle);
        runCellsRef.current = runCells;
        if (robot.type === RobotType.NeatoGen3) {
            runIgnoreSetRef.current = GEN3_RUN_NOT_PATH
            setRunMarkers({
                dock: cellsCentre(runCells, cleaningData.width, cleaningData.height, GEN3_RUN_DOCK),
                start: cellsCentre(runCells, cleaningData.width, cleaningData.height, GEN3_RUN_START),
                end: cellsCentre(runCells, cleaningData.width, cleaningData.height, GEN3_RUN_END),
            })
        } else {
            runIgnoreSetRef.current = computeIgnoredRunValues(runCellsRef.current, 1);
        }
        draw()
    }, [cleaningData])

    // Redraw on viewport change, or when caller's overlay-relevant state changes
    useEffect(() => {
        const id = requestAnimationFrame(() => draw(zoom, offset))
        return () => cancelAnimationFrame(id)
    }, [zoom, offset, draw, redrawKey])

    // what the view fits to: the whole floor, or with fitToRun the cleaned part plus fitInclude
    const calcFit = useCallback((width: number, height: number) => {
        if (!cellsRef.current || !mapSize) return null
        const runBounds = fitToRun && runCellsRef.current
            ? getRunBounds(runCellsRef.current, runIgnoreSetRef.current, mapSize,
                [runMarkers.dock ?? fitInclude, runMarkers.start, runMarkers.end].filter(p => !!p))
            : null
        return runBounds
            ? calcFitToBounds(runBounds, width, height, DRAWING.MIN_ZOOM, DRAWING.MAX_ZOOM, 0.8)
            : calcFitZoomAndOffset(cellsRef.current, mapSize, width, height, DRAWING.MIN_ZOOM, DRAWING.MAX_ZOOM)
    }, [mapSize, fitToRun, fitInclude?.[0], fitInclude?.[1], runMarkers])

    // the run and the dock arrive after the floor: fit again unless the user moved the map
    useEffect(() => {
        const canvas = canvasRef.current
        if (!fitToRun || !canvas || userInteractedRef.current) return
        const fit = calcFit(canvas.width, canvas.height)
        if (fit) {
            setZoom(fit.zoom)
            setOffset(fit.offset)
        }
    }, [calcFit, cleaningData])

    // Resize-to-container + fit-to-content
    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        const parent = canvas.parentElement
        if (!parent) return

        const resizeToContainer = () => {
            const { width, height } = parent.getBoundingClientRect()
            canvas.width = width
            canvas.height = height

            if (fitOnLoad && cellsRef.current && mapSize && !userInteractedRef.current) {
                const fit = calcFit(width, height)
                if (fit) {
                    setZoom(fit.zoom)
                    setOffset(fit.offset)
                    return
                }
                centerView(mapSize.width, mapSize.height, 4, width, height)
                return
            }
            draw()
        }

        resizeToContainer()
        const ro = new ResizeObserver(resizeToContainer)
        ro.observe(parent)
        return () => ro.disconnect()
    }, [mapSize, fitOnLoad])

    // Selecting a different map should auto-fit, not inherit the previous map's pan/zoom.
    useEffect(() => {
        userInteractedRef.current = false
    }, [mapId])

    const resetView = useCallback(() => {
        userInteractedRef.current = false
        const canvas = canvasRef.current
        const parent = canvas?.parentElement
        if (!canvas || !parent || !cellsRef.current || !mapSize) return
        const { width, height } = parent.getBoundingClientRect()
        const fit = calcFit(width, height)
        if (fit) {
            setZoom(fit.zoom)
            setOffset(fit.offset)
        }
    }, [mapSize, calcFit])

    return {
        canvasRef, cellsRef, mapSize,
        zoom, offset, isDragging, hasMoved,
        canvasHandlers: {
            onMouseDown,
            onMouseMove: handleMouseMove,
            onMouseUp: handleMouseUp,
            onMouseLeave: handleMouseUp,
            onDoubleClick,
            onTouchStart,
            onTouchMove: handleTouchMove,
            onTouchEnd: handleTouchEnd
        },
        draw,
        resetView,
        zoomStep
    }
}