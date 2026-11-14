import { useCallback, useEffect, useRef, useState } from 'react'
import type { LidarScan, LiveLidar } from '../../http'
import { useMascot } from '../../mascot'
import { COLORS } from './constants'
import { drawLidarPoints, drawLiveRobot, type RobotImage } from './drawingFunctions'
import styles from './LidarView.module.scss'
import { useCanvasViewport } from './useCanvasViewport'
import { lidarImage } from './lidarImage'

// What a gen3 robot's lidar saw in a clean (server gen3/lidar.py), drawn on its own: the grid (free
// floor, and where something stands), its way, the robot, and optionally the turn it sees right now.
// Needs no stored map; when the robot's frame lies on one, the view is turned like that map.
// Used live (LiveLidarView) and for a finished run (the run's details). Zoom, pan and turn like the maps
// (the same viewport: fingers, wheel, trackpad, double click); until then it fits itself to the grid.

const PAD_PX = 14

interface Props {
    data: LiveLidar
    scan?: LidarScan | null   // the turn to show now, live only
    caption?: string
}

export default function LidarView({ data, scan, caption }: Props) {
    const { mascot } = useMascot()
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const [gridImg, setGridImg] = useState<HTMLCanvasElement | null>(null)
    const [robotImg, setRobotImg] = useState<RobotImage>()
    const [size, setSize] = useState({ w: 0, h: 0 })
    const {
        zoom, offset, angle, setAngle, setZoom, setOffset, isDragging,
        handleMouseDown, handleMouseMove, handleMouseUp, handleWheel, handleGesture, handleDoubleClick,
        handleTouchStart, handleTouchMove, handleTouchEnd,
    } = useCanvasViewport({ initialZoom: 1, initialOffset: { x: 0, y: 0 }, canvasRef })
    // moved by hand: it no longer fits itself (live, the grid keeps growing)
    const touched = useRef(false)
    const touch = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => { touched.current = true; fn(...a) }

    useEffect(() => {
        const img = new Image()
        img.onload = () => setRobotImg({ img, turns: mascot.id === 'robot' })
        img.src = mascot.src
    }, [mascot.src, mascot.id])

    // the grid's PNG (grey: 0 unknown, 128 free, 255 something there) in the map's colours, once per grid
    useEffect(() => {
        let cancelled = false
        lidarImage(data.grid.png, [[128, COLORS.EMPTY], [255, COLORS.WALL]])
            .then(c => { if (!cancelled) setGridImg(c) }).catch(() => { })
        return () => { cancelled = true }
    }, [data.grid.png])

    // canvas size follows its box
    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas?.parentElement) return
        const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }))
        ro.observe(canvas.parentElement)
        return () => ro.disconnect()
    }, [])

    // turned like the stored map it lies on (the map page keeps that per map)
    const mapId = data.map?.mapId
    useEffect(() => { setAngle(mapId ? storedAngle(mapId) : 0) }, [mapId]) // eslint-disable-line react-hooks/exhaustive-deps

    // fit the (turned) grid into the view, until moved by hand
    const g = data.grid
    const fit = useCallback(() => {
        if (!size.w || !size.h) return
        const c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle))
        const bw = g.width * c + g.height * s, bh = g.width * s + g.height * c
        const z = Math.min((size.w - 2 * PAD_PX) / bw, (size.h - 2 * PAD_PX) / bh)
        setZoom(z)
        setOffset({ x: size.w / 2 - g.width * z / 2, y: size.h / 2 - g.height * z / 2 })
    }, [size.w, size.h, g.width, g.height, angle]) // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => { if (!touched.current) fit() }, [fit])

    // wheel and Safari's trackpad pinch need native listeners (React's are passive), as in useMap
    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        const wheel = (e: WheelEvent) => { touched.current = true; handleWheel(e) }
        const gesture = (e: Event) => { touched.current = true; handleGesture(e) }
        canvas.addEventListener('wheel', wheel, { passive: false })
        for (const t of ['gesturestart', 'gesturechange', 'gestureend']) canvas.addEventListener(t, gesture)
        return () => {
            canvas.removeEventListener('wheel', wheel)
            for (const t of ['gesturestart', 'gesturechange', 'gestureend']) canvas.removeEventListener(t, gesture)
        }
    })

    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas || !size.w || !size.h) return
        canvas.width = size.w
        canvas.height = size.h
        const ctx = canvas.getContext('2d')!
        ctx.fillStyle = COLORS.BACKGROUND
        ctx.fillRect(0, 0, size.w, size.h)
        // turned around the canvas centre, like the maps (useMap)
        ctx.translate(size.w / 2, size.h / 2)
        ctx.rotate(angle)
        ctx.translate(-size.w / 2, -size.h / 2)

        // everything in grid cells (u right, v down) from the grid's top left corner
        const toCell = ([x, y]: [number, number]): [number, number] => [(x - g.x0) / g.cell, (g.y0 - y) / g.cell]
        if (gridImg) {
            ctx.imageSmoothingEnabled = false
            ctx.drawImage(gridImg, offset.x, offset.y, g.width * zoom, g.height * zoom)
        }
        if (scan) drawLidarPoints(ctx, scan.pts.map(toCell), zoom, offset)
        const pose = scan?.pose ?? data.pose
        const way = [...data.track.map(toCell), toCell([pose[0], pose[1]])]
        // heading on screen: clockwise from right, y down
        drawLiveRobot(ctx, way, -pose[2], zoom, offset, g.cell, robotImg)
    }, [data, gridImg, scan, size, robotImg, zoom, offset, angle])

    return (
        <div className={styles.view}>
            <div className={styles.canvasBox}>
                <canvas ref={canvasRef} className={styles.canvas}
                    style={{ cursor: isDragging ? 'grabbing' : 'grab', touchAction: 'none' }}
                    onMouseDown={touch(handleMouseDown)} onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}
                    onDoubleClick={touch(handleDoubleClick)}
                    onTouchStart={touch(handleTouchStart)} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd} />
            </div>
            {caption && <span className={styles.caption}>{caption}</span>}
        </div>
    )
}

// the turn the map page keeps for a map on this device (components/map/useMap.ts)
function storedAngle(mapId: string): number {
    try { return Number(localStorage.getItem(`vacuula.mapAngle.${mapId}`)) || 0 } catch { return 0 }
}
