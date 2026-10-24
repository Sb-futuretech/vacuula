import styles from './map.module.scss'
import { useMap } from './useMap'
import { useRobot } from '../../context/useRobot'
import { RobotType } from '../../types'
import Button from '../button/button'
import { Http } from '../../http'
import { usePersistentMap } from '../../loaders/resources'
import { useTranslation } from 'react-i18next'
import { useCallback, useEffect, useState } from 'react'
import { drawBase, drawMarker, onDockImageReady } from './drawingFunctions'
import type { ExtraDrawFn } from './useMap'
import type { VacuulaMapData } from './types'

interface MapProps {
    mapId: string
    runId?: string
    marker?: string // image drawn where the robot docks, instead of the dock symbol
}

function basePoseFromMapData(data: VacuulaMapData) {
    const base = data.base
    const md = data.metadata
    const img = data.img_size
    if (!Array.isArray(base) || !md || !Array.isArray(img)) return
    const NO_BASE = 2147483647
    if (base[0] === NO_BASE || base[1] === NO_BASE) return
    const resolution = md.resolution || 40
    return {
        pose: {
            x: ((base[0] - md.origin_x) / resolution) / img[0],
            y: ((base[1] - md.origin_y) / resolution) / img[1],
            dir: base[2] ?? 0,
        },
        resolution,
    }
}

export default function Map({ mapId, runId, marker }: MapProps) {
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

    const extraDraw = useCallback<ExtraDrawFn>((ctx, _canvas, zoom, offset, mapSize) => {
        if (!persistantMapData) return
        const b = basePoseFromMapData(persistantMapData)
        if (!b) return
        if (markerImage) drawMarker(ctx, markerImage, b.pose, zoom, offset, mapSize, b.resolution)
        else drawBase(ctx, b.pose, zoom, offset, mapSize, b.resolution)
    }, [persistantMapData, dockReady, markerImage])

    const { canvasRef, isDragging, canvasHandlers } = useMap({
        mapId,
        runId,
        extraDraw,
        redrawKey: extraDraw,
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
