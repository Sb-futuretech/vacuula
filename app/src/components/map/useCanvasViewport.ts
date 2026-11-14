import { useRef, useState } from 'react'
import type { Offset, TouchState } from './types'
import { DRAWING } from './constants'
import { getTouchDistance, getTouchAngle } from './utils'

interface Props {
    initialZoom: number
    initialOffset: Offset
    // the canvas, for its centre: the view turns around the middle of the canvas
    canvasRef?: React.RefObject<HTMLCanvasElement | null | undefined>
}

// a two-finger twist turns the map only once it passed this, so a pinch to zoom does not turn it
const TWIST_START = 12 * Math.PI / 180
// letting go this close to a quarter turn snaps to it
const SNAP = 8 * Math.PI / 180

// an angle in (-PI, PI]
export const normAngle = (a: number) => {
    a = a % (2 * Math.PI)
    if (a > Math.PI) a -= 2 * Math.PI
    if (a <= -Math.PI) a += 2 * Math.PI
    return a
}

export const useCanvasViewport = ({
    initialZoom,
    initialOffset,
    canvasRef
}: Props) => {
    const [zoom, setZoom] = useState(initialZoom)
    const [offset, setOffset] = useState(initialOffset)

    // Rotation of the view (radians, clockwise on screen) around the canvas centre. Zoom, offset and
    // every hit test work in "unrotated" canvas coordinates: a screen point is turned back around the
    // centre first (toMapScreen), so the rest of the map code does not need to know about it.
    const [angle, setAngleState] = useState(0)
    const angleRef = useRef(0)
    const setAngle = (a: number) => {
        angleRef.current = normAngle(a)
        setAngleState(angleRef.current)
    }
    const centre = () => {
        const c = canvasRef?.current
        return c ? { x: c.width / 2, y: c.height / 2 } : { x: 0, y: 0 }
    }
    const unrotate = (x: number, y: number, a: number) => {
        if (!a) return { x, y }
        const c = centre(), cos = Math.cos(-a), sin = Math.sin(-a)
        const dx = x - c.x, dy = y - c.y
        return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos }
    }
    // a canvas point (CSS px) as the map code sees it (before the view's rotation)
    const toMapScreen = (x: number, y: number) => unrotate(x, y, angleRef.current)

    // turn the view by `delta`; the map point under `pivot` (canvas px) stays where it is
    const rotateBy = (delta: number, pivot?: { x: number, y: number }) => {
        const a0 = angleRef.current, a1 = normAngle(a0 + delta)
        if (pivot) {
            const u0 = unrotate(pivot.x, pivot.y, a0), u1 = unrotate(pivot.x, pivot.y, a1)
            setOffset(prev => ({ x: prev.x + u1.x - u0.x, y: prev.y + u1.y - u0.y }))
        }
        setAngle(a1)
    }
    // close to a quarter turn: snap to it (around the centre)
    const snapAngle = () => {
        const q = Math.round(angleRef.current / (Math.PI / 2)) * (Math.PI / 2)
        if (Math.abs(angleRef.current - q) < SNAP && angleRef.current !== q) setAngle(q)
    }

    const [isDragging, setIsDragging] = useState(false)
    const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
    // touch state in refs, not state: several touchmove events arrive between two renders, and each
    // has to compare with the previous one (state would hand them all the same old pinch distance,
    // so the zoom jumped). touchActive: fingers are down -- iOS then also fires its own gesture
    // events for the same pinch, which must not zoom a second time
    const touchStartRef = useRef<TouchState | null>(null)
    const touchDragRef = useRef<{ x: number, y: number } | null>(null)
    const touchActiveRef = useRef(false)
    // two-finger twist: how far it turned in this gesture, and whether it turns the map yet
    const twistRef = useRef(0)
    const turningRef = useRef(false)
    const [hasMoved, setHasMoved] = useState(false)

    // a drag on screen, turned back into the unrotated map coordinates
    const pan = (dx: number, dy: number) => {
        const a = -angleRef.current, cos = Math.cos(a), sin = Math.sin(a)
        const rx = dx * cos - dy * sin, ry = dx * sin + dy * cos
        setOffset(prev => ({
            x: prev.x + rx,
            y: prev.y + ry
        }))
    }

    // Multiplies the zoom by `factor` (clamped) around a point on the canvas. Nests the offset
    // update inside the zoom update's functional form so both always read the truly-latest
    // committed state, rather than the `zoom`/`offset` closed over when this render's handlers
    // were created — matters during fast pinches/wheels, where several events can fire before
    // React re-renders in between.
    const zoomBy = (factor: number, screenX: number, screenY: number) => {
        const { x: centerX, y: centerY } = unrotate(screenX, screenY, angleRef.current)
        setZoom(prevZoom => {
            const newZoom = Math.max(DRAWING.MIN_ZOOM, Math.min(DRAWING.MAX_ZOOM, prevZoom * factor))
            setOffset(prevOffset => ({
                x: centerX - (centerX - prevOffset.x) / prevZoom * newZoom,
                y: centerY - (centerY - prevOffset.y) / prevZoom * newZoom
            }))
            return newZoom
        })
    }

    // ─────────────────────────────
    // Mouse
    // ─────────────────────────────

    const handleMouseDown = (e: React.MouseEvent) => {
        setIsDragging(true)
        setDragStart({ x: e.clientX, y: e.clientY })
        setHasMoved(false)
    }

    const handleMouseMove = (e: React.MouseEvent) => {
        if (!isDragging) return

        const dx = e.clientX - dragStart.x
        const dy = e.clientY - dragStart.y

        if (
            Math.abs(dx) >= DRAWING.MIN_MOVEMENT ||
            Math.abs(dy) >= DRAWING.MIN_MOVEMENT
        ) {
            setHasMoved(true)
            pan(dx, dy)

            setDragStart({
                x: e.clientX,
                y: e.clientY
            })
        }
    }

    const handleMouseUp = () => {
        setIsDragging(false)
        setHasMoved(false)
    }

    // Native listener (see useMap): React's onWheel is passive, so it cannot stop the browser
    // from zooming the whole page on a trackpad pinch. A trackpad sends many small deltas and a
    // mouse a few big ones, so the zoom follows deltaY instead of a fixed step per event.
    const handleWheel = (e: WheelEvent) => {
        e.preventDefault()
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
        const delta = Math.max(-100, Math.min(100, e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16 : e.deltaY))
        const speed = e.ctrlKey ? DRAWING.PINCH_WHEEL_ZOOM_SPEED : DRAWING.WHEEL_ZOOM_SPEED
        zoomBy(Math.exp(-delta * speed), e.clientX - rect.left, e.clientY - rect.top)
    }

    // Safari reports trackpad pinches as its own gesture events instead of ctrl+wheel
    const gestureScaleRef = useRef(1)
    const handleGesture = (e: Event) => {
        e.preventDefault()
        if (touchActiveRef.current) return // a touch screen: the touch events do the pinch
        const g = e as Event & { scale: number, rotation: number, clientX: number, clientY: number }
        if (e.type === 'gesturestart') {
            gestureScaleRef.current = 1
            gestureRotationRef.current = 0
            gestureTurningRef.current = false
            return
        }
        if (e.type === 'gestureend') {
            if (gestureTurningRef.current) snapAngle()
            return
        }
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
        const at = { x: g.clientX - rect.left, y: g.clientY - rect.top }
        zoomBy(g.scale / gestureScaleRef.current, at.x, at.y)
        gestureScaleRef.current = g.scale
        // trackpad twist (degrees, from the start of the gesture)
        const turned = (g.rotation ?? 0) * Math.PI / 180
        if (!gestureTurningRef.current && Math.abs(turned) > TWIST_START) {
            gestureTurningRef.current = true
            rotateBy(turned, at)
        } else if (gestureTurningRef.current) rotateBy(turned - gestureRotationRef.current, at)
        if (gestureTurningRef.current) gestureRotationRef.current = turned
    }
    const gestureRotationRef = useRef(0)
    const gestureTurningRef = useRef(false)

    const handleDoubleClick = (e: React.MouseEvent) => {
        const rect = e.currentTarget.getBoundingClientRect()
        zoomBy(DRAWING.ZOOM_STEP, e.clientX - rect.left, e.clientY - rect.top)
    }

    // ─────────────────────────────
    // Touch
    // ─────────────────────────────

    const handleTouchStart = (e: React.TouchEvent) => {
        const t = e.touches
        touchActiveRef.current = true

        if (t.length === 1) {
            setIsDragging(true)
            touchDragRef.current = { x: t[0].clientX, y: t[0].clientY }
            touchStartRef.current = null
            setHasMoved(false)
        } else if (t.length === 2) {
            const distance = getTouchDistance(t[0], t[1])
            // Guard: fingers landing almost on top of each other give a near-zero
            // distance, which would blow up the ratio in handleTouchMove on the very
            // first move and snap zoom to an extreme it then gets stuck at.
            touchStartRef.current = distance > DRAWING.MIN_PINCH_DISTANCE
                ? { distance, angle: getTouchAngle(t[0], t[1]) }
                : null
            touchDragRef.current = null
            twistRef.current = 0
            turningRef.current = false
            setIsDragging(false)
        }
    }

    const handleTouchMove = (e: React.TouchEvent) => {
        const t = e.touches
        setHasMoved(true)

        const drag = touchDragRef.current
        if (t.length === 1 && drag) {
            const dx = t[0].clientX - drag.x
            const dy = t[0].clientY - drag.y

            if (
                Math.abs(dx) >= DRAWING.MIN_MOVEMENT ||
                Math.abs(dy) >= DRAWING.MIN_MOVEMENT
            ) {
                pan(dx, dy)
                touchDragRef.current = { x: t[0].clientX, y: t[0].clientY }
            }
        }

        const start = touchStartRef.current
        if (t.length === 2 && start) {
            const rect = e.currentTarget.getBoundingClientRect()
            const distance = getTouchDistance(t[0], t[1])

            // Same guard as touchstart — fingers sliding to briefly overlap mid-gesture
            // shouldn't divide by near-zero either.
            if (distance > DRAWING.MIN_PINCH_DISTANCE) {
                const ratio = distance / start.distance
                const centerX = (t[0].clientX + t[1].clientX) / 2 - rect.left
                const centerY = (t[0].clientY + t[1].clientY) / 2 - rect.top

                zoomBy(Math.pow(ratio, DRAWING.PINCH_ZOOM_POWER), centerX, centerY)

                const angleNow = getTouchAngle(t[0], t[1])
                const turned = normAngle(angleNow - start.angle)
                twistRef.current += turned
                if (!turningRef.current && Math.abs(twistRef.current) > TWIST_START) {
                    turningRef.current = true
                    rotateBy(twistRef.current, { x: centerX, y: centerY })
                } else if (turningRef.current) rotateBy(turned, { x: centerX, y: centerY })

                touchStartRef.current = { distance, angle: angleNow }
            }
        }
    }

    // Lifting one finger of a pinch a moment before the other (the normal case) hands off to a
    // one-finger pan from where that finger is, instead of losing the gesture.
    const handleTouchEnd = (e: React.TouchEvent) => {
        const remaining = e.touches
        touchStartRef.current = null

        if (remaining.length === 1) {
            setIsDragging(true)
            touchDragRef.current = { x: remaining[0].clientX, y: remaining[0].clientY }
        } else {
            setIsDragging(false)
            touchDragRef.current = null
        }

        if (remaining.length === 0) {
            setHasMoved(false)
            touchActiveRef.current = false
            if (turningRef.current) snapAngle()
            turningRef.current = false
        }
    }

    const centerView = (
    mapWidth: number,
    mapHeight: number,
    baseZoom: number,
    canvasWidth: number,
    canvasHeight: number
    ) => {
        setZoom(baseZoom)

        setOffset({
            x: canvasWidth / 2 - (mapWidth * baseZoom) / 2,
            y: canvasHeight / 2 - (mapHeight * baseZoom) / 2
        })
    }

    return {
        // viewport state
        zoom,
        offset,

        // interaction state
        isDragging,
        hasMoved,

        // handlers
        handleMouseDown,
        handleMouseMove,
        handleMouseUp,
        handleWheel,
        handleGesture,
        handleDoubleClick,
        handleTouchStart,
        handleTouchMove,
        handleTouchEnd,

        centerView,
        zoomBy,
        setZoom,
        setOffset,

        // rotation
        angle,
        setAngle,
        rotateBy,
        toMapScreen
    }
}