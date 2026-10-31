import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styles from './map.module.scss'
import type { Point } from '../../components/map/types'

interface PointEditorProps {
    index: number
    point: Point
    previous: Point | null // the point before it on the line, for the distance shown
    mapSize: { width: number, height: number }
    mmPerPixel: number
    onChange: (point: Point) => void
    onDelete: () => void
    onDone: () => void
}

// The selected point's position in cm from the map's top-left corner (as on the rulers), editable.
export default function PointEditor({ index, point, previous, mapSize, mmPerPixel, onChange, onDelete, onDone }: PointEditorProps) {
    const { t } = useTranslation()
    const mapMm = { x: mapSize.width * mmPerPixel, y: mapSize.height * mmPerPixel }
    const xCm = Math.round(point[0] * mapMm.x / 10)
    const yCm = Math.round(point[1] * mapMm.y / 10)

    // drafts so a half-typed value (empty, "-") does not snap back; follow the point when it moves
    const [draftX, setDraftX] = useState(String(xCm))
    const [draftY, setDraftY] = useState(String(yCm))
    useEffect(() => setDraftX(String(xCm)), [xCm, index])
    useEffect(() => setDraftY(String(yCm)), [yCm, index])

    const commit = (axis: 'x' | 'y', value: string) => {
        axis === 'x' ? setDraftX(value) : setDraftY(value)
        const cm = Number(value)
        if (value.trim() === '' || !Number.isFinite(cm)) return
        const max = axis === 'x' ? mapMm.x : mapMm.y
        const frac = Math.min(max, Math.max(0, cm * 10)) / max
        onChange(axis === 'x' ? [frac, point[1]] : [point[0], frac])
    }

    const fromPrevCm = previous && Math.round(Math.hypot(
        (point[0] - previous[0]) * mapMm.x, (point[1] - previous[1]) * mapMm.y) / 10)

    return (
        <div className={styles.pointEditor}>
            <div className={styles.pointEditorTitle}>{t('map.pointTitle', { n: index + 1 })}</div>
            <div className={styles.pointEditorFields}>
                <label>X <input id="point-x" type="number" inputMode="numeric" value={draftX} onChange={e => commit('x', e.target.value)} /> cm</label>
                <label>Y <input id="point-y" type="number" inputMode="numeric" value={draftY} onChange={e => commit('y', e.target.value)} /> cm</label>
            </div>
            {fromPrevCm !== null && <div className={styles.pointEditorHint}>{t('map.pointFromPrevious', { cm: fromPrevCm })}</div>}
            <div className={styles.pointEditorActions}>
                <button onClick={onDelete}>{t('map.pointDelete')}</button>
                <button onClick={onDone}>{t('common.ok')}</button>
            </div>
        </div>
    )
}
