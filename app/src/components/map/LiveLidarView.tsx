import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Http, type LiveLidar } from '../../http'
import { useLiveScan } from '../../context/liveScan'
import { useMascot } from '../../mascot'
import { COLORS } from './constants'
import { drawLidarPoints, drawLiveRobot, type RobotImage } from './drawingFunctions'
import styles from './LiveLidarView.module.scss'

// What a gen3 robot's lidar saw in the clean running now (server gen3/lidar.py), drawn on its own: the
// grid it built so far (free floor, and where something stands), its way, the robot, and the turn it
// sees right now. Needs no stored map; when its frame lies on one, the view is turned like that map.

const POLL_MS = 4000          // the grid grows slowly: fetched this often
const PAD_PX = 14
const SCAN_FRESH_S = 5

interface Props {
    serial: string
    // false: nothing to show (yet) -> the caller shows something else
    onAvailable?: (available: boolean) => void
}

export default function LiveLidarView({ serial, onAvailable }: Props) {
    const { t } = useTranslation()
    const liveScan = useLiveScan()
    const { mascot } = useMascot()
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const [data, setData] = useState<LiveLidar | null>(null)
    const [gridImg, setGridImg] = useState<HTMLCanvasElement | null>(null)
    const [robotImg, setRobotImg] = useState<RobotImage>()
    const [size, setSize] = useState({ w: 0, h: 0 })

    useEffect(() => {
        const img = new Image()
        img.onload = () => setRobotImg({ img, turns: mascot.id === 'robot' })
        img.src = mascot.src
    }, [mascot.src, mascot.id])

    // the grid so far, again every POLL_MS
    useEffect(() => {
        let cancelled = false
        const load = () => Http.getLiveLidar(serial)
            .then(res => { if (!cancelled) setData(res.data) })
            .catch(() => { })
        load()
        const id = window.setInterval(load, POLL_MS)
        return () => { cancelled = true; clearInterval(id) }
    }, [serial])
    useEffect(() => onAvailable?.(!!data), [!!data]) // eslint-disable-line react-hooks/exhaustive-deps

    // the grid's PNG (grey: 0 unknown, 128 free, 255 something there) in the map's colours, once per grid
    useEffect(() => {
        if (!data) return
        const img = new Image()
        img.onload = () => {
            const c = document.createElement('canvas')
            c.width = img.width
            c.height = img.height
            const ctx = c.getContext('2d')!
            ctx.drawImage(img, 0, 0)
            const px = ctx.getImageData(0, 0, c.width, c.height)
            const free = rgba(COLORS.EMPTY), wall = rgba(COLORS.WALL)
            for (let i = 0; i < px.data.length; i += 4) {
                const v = px.data[i]
                const col = v > 191 ? wall : v > 64 ? free : null
                if (col) { px.data[i] = col[0]; px.data[i + 1] = col[1]; px.data[i + 2] = col[2]; px.data[i + 3] = col[3] }
                else px.data[i + 3] = 0
            }
            ctx.putImageData(px, 0, 0)
            setGridImg(c)
        }
        img.src = `data:image/png;base64,${data.grid.png}`
    }, [data?.grid.png])

    // canvas size follows its box (the canvas is there once the first data is)
    const hasData = !!data
    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas?.parentElement) return
        const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }))
        ro.observe(canvas.parentElement)
        return () => ro.disconnect()
    }, [hasData])

    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas || !data || !size.w || !size.h) return
        const dpr = window.devicePixelRatio || 1
        canvas.width = size.w * dpr
        canvas.height = size.h * dpr
        const ctx = canvas.getContext('2d')!
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.fillStyle = COLORS.BACKGROUND
        ctx.fillRect(0, 0, size.w, size.h)

        const g = data.grid
        // everything in grid cells (u right, v down) from the grid's top left corner
        const toCell = ([x, y]: [number, number]): [number, number] => [(x - g.x0) / g.cell, (g.y0 - y) / g.cell]
        // turned like the stored map it lies on (the map page keeps that per map)
        const angle = data.map ? storedAngle(data.map.mapId) : 0
        // fit the turned grid into the view
        const c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle))
        const bw = g.width * c + g.height * s, bh = g.width * s + g.height * c
        const zoom = Math.min((size.w - 2 * PAD_PX) / bw, (size.h - 2 * PAD_PX) / bh)
        ctx.translate(size.w / 2, size.h / 2)
        ctx.rotate(angle)
        const offset = { x: -g.width * zoom / 2, y: -g.height * zoom / 2 }

        if (gridImg) {
            ctx.imageSmoothingEnabled = false
            ctx.drawImage(gridImg, offset.x, offset.y, g.width * zoom, g.height * zoom)
        }
        const scan = liveScan && Date.now() / 1000 - liveScan.t < SCAN_FRESH_S ? liveScan.scan : null
        if (scan) drawLidarPoints(ctx, scan.pts.map(toCell), zoom, offset)
        const pose = scan?.pose ?? data.pose
        const way = [...data.track.map(toCell), toCell([pose[0], pose[1]])]
        // heading on screen: clockwise from right, y down
        drawLiveRobot(ctx, way, -pose[2], zoom, offset, g.cell, robotImg)
    }, [data, gridImg, liveScan, size, robotImg])

    if (!data) return null
    return (
        <div className={styles.view}>
            <div className={styles.canvasBox}><canvas ref={canvasRef} className={styles.canvas} /></div>
            <span className={styles.caption}>{t('home.lidarLive')}</span>
        </div>
    )
}

// the turn the map page keeps for a map on this device (components/map/useMap.ts)
function storedAngle(mapId: string): number {
    try { return Number(localStorage.getItem(`vacuula.mapAngle.${mapId}`)) || 0 } catch { return 0 }
}

// a CSS colour as [r, g, b, a 0-255]
function rgba(color: string): [number, number, number, number] {
    const c = document.createElement('canvas').getContext('2d')!
    c.fillStyle = color
    c.fillRect(0, 0, 1, 1)
    const d = c.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2], d[3]]
}
