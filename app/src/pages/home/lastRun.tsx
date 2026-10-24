import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import styles from './lastRun.module.scss'
import RunMap from '../../components/map/map'
import { useUnits } from '../../units'
import { formatDuration } from '../../utils/duration'
import type { Neato } from '../../types'

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()

// Map of the robot's last cleaning with the mascot where it docks; opens the run on the runs page
export default function LastRun({ cleaning, marker }: { cleaning: Neato.Gen3.CleaningRun, marker: string }) {
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

    return (
        <button className={styles.lastRun} onClick={() => navigate('/runs', { state: { runId: cleaning.id } })}>
            <div className={styles.map}>
                <RunMap mapId={cleaning.id} runId={cleaning.id} marker={marker} focusRun coverage plan />
            </div>
            <div className={styles.info}>
                <span className={run.error ? styles.warn : styles.ok}>{run.error ? '⚠' : '✓'} {when}</span>
                <span className={styles.stats}>
                    {formatDuration(run.start_at, run.end_at)} · {formatArea(run.cleaned_area)} · {t('home.lastRun.battery', { start: run.run_charge_at_start, end: run.run_charge_at_end })}
                </span>
            </div>
        </button>
    )
}
