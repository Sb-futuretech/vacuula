import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from './drawer.module.scss'
import { FaArrowLeft } from "react-icons/fa";
import { useTranslation } from "react-i18next";
import { useIsDesktop } from "../../utils/useIsDesktop";



// Two kinds:
// - handle: a sheet at the bottom of its page with a handle to drag it (the map). It is as tall as its
//   content, at most maxHeightPercent of the page (then the content scrolls); closed, it slides down
//   until only the handle shows. Open or closed is the one state (props.open), nothing else sets it.
// - no handle: a modal sheet over the whole app with a dimmed backdrop. It is as tall as its content
//   (at most nearly the screen), only its content scrolls, and `footer` stays visible below it.
interface DrawerProps {
    handle: boolean
    open: boolean,
    maxHeightPercent?: number // handle sheets only: at most this share of the page (default 88)
    onOpenChange?: (open: boolean) => void,
    children?: React.ReactNode,
    footer?: React.ReactNode
    title?: string,

    showBackButton?: boolean
    onBackButtonClick?: () => void

    // desktop: show as a fixed column next to the page instead of a bottom sheet
    sidePanel?: boolean
}

// a modal sheet pulled down further than this closes
const CLOSE_DRAG = 80
// a handle sheet let go while moving faster than this (px per move event) goes that way
const FLICK = 15

export default function Drawer(props: DrawerProps) {
    const { t } = useTranslation()
    const isPanel = useIsDesktop() && !!props.sidePanel
    // Per-gesture values, inside the event handlers
    const dragStartYRef = useRef(0)
    const dragStartXRef = useRef(0)
    const movedRef = useRef(false)

    // handle sheet: while the handle is dragged, how far down the sheet is (px, 0 = open); null otherwise
    const handleSheetRef = useRef<HTMLDivElement>(null)
    const handleRef = useRef<HTMLDivElement>(null)
    const [handleDrag, setHandleDrag] = useState<number | null>(null)
    const gestureRef = useRef<{ startY: number, base: number, closedAt: number, lastY: number, lastDelta: number, moved: boolean } | null>(null)

    // modal sheet: content stays mounted until the closing slide has ended; dragOffset follows the finger
    const [mounted, setMounted] = useState(false)
    const [dragOffset, setDragOffset] = useState<number | null>(null)
    const sheetRef = useRef<HTMLDivElement>(null)
    const isModal = !props.handle && !isPanel
    // focus moves into an opened sheet (so keys go to it, not to the page) and back where it was on close
    useEffect(() => {
        if (!isModal || !props.open) return
        const before = document.activeElement as HTMLElement | null
        const sheet = sheetRef.current
        sheet?.focus()
        return () => {
            before?.focus()
            // the opener was the page itself or is gone: don't leave the focus on the closed sheet
            if (sheet?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
        }
    }, [isModal, props.open])

    // Handle sheet gestures (pointer events cover mouse, touch and pen). A tap on the handle toggles it;
    // a drag moves it with the finger, and letting go decides open or closed (a flick goes its way,
    // else the nearer end). The decision goes to the parent; the sheet follows props.open.
    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return
        if ((e.target as Element).closest(`.${styles.handleIcon}`)) return // the back button
        const sheet = handleSheetRef.current, handle = handleRef.current
        if (!sheet || !handle) return
        // closed, the sheet is down by its height minus the handle (and its 2 px top border)
        const closedAt = Math.max(0, sheet.offsetHeight - handle.offsetHeight - 2)
        const base = props.open ? 0 : closedAt
        gestureRef.current = { startY: e.clientY, base, closedAt, lastY: e.clientY, lastDelta: 0, moved: false }
        // keep the finger from the start: a quick swipe is off the handle by its first move event
        e.currentTarget.setPointerCapture(e.pointerId)
    }

    const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const g = gestureRef.current
        if (!g) return
        const total = e.clientY - g.startY
        if (!g.moved && Math.abs(total) > 5) g.moved = true
        if (!g.moved) return
        g.lastDelta = e.clientY - g.lastY
        g.lastY = e.clientY
        setHandleDrag(Math.min(g.closedAt, Math.max(0, g.base + total)))
    }

    const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
        const g = gestureRef.current
        gestureRef.current = null
        if (!g) return
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
        setHandleDrag(null)
        if (!g.moved) {
            props.onOpenChange?.(!props.open) // a tap
            return
        }
        const at = Math.min(g.closedAt, Math.max(0, g.base + (g.lastY - g.startY)))
        const open = g.lastDelta < -FLICK ? true : g.lastDelta > FLICK ? false : at < g.closedAt / 2
        if (open !== props.open) props.onOpenChange?.(open)
    }

    const handlePointerCancel = () => {
        gestureRef.current = null
        setHandleDrag(null)
    }

    const backButton = props.showBackButton && (props.open || isPanel) && <FaArrowLeft size={25} className={styles.handleIcon} onClick={(e) => {
        e.stopPropagation()
        props.onBackButtonClick?.()
    }} />
    const title = (
        <div className={styles.drawerTitle}>
            {props.title || t('common.options')}
        </div>
    )

    if (isPanel) return (
        <div className={styles.panel}>
            <div className={styles.panelHeader}>
                {backButton}
                {title}
            </div>
            <div className={styles.drawerContent}>
                {props.children}
            </div>
            {props.footer && <div className={styles.footer}>{props.footer}</div>}
        </div>
    )

    if (isModal) {
        const close = () => props.onOpenChange?.(false)
        const shown = props.open || mounted
        return createPortal(
            <div className={`${styles.modal} ${props.open ? styles.open : ''}`}>
                <div className={styles.backdrop} onClick={close} />
                <div ref={sheetRef} tabIndex={-1} className={styles.sheet} role="dialog" aria-modal="true" aria-hidden={!props.open}
                    style={dragOffset ? { transform: `translate(-50%, ${dragOffset}px)`, transition: 'none' } : undefined}
                    onKeyDown={e => { if (e.key === 'Escape') close() }}
                    onTransitionEnd={e => { if (e.target === e.currentTarget) setMounted(props.open) }}>
                    <div className={styles.drawerHandle}
                        onPointerDown={e => {
                            if (e.button !== 0) return // a right click is no tap
                            dragStartYRef.current = e.clientY
                            dragStartXRef.current = e.clientX
                            movedRef.current = false
                            setDragOffset(0)
                        }}
                        onPointerMove={e => {
                            if (dragOffset === null || !(e.buttons & 1)) return // hovering, not dragging
                            const dy = e.clientY - dragStartYRef.current
                            // any move (also up or sideways) makes it a drag rather than a tap; only down moves the sheet
                            if (!movedRef.current && Math.hypot(e.clientX - dragStartXRef.current, dy) > 5) {
                                movedRef.current = true
                                e.currentTarget.setPointerCapture(e.pointerId)
                            }
                            if (movedRef.current) setDragOffset(Math.max(0, dy))
                        }}
                        onPointerUp={() => {
                            if (dragOffset === null) return
                            const tapped = !movedRef.current
                            if (tapped || (dragOffset ?? 0) > CLOSE_DRAG) close()
                            setDragOffset(null)
                        }}
                        onPointerCancel={() => setDragOffset(null)}
                        // released outside the title without dragging: no tap, nothing to follow
                        onPointerLeave={() => { if (!movedRef.current) setDragOffset(null) }}>
                        {backButton}
                        {title}
                    </div>
                    <div className={styles.drawerContent}>{shown && props.children}</div>
                    {props.footer && shown && <div className={styles.footer}>{props.footer}</div>}
                </div>
            </div>,
            document.body)
    }

    // the area the sheet lives in: the whole page, clipped, so a closed sheet's content is out of sight;
    // it lets taps through to the page except on the sheet itself
    return (
        <div className={styles.sheetArea}>
            <div
                ref={handleSheetRef}
                className={`${styles.drawer} ${props.open ? styles.drawerOpen : ''}`}
                style={{
                    '--sheet-max': `${props.maxHeightPercent ?? 88}%`,
                    ...(handleDrag !== null ? { translate: `0 ${handleDrag}px`, transition: 'none' } : {}),
                } as React.CSSProperties}>
                <div
                    ref={handleRef}
                    className={styles.drawerHandle}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerCancel}>
                    {backButton}
                    {title}
                </div>
                {/* always there, so the sheet has its content's height; out of reach while closed */}
                <div className={styles.drawerContent} inert={!props.open}>
                    {props.children}
                </div>
            </div>
        </div>
    )
}
