import styles from './stats.module.scss'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n'
import { Http, type RobotStats } from '../../http'
import { useRobot } from '../../context/useRobot'
import { useUnits } from '../../units'
import { Neato } from '../../types'

// the two gen3 modes the battery chart tells apart, in fixed series order
const BATTERY_SERIES = [
    { mode: Neato.Gen3.CleaningMode.ECO, key: 'eco', color: 'var(--chart-1)' },
    { mode: Neato.Gen3.CleaningMode.NORMAL, key: 'normal', color: 'var(--chart-2)' },
] as const

const median = (values: number[]) => {
    const s = [...values].sort((a, b) => a - b)
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

// keep a tooltip at the plot's edges inside the plot
const tooltipShift = (leftPercent: number) => leftPercent < 15 ? '0' : leftPercent > 85 ? '-100%' : '-50%'

const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

export default () => {
    const { t } = useTranslation()
    const { robot } = useRobot()
    const [stats, setStats] = useState<RobotStats>()
    const [failed, setFailed] = useState(false)

    useEffect(() => {
        setStats(undefined)
        setFailed(false)
        Http.getStats(robot.serial).then(res => setStats(res.data)).catch(() => setFailed(true))
    }, [robot.serial])

    if (failed) return <span className={styles.empty}>{t('stats.failed')}</span>
    if (!stats) return <span className={styles.empty}>{t('common.loading')}</span>

    return (
        <div className={styles.stats}>
            <Totals totals={stats.totals} />
            <DailyArea daily={stats.daily} />
            <Battery points={stats.battery} />
            <div className={styles.columns}>
                <Reliability reliability={stats.reliability} />
                <Problems problems={stats.problems} />
                <LaunchedFrom launchedFrom={stats.launchedFrom} />
            </div>
        </div>
    )
}

function Totals({ totals }: { totals: RobotStats['totals'] }) {
    const { t } = useTranslation()
    const { formatArea } = useUnits()
    return (
        <div className={styles.tiles}>
            {(['week', 'month', 'all'] as const).map(period => (
                <div key={period} className={styles.tile}>
                    <span className={styles.label}>{t(`stats.${period}`)}</span>
                    <span className={styles.hero}>{formatArea(totals[period].area)}</span>
                    <span className={styles.muted}>{t('stats.runsHours', { runs: totals[period].runs, hours: totals[period].hours })}</span>
                </div>
            ))}
        </div>
    )
}

function DailyArea({ daily }: { daily: RobotStats['daily'] }) {
    const { t } = useTranslation()
    const { formatArea } = useUnits()
    const [hover, setHover] = useState<number>()
    const max = Math.max(...daily.map(d => d.area), 1)
    const day = hover !== undefined ? daily[hover] : undefined

    return (
        <section className={styles.card}>
            <h3>{t('stats.dailyTitle')} <span className={styles.muted}>{t('stats.dailyHint', { count: daily.length })}</span></h3>
            <div className={styles.plot} onPointerLeave={() => setHover(undefined)}
                role="img" aria-label={t('stats.dailyTitle')}>
                <span className={styles.gridLabel}>{formatArea(max)}</span>
                <div className={styles.bars}>
                    {daily.map((d, i) => (
                        <div key={d.date} className={`${styles.barSlot} ${hover === i ? styles.hovered : ''}`}
                            onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)}>
                            {d.area > 0 && <div className={styles.bar} style={{ height: `${d.area / max * 100}%` }} />}
                        </div>
                    ))}
                </div>
                {day && (
                    <div className={styles.tooltip} style={{ left: `${(hover! + 0.5) / daily.length * 100}%`, translate: tooltipShift((hover! + 0.5) / daily.length * 100) }}>
                        <strong>{shortDate(day.date)}</strong>
                        <span>{formatArea(day.area)} · {t('stats.runs', { count: day.runs })}</span>
                    </div>
                )}
            </div>
            <div className={styles.axis}>
                <span>{shortDate(daily[0].date)}</span>
                <span>{shortDate(daily[Math.floor(daily.length / 2)].date)}</span>
                <span>{t('stats.today')}</span>
            </div>
        </section>
    )
}

function Battery({ points }: { points: RobotStats['battery'] }) {
    const { t } = useTranslation()
    const { formatArea } = useUnits()
    const [hover, setHover] = useState<number>()
    const shown = points.filter(p => BATTERY_SERIES.some(s => s.mode === p.mode))
    if (!shown.length) return (
        <section className={styles.card}>
            <h3>{t('stats.batteryTitle')}</h3>
            <span className={styles.muted}>{t('stats.noBattery')}</span>
        </section>
    )

    const times = shown.map(p => new Date(p.startAt).getTime())
    const first = Math.min(...times), span = Math.max(...times) - first || 1
    const yMax = Math.ceil(Math.max(...shown.map(p => p.perHour)) / 50) * 50
    const grid = Array.from({ length: yMax / 50 + 1 }, (_, i) => i * 50)
    const point = hover !== undefined ? shown[hover] : undefined
    const x = (p: typeof shown[number]) => 4 + (new Date(p.startAt).getTime() - first) / span * 92 // % with a margin for the dots
    const y = (p: typeof shown[number]) => p.perHour / yMax * 100

    return (
        <section className={styles.card}>
            <h3>{t('stats.batteryTitle')} <span className={styles.muted}>{t('stats.batteryHint')}</span></h3>
            <div className={styles.legend}>
                {BATTERY_SERIES.map(s => {
                    const values = shown.filter(p => p.mode === s.mode).map(p => p.perHour)
                    return (
                        <span key={s.key}>
                            <i style={{ background: s.color }} />
                            {values.length
                                ? t('stats.runtime', { mode: t(`modes.${s.key}`), minutes: Math.round(100 / median(values) * 60), count: values.length })
                                : t(`modes.${s.key}`)}
                        </span>
                    )
                })}
            </div>
            <div className={styles.plot} onPointerLeave={() => setHover(undefined)}
                role="img" aria-label={t('stats.batteryTitle')}>
                {grid.map(g => (
                    <div key={g} className={styles.gridLine} style={{ bottom: `${g / yMax * 100}%` }}>
                        <span>{t('stats.perHour', { value: g })}</span>
                    </div>
                ))}
                {shown.map((p, i) => (
                    <div key={p.startAt} className={`${styles.dot} ${hover === i ? styles.hovered : ''}`}
                        style={{ left: `${x(p)}%`, bottom: `${y(p)}%`, background: BATTERY_SERIES.find(s => s.mode === p.mode)!.color }}
                        onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)} />
                ))}
                {point && (
                    <div className={styles.tooltip} style={{ left: `${x(point)}%`, bottom: `calc(${y(point)}% + 1.4rem)`, top: 'auto', transform: 'none', translate: tooltipShift(x(point)) }}>
                        <strong>{new Date(point.startAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</strong>
                        <span>{t('stats.perHour', { value: Math.round(point.perHour) })}</span>
                        <span>{t('stats.batteryTooltip', { used: point.used, area: formatArea(point.area), start: point.chargeStart })}</span>
                    </div>
                )}
            </div>
        </section>
    )
}

function Reliability({ reliability: r }: { reliability: RobotStats['reliability'] }) {
    const { t } = useTranslation()
    const share = (n: number) => r.runs ? ` (${Math.round(n / r.runs * 100)} %)` : ''
    const rows: [string, string][] = [
        [t('stats.complete'), `${r.complete} / ${r.runs}${share(r.complete)}`],
        [t('stats.canceled'), `${r.canceled}${share(r.canceled)}`],
        [t('stats.withError'), `${r.withError}`],
        [t('stats.recharged'), `${r.recharged}`],
        [t('stats.pickedUp'), `${r.pickedUp}`],
        [t('stats.localizationLost'), `${r.localizationLost}`],
    ]
    return (
        <section className={styles.card}>
            <h3>{t('stats.reliabilityTitle')}</h3>
            <dl className={styles.rows}>
                {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
            </dl>
        </section>
    )
}

function Problems({ problems }: { problems: RobotStats['problems'] }) {
    const { t } = useTranslation()
    const { robot } = useRobot()
    const text = (code: string) => {
        const key = `robotErrorCode.${robot.type}.${code}`
        return i18n.exists(key) ? t(key as any) : code
    }
    return (
        <section className={styles.card}>
            <h3>{t('stats.problemsTitle')}</h3>
            {problems.length ? (
                <dl className={styles.rows}>
                    {problems.map(p => (
                        <div key={`${p.kind}:${p.code}`}>
                            <dt>{text(p.code)}</dt>
                            <dd>{t('stats.problemCount', { count: p.count, date: new Date(p.lastAt * 1000).toLocaleDateString() })}</dd>
                        </div>
                    ))}
                </dl>
            ) : <span className={styles.muted}>{t('stats.noProblems')}</span>}
        </section>
    )
}

function LaunchedFrom({ launchedFrom }: { launchedFrom: RobotStats['launchedFrom'] }) {
    const { t } = useTranslation()
    const entries = Object.entries(launchedFrom).sort((a, b) => b[1] - a[1])
    return (
        <section className={styles.card}>
            <h3>{t('stats.launchedTitle')}</h3>
            <dl className={styles.rows}>
                {entries.map(([from, count]) => (
                    <div key={from}>
                        <dt>{i18n.exists(`stats.launched.${from}`) ? t(`stats.launched.${from}` as any) : from}</dt>
                        <dd>{count}</dd>
                    </div>
                ))}
            </dl>
        </section>
    )
}
