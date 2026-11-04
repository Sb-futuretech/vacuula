import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from './drawer.module.scss'
import { FaArrowLeft } from "react-icons/fa";
import { useTranslation } from "react-i18next";
import { useIsDesktop } from "../../utils/useIsDesktop";



// Two kinds:
// - handle: a sheet that stays at the bottom of its page with a handle to drag it up (the map)
// - no handle: a modal sheet over the whole app with a dimmed backdrop. It is as tall as its content
//   (at most nearly the screen), only its content scrolls, and `footer` stays visible below it.
interface DrawerProps {
    handle: boolean
    open: boolean,
    openHeightPercent?: number // handle sheets only: how far they open
    onOpenChange?: (open: boolean) => void,
    children?: React.ReactNode,
    footer?: React.ReactNode
    title?: string,

    showBackButton?: boolean
    onBackButtonClick?: () => void

    // desktop: show as a fixed column next to the page instead of a bottom sheet
    sidePanel?: boolean
}

const HANDLE_HEIGHT = 60
// a modal sheet pulled down further than this closes
const CLOSE_DRAG = 80

export default function Drawer(props: DrawerProps) {
    const { t } = useTranslation()
    const isPanel = useIsDesktop() && !!props.sidePanel
    const [drawerHeight, setDrawerHeight] = useState(HANDLE_HEIGHT)
    const [isDraggingDrawer, setIsDraggingDrawer] = useState(false)

    // Per-gesture values, inside the event handlers
    const dragStartYRef = useRef(0)
    const dragStartXRef = useRef(0)
    const startHeightRef = useRef(0)
    const currentHeightRef = useRef(0)
    const lastYRef = useRef(0)
    const lastDeltaRef = useRef(0)
    const movedRef = useRef(false)

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

    // Pointer events cover mouse, touch and pen in every modern browser
    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return
        dragStartYRef.current = e.clientY
        lastYRef.current = e.clientY
        startHeightRef.current = drawerHeight
        currentHeightRef.current = drawerHeight
        lastDeltaRef.current = 0
        movedRef.current = false
        setIsDraggingDrawer(true)
    }

    const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!isDraggingDrawer) return
        const total = dragStartYRef.current - e.clientY
        if (!movedRef.current && Math.abs(total) > 5) {
            movedRef.current = true
            e.currentTarget.setPointerCapture(e.pointerId)
        }
        if (!movedRef.current) return
        lastDeltaRef.current = lastYRef.current - e.clientY // flick detection
        lastYRef.current = e.clientY
        const newHeight = Math.min(window.innerHeight * 0.9, Math.max(HANDLE_HEIGHT, startHeightRef.current + total))
        currentHeightRef.current = newHeight
        setDrawerHeight(newHeight)
    }

    const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!isDraggingDrawer) return
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
        setIsDraggingDrawer(false)
        if (!movedRef.current) return // click
        const lastDelta = lastDeltaRef.current
        if (lastDelta < -15) closeDrawer()
        else if (lastDelta > 15) openDrawer()
        else if ((currentHeightRef.current - HANDLE_HEIGHT) > window.innerHeight * 0.2) openDrawer()
        else closeDrawer()
    }

    const handleClick = () => {
        if (movedRef.current) { movedRef.current = false; return } // drag
        if (isDrawerOpen()) closeDrawer()
        else openDrawer()
    }

    const openDrawer = () => {
        setDrawerHeight(window.innerHeight * ((props.openHeightPercent ?? 70) / 100));
        props.onOpenChange?.(true);
    }
    const closeDrawer = () => {
        setDrawerHeight(HANDLE_HEIGHT);
        props.onOpenChange?.(false);
    }
    const isDrawerOpen = () => drawerHeight > 100;

    useEffect(() => {
        if (props.open) openDrawer()
        else closeDrawer()
    }, [props.open])

    useEffect(() => {
        if (isDraggingDrawer) return
        setDrawerHeight(props.open ? window.innerHeight * ((props.openHeightPercent ?? 70) / 100) : HANDLE_HEIGHT)
    }, [props.openHeightPercent])

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

    return (
        <div
            className={styles.drawer}
            style={{
                height: `${drawerHeight}px`,
                transition: isDraggingDrawer ? 'none' : 'height 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                borderTop: '2px solid var(--border-strong)'
            }}>

            <div
                className={styles.drawerHandle}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                onClick={handleClick}>
                {backButton}
                {title}
            </div>

            {drawerHeight > 100 && (
                <div className={styles.drawerContent}>
                    {props.children}
                </div>
            )}
        </div>
    )
}
