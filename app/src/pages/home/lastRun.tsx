import { useRef } from 'react'
import { useNavigate } from 'react-router'
import { FaChevronLeft, FaChevronRight } from 'react-icons/fa'
import { useTranslation } from 'react-i18next'
import styles from './lastRun.module.scss'
import RunMap from '../../components/map/map'
import { useUnits } from '../../units'
import { formatDuration } from '../../utils/duration'
import type { Neato } from '../../types'

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()

interface LastRunProps {
    cleaning: Neato.Gen3.CleaningRun
    marker: string
    onOlder?: () => void // undefined: no older run
    onNewer?: () => void
}

// a horizontal swipe longer than this (px) flips to the next / previous run
const SWIPE_PX = 50

// Map of a recent cleaning with the mascot where the robot ended; arrows or a swipe flip through the
// recent runs, a tap opens the run on the runs page
export default function LastRun({ cleaning, marker, onOlder, onNewer }: LastRunProps) {
    const { t } = useTranslation()
    const { formatArea } = useUnits()
    const navigate = useNavigate()
    const run = cleaning.run

    const start = new Date(run.start_at)
    const time = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const when = sameDay(start, new Date()) ? t('home.lastRun.today', { time })
        : sameDay(start, yesterday) ? t('home.lastRun.yesterday', { time })
        : start.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })

    // swiping must not also count as a tap
    const swipeStart = useRef<number | null>(null)
    const swiped = useRef(false)
    const onTouchStart = (e: React.TouchEvent) => {
        swipeStart.current = e.touches[0].clientX
        swiped.current = false
    }
    const onTouchEnd = (e: React.TouchEvent) => {
        if (swipeStart.current === null) return
        const dx = e.changedTouches[0].clientX - swipeStart.current
        swipeStart.current = null
        if (Math.abs(dx) < SWIPE_PX) return
        swiped.current = true
        if (dx < 0) onOlder?.()
        else onNewer?.()
    }
    const open = () => {
        if (swiped.current) return
        navigate('/runs', { state: { runId: cleaning.id } })
    }
    const arrow = (onClick: (() => void) | undefined, side: 'left' | 'right', icon: React.ReactNode, label: string) => onClick && (
        <button className={`${styles.arrow} ${styles[side]}`} aria-label={label} onClick={e => { e.stopPropagation(); onClick() }}>
            {icon}
        </button>
    )

    return (
        <div className={styles.lastRun} role="button" tabIndex={0} onClick={open}
            onKeyDown={e => { if (e.key === 'Enter') open() }} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
            <div className={styles.map}>
                <RunMap key={cleaning.id} mapId={cleaning.id} runId={cleaning.id} marker={marker} focusRun coverage plan zones startFlag />
                {arrow(onOlder, 'left', <FaChevronLeft size={18} />, t('home.lastRun.older'))}
                {arrow(onNewer, 'right', <FaChevronRight size={18} />, t('home.lastRun.newer'))}
            </div>
            <div className={styles.info}>
                <span className={run.error ? styles.warn : styles.ok}>{run.error ? '⚠' : '✓'} {when}</span>
                <span className={styles.stats}>
                    {formatDuration(run.start_at, run.end_at)} · {formatArea(run.cleaned_area)} · {t('home.lastRun.battery', { start: run.run_charge_at_start, end: run.run_charge_at_end })}
                </span>
            </div>
        </div>
    )
}
