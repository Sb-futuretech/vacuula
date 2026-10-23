import { useRef, useState } from 'react'
import type { Offset, TouchState } from './types'
import { DRAWING } from './constants'
import { getTouchDistance, getTouchAngle } from './utils'

interface Props {
    initialZoom: number
    initialOffset: Offset
}

export const useCanvasViewport = ({
    initialZoom,
    initialOffset
}: Props) => {
    const [zoom, setZoom] = useState(initialZoom)
    const [offset, setOffset] = useState(initialOffset)

    const [isDragging, setIsDragging] = useState(false)
    const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
    const [touchStart, setTouchStart] = useState<TouchState | null>(null)
    const [hasMoved, setHasMoved] = useState(false)

    const pan = (dx: number, dy: number) => {
        setOffset(prev => ({
            x: prev.x + dx,
            y: prev.y + dy
        }))
    }

    // Nests the offset update inside the zoom update's functional form so both always read
    // the truly-latest committed state, rather than the `zoom`/`offset` closed over when
    // this render's handleTouchMove was created — matters during fast pinches, where several
    // touchmove events can fire before React re-renders in between.
    const zoomAt = (newZoom: number, centerX: number, centerY: number) => {
        setZoom(prevZoom => {
            setOffset(prevOffset => {
                const worldX = (centerX - prevOffset.x) / prevZoom
                const worldY = (centerY - prevOffset.y) / prevZoom

                return {
                    x: centerX - worldX * newZoom,
                    y: centerY - worldY * newZoom
                }
            })
            return newZoom
        })
    }

    // Same as zoomAt, but relative to the current zoom and clamped to the allowed range
    const zoomBy = (factor: number, centerX: number, centerY: number) => {
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
        const g = e as Event & { scale: number, clientX: number, clientY: number }
        if (e.type === 'gesturestart') {
            gestureScaleRef.current = 1
            return
        }
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
        zoomBy(g.scale / gestureScaleRef.current, g.clientX - rect.left, g.clientY - rect.top)
        gestureScaleRef.current = g.scale
    }

    const handleDoubleClick = (e: React.MouseEvent) => {
        const rect = e.currentTarget.getBoundingClientRect()
        zoomBy(DRAWING.ZOOM_STEP, e.clientX - rect.left, e.clientY - rect.top)
    }

    // ─────────────────────────────
    // Touch
    // ─────────────────────────────

    const handleTouchStart = (e: React.TouchEvent) => {
        const t = e.touches

        if (t.length === 1) {
            setIsDragging(true)
            setDragStart({ x: t[0].clientX, y: t[0].clientY })
            setTouchStart(null)
            setHasMoved(false)
        } else if (t.length === 2) {
            const distance = getTouchDistance(t[0], t[1])
            // Guard: fingers landing almost on top of each other give a near-zero
            // distance, which would blow up the ratio in handleTouchMove on the very
            // first move and snap zoom to an extreme it then gets stuck at.
            setTouchStart(distance > DRAWING.MIN_PINCH_DISTANCE
                ? { distance, angle: getTouchAngle(t[0], t[1]) }
                : null)
            setIsDragging(false)
        }
    }

    const handleTouchMove = (e: React.TouchEvent) => {
        const t = e.touches
        setHasMoved(true)

        if (t.length === 1 && isDragging) {
            const dx = t[0].clientX - dragStart.x
            const dy = t[0].clientY - dragStart.y

            if (
                Math.abs(dx) >= DRAWING.MIN_MOVEMENT ||
                Math.abs(dy) >= DRAWING.MIN_MOVEMENT
            ) {
                pan(dx, dy)

                setDragStart({
                    x: t[0].clientX,
                    y: t[0].clientY
                })
            }
        }

        if (t.length === 2 && touchStart) {
            const rect = e.currentTarget.getBoundingClientRect()
            const distance = getTouchDistance(t[0], t[1])

            // Same guard as touchstart — fingers sliding to briefly overlap mid-gesture
            // shouldn't divide by near-zero either.
            if (distance > DRAWING.MIN_PINCH_DISTANCE) {
                const ratio = distance / touchStart.distance

                const newZoom = Math.max(
                    DRAWING.MIN_ZOOM,
                    Math.min(DRAWING.MAX_ZOOM, zoom * Math.pow(ratio, DRAWING.PINCH_ZOOM_POWER))
                )

                const centerX = (t[0].clientX + t[1].clientX) / 2 - rect.left
                const centerY = (t[0].clientY + t[1].clientY) / 2 - rect.top

                zoomAt(newZoom, centerX, centerY)

                setTouchStart({ distance, angle: getTouchAngle(t[0], t[1]) })
            }
        }
    }

    // *** The main fix ***
    // Previously this unconditionally cleared everything, so lifting either finger out of
    // a pinch a moment before the other (the normal case — hands don't lift in perfect
    // sync) killed the gesture. Now it checks what's still down: with one finger
    // remaining, hand off cleanly into a single-finger pan from its current position
    // instead of losing tracking until every finger comes up.
    const handleTouchEnd = (e: React.TouchEvent) => {
        const remaining = e.touches

        if (remaining.length === 1) {
            setIsDragging(true)
            setDragStart({ x: remaining[0].clientX, y: remaining[0].clientY })
            setTouchStart(null)
        } else {
            setIsDragging(false)
            setTouchStart(null)
        }

        if (remaining.length === 0) {
            setHasMoved(false)
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
        setOffset
    }
}