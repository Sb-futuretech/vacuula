import styles from './map.module.scss'
import { useMap } from './useMap'
import { useRobot } from '../../context/useRobot'
import { Neato, RobotType } from '../../types'
import Button from '../button/button'
import { Http } from '../../http'
import { usePersistentMap, usePersistentMaps, persistentMapLoader, useCleaning } from '../../loaders/resources'
import { fetchGen3MapBoundaries } from '../../loaders/gen3Boundaries'
import { useTranslation } from 'react-i18next'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { drawBase, drawMarker, drawStartFlag, drawZoneOverlay, pointInZone, onDockImageReady } from './drawingFunctions'
import { decodeRLE } from './utils'
import type { ExtraDrawFn } from './useMap'
import { GEN3_MM_PER_CELL, GEN3_RUN_DOCK, GEN3_RUN_NOT_PATH, basePoint, cellsCentre, sameFloorDistance } from './gen3Run'
import type { VacuulaMapData, Zone } from './types'

interface MapProps {
    mapId: string
    runId?: string
    marker?: string // image drawn where the robot docks, instead of the dock symbol
    focusRun?: boolean // zoom to the cleaned part of the run, keeping the dock in view
    coverage?: boolean // show the area the robot covered instead of its thin path
    plan?: boolean // continuous floor and wall lines instead of the cell shapes
    zones?: boolean // show the zones of the stored map the run was on (gen3)
    startFlag?: boolean // a flag where the run started, if that was away from the dock
}

// a run starting closer than this to the dock (in map cells, ~40 cm) started from the dock: no flag
const START_FLAG_MIN_CELLS = 10

function basePoseFromMapData(data: VacuulaMapData, gen3: boolean) {
    const base = data.base
    const md = data.metadata
    const img = data.img_size
    const NO_BASE = 2147483647
    if (!Array.isArray(base) || base[0] === NO_BASE || base[1] === NO_BASE) return
    // gen3 stores the dock already normalised to the map image (0..1), without heading
    if (gen3) return { pose: { x: base[0], y: base[1], dir: 0 }, resolution: GEN3_MM_PER_CELL }
    if (!md || !Array.isArray(img)) return
    const resolution = md.resolution || GEN3_MM_PER_CELL
    return {
        pose: {
            x: ((base[0] - md.origin_x) / resolution) / img[0],
            y: ((base[1] - md.origin_y) / resolution) / img[1],
            dir: base[2] ?? 0,
        },
        resolution,
    }
}

export default function Map({ mapId, runId, marker, focusRun, coverage, plan, zones, startFlag }: MapProps) {
    const { t } = useTranslation()
    const { robot } = useRobot()
    const { data: persistantMapData, refresh: refreshPersistantMapData } = usePersistentMap(mapId);

    const [dockReady, setDockReady] = useState(false)
    useEffect(() => { onDockImageReady(() => setDockReady(true)) }, [])

    const [markerImage, setMarkerImage] = useState<HTMLImageElement>()
    useEffect(() => {
        if (!marker) return setMarkerImage(undefined)
        const img = new Image()
        img.onload = () => setMarkerImage(img)
        img.src = marker
    }, [marker])

    // the run's own cells (gen3): its dock block and the zones its path went through
    const { data: cleaningData } = useCleaning(runId ?? '')
    const runCells = useMemo(() => cleaningData ? decodeRLE(cleaningData.rle) : undefined, [cleaningData])

    // Zones belong to a stored map, but every gen3 run has its own map id. Runs on a stored map share
    // its grid, so its zones (normalised vertices) fit the run: take the enabled stored map on the same
    // floor, the one whose dock is closest if there are several. No match, no zones.
    const { data: storedMaps } = usePersistentMaps()
    const [runZones, setRunZones] = useState<Zone[]>([])
    useEffect(() => {
        setRunZones([])
        if (!zones || !runId || robot.type !== RobotType.NeatoGen3 || !persistantMapData || !storedMaps || !runCells || !cleaningData) return
        let cancelled = false
        const run = {
            width: persistantMapData.width,
            height: persistantMapData.height,
            dock: cellsCentre(runCells, cleaningData.width, cleaningData.height, GEN3_RUN_DOCK),
        }
        ;(async () => {
            let best: { id: string, distance: number } | undefined
            for (const m of storedMaps as Neato.Gen3.PersistentMap[]) {
                if (!m.enabled || m.id === mapId) continue
                const data = await persistentMapLoader.request(robot.serial, m.id).catch(() => undefined)
                const distance = data && sameFloorDistance(run, { width: data.width, height: data.height, dock: basePoint(data.base) })
                if (distance != null && (!best || distance < best.distance)) best = { id: m.id, distance }
            }
            if (!best) return
            const boundaries = await fetchGen3MapBoundaries(robot.serial, best.id).catch(() => [])
            if (!cancelled) setRunZones(boundaries.filter((b): b is Zone => b.type === 'polygon'))
        })()
        return () => { cancelled = true }
    }, [zones, runId, mapId, persistantMapData, storedMaps, runCells, cleaningData])

    const visitedZones = useMemo(() => {
        const visited = new Set<string>()
        if (!runZones.length || !runCells || !cleaningData) return visited
        const { width, height } = cleaningData
        for (let i = 0; i < runCells.length; i++) {
            if (runCells[i] === 0 || GEN3_RUN_NOT_PATH.has(runCells[i])) continue
            const p: [number, number] = [(i % width + 0.5) / width, (Math.floor(i / width) + 0.5) / height]
            for (const zone of runZones) if (!visited.has(zone.id) && pointInZone(p, zone)) visited.add(zone.id)
        }
        return visited
    }, [runZones, runCells, cleaningData])

    const extraDraw = useCallback<ExtraDrawFn>((ctx, _canvas, zoom, offset, mapSize, runMarkers) => {
        if (!persistantMapData) return
        if (runZones.length) drawZoneOverlay(ctx, runZones, visitedZones, zoom, offset, mapSize)
        // the run's own markers are exact; the stored base is only a fallback (gen3 derives it
        // from the dock and start markers together). The mascot goes where the robot ended.
        const at = (p: [number, number]) => ({ pose: { x: p[0], y: p[1], dir: 0 }, resolution: GEN3_MM_PER_CELL })
        const gen3Run = robot.type === RobotType.NeatoGen3 && !!runId
        // a gen3 run without its dock block (canceled) would get the start position as stored base
        const stored = gen3Run ? undefined : basePoseFromMapData(persistantMapData, robot.type === RobotType.NeatoGen3)
        const dock = runMarkers?.dock ? at(runMarkers.dock) : stored
        if (dock) drawBase(ctx, dock.pose, zoom, offset, mapSize, dock.resolution)

        // a flag where the run started, if that was clearly away from the dock (or, without a dock
        // block, from where it ended - runs usually end back on the dock)
        const start = runMarkers?.start
        const ref = dock ? [dock.pose.x, dock.pose.y] : runMarkers?.end
        const far = start && ref && Math.hypot((start[0] - ref[0]) * mapSize.width, (start[1] - ref[1]) * mapSize.height) > START_FLAG_MIN_CELLS
        if (startFlag && start && far) drawStartFlag(ctx, { x: start[0], y: start[1] }, zoom, offset, mapSize)

        const robotAt = runMarkers?.end ? at(runMarkers.end) : dock
        if (markerImage && robotAt) drawMarker(ctx, markerImage, robotAt.pose, zoom, offset, mapSize, robotAt.resolution)
    }, [persistantMapData, dockReady, markerImage, runId, runZones, visitedZones, startFlag])

    const dock = persistantMapData && basePoseFromMapData(persistantMapData, robot.type === RobotType.NeatoGen3)?.pose

    const { canvasRef, isDragging, canvasHandlers } = useMap({
        mapId,
        runId,
        extraDraw,
        redrawKey: extraDraw,
        fitToRun: focusRun,
        coverage,
        plan,
        fitInclude: dock ? [dock.x, dock.y] : undefined,
    })

    return (
        <>
            <div className={styles.container}>
                <canvas
                    ref={canvasRef}
                    className={styles.canvas}
                    {...canvasHandlers}
                    style={{
                        cursor: isDragging ? 'grabbing' : 'grab',
                        touchAction: 'none'
                    }}
                />

            </div>
            {robot.type === RobotType.NeatoGen4 && !persistantMapData?.in_maps_list && (
                <div style={{ padding: '1.5rem' }}>
                    <Button text={t('map.useAsFloormap')} style='success' onClick={() => { Http.postUseMapAsFloorPlan(robot.serial, mapId).then(refreshPersistantMapData) }} />
                </div>
            )}
        </>
    )
}
