// The schedule as a week: a row per day on phones, a column per day on wide screens (CSS decides,
// the blocks only carry their place as fractions of the day's track).
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { FaServer } from 'react-icons/fa'
import { dayKey } from '../../i18n/days'
import { decodeRobotText } from '../../utils/robotText'
import styles from './week.module.scss'
import { hhmm, levelOf, WEEK, type Slot } from './week'

const DAY_START = 6 * 60
const DAY_END = 22 * 60

interface Props {
    week: Slot[][]
    selected: string | null
    onSelect: (slot: Slot | null) => void
    today: number // RobotDay, server time
    nowMinutes: number
}

export default function WeekView({ week, selected, onSelect, today, nowMinutes }: Props) {
    const { t } = useTranslation()

    // 6–22 h, wider when an entry lies outside
    const slots = week.flat()
    const from = Math.min(DAY_START, ...slots.map(s => Math.floor(s.start / 60) * 60))
    const to = Math.max(DAY_END, ...slots.map(s => Math.ceil((s.start + (s.minutes ?? 30)) / 60) * 60))
    const span = to - from
    const pos = (minutes: number) => (minutes - from) / span
    const step = span / 60 > 16 ? 6 : 4
    const marks: number[] = []
    for (let h = from / 60; h <= to / 60; h += step) marks.push(h * 60)

    return (
        <div className={styles.week}>
            <div className={`${styles.day} ${styles.axis}`} aria-hidden="true">
                <span className={styles.dayLabel} />
                <div className={styles.track}>
                    {marks.map(m => <span key={m} className={styles.mark} style={{ '--pos': pos(m) } as CSSProperties}>{m / 60}</span>)}
                </div>
            </div>

            {WEEK.map((day, i) => (
                <div key={day} className={`${styles.day} ${day === today ? styles.today : ''}`}>
                    <span className={styles.dayLabel}>{t(`daysShort.${dayKey(day)}` as any)}</span>
                    <div className={styles.track} onClick={() => onSelect(null)}>
                        {marks.map(m => <span key={m} className={styles.gridLine} style={{ '--pos': pos(m) } as CSSProperties} />)}
                        {day === today && nowMinutes >= from && nowMinutes <= to && (
                            <span className={styles.now} style={{ '--pos': pos(nowMinutes) } as CSSProperties} />
                        )}
                        {week[i].map(slot => (
                            <button
                                key={slot.key}
                                type="button"
                                className={[
                                    styles.block, styles[levelOf(slot.mode, slot.navigationMode)],
                                    slot.key === selected ? styles.selected : '',
                                    slot.overlaps.length ? styles.warn : '',
                                    slot.active ? '' : styles.inactive,
                                ].join(' ')}
                                style={{
                                    '--start': pos(slot.start),
                                    '--len': (slot.minutes ?? 30) / span,
                                    '--lane': slot.lane,
                                    '--lanes': slot.lanes,
                                } as CSSProperties}
                                aria-label={`${t(`days.${dayKey(day)}` as any)} ${hhmm(slot.start)} ${slot.zoneNames.map(decodeRobotText).join(', ')}`}
                                aria-pressed={slot.key === selected}
                                onClick={e => { e.stopPropagation(); onSelect(slot.key === selected ? null : slot) }}
                            >
                                {slot.kind === 'pi' && <FaServer className={styles.blockIcon} aria-hidden="true" />}
                                <span>{hhmm(slot.start)}</span>
                            </button>
                        ))}
                    </div>
                </div>
            ))}

            <div className={styles.legend}>
                <span><i className={styles.eco} />{t('modes.eco')}</span>
                <span><i className={styles.normal} />{t('modes.normal')}</span>
                <span><i className={styles.deep} />{t('schedule.week.deepLegend')}</span>
                <span><FaServer aria-hidden="true" />{t('schedule.week.piLegend')}</span>
            </div>
        </div>
    )
}
