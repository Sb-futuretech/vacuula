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
            <BatteryCard stats={stats} />
            <BatteryTrend weekly={stats.batteryWeekly ?? []} />
            <Zones zones={stats.zones ?? []} />
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
    const { formatArea, formatAreaPerMinute } = useUnits()
    return (
        <div className={styles.tiles}>
            {(['week', 'month', 'all'] as const).map(period => (
                <div key={period} className={styles.tile}>
                    <span className={styles.label}>{t(`stats.${period}`)}</span>
                    <span className={styles.hero}>{formatArea(totals[period].area)}</span>
                    <span className={styles.muted}>{t('stats.runsHours', { runs: totals[period].runs, hours: totals[period].hours })}</span>
                    {totals[period].areaPerMinute != null && <span className={styles.muted}>{formatAreaPerMinute(totals[period].areaPerMinute)}</span>}
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

const MODE_KEYS: Record<number, string> = { [Neato.Gen3.CleaningMode.ECO]: 'eco', [Neato.Gen3.CleaningMode.NORMAL]: 'normal' }
const NAV_KEYS: Record<number, string> = {
    [Neato.Gen3.CleaningNavigationMode.NORMAL]: 'normal',
    [Neato.Gen3.CleaningNavigationMode.EXTRA_CARE]: 'extraCare',
    [Neato.Gen3.CleaningNavigationMode.DEEP]: 'deep',
}
// how much a group's numbers rest on: battery % used in total -> 1..4 dots
const evidence = (used: number) => used < 50 ? 1 : used < 150 ? 2 : used < 300 ? 3 : 4

// How far a charge goes, per mode + navigation, from every run that can be measured
function BatteryCard({ stats }: { stats: RobotStats }) {
    const { t } = useTranslation()
    const { formatArea, formatAreaPerMinute } = useUnits()
    const groups = stats.batteryGroups.filter(g => g.minutesPerCharge !== null)
    const speed = (stats.speedGroups ?? []).filter(g => g.areaPerMinute !== null)
    const label = (g: { mode: number | null, navigationMode: number | null }) => g.mode === null
        ? t('stats.mapping')
        : `${t(`modes.${MODE_KEYS[g.mode] ?? 'normal'}` as any)} · ${t(`modes.${NAV_KEYS[g.navigationMode ?? 1] ?? 'normal'}` as any)}`
    const dots = (used: number) => (
        <span className={styles.dots} title={t('stats.evidence')} aria-label={t('stats.evidence')}>
            {[1, 2, 3, 4].map(i => <i key={i} className={i <= evidence(used) ? styles.on : ''} />)}
        </span>
    )

    return (
        <section className={styles.card}>
            <h3>{t('stats.batteryTitle')} <span className={styles.muted}>{t('stats.batteryFrom', { count: groups.reduce((n, g) => n + g.runs, 0) })}</span></h3>
            {groups.length ? (
                <>
                    <table className={styles.table}>
                        <thead><tr><th>{t('stats.combination')}</th><th>{t('stats.perCharge')}</th><th>{t('stats.runsCol')}</th><th>{t('stats.evidence')}</th></tr></thead>
                        <tbody>
                            {groups.map(g => (
                                <tr key={`${g.mode}-${g.navigationMode}`}>
                                    <td>{label(g)}</td>
                                    <td className={styles.num}>{t('stats.minutes', { value: g.minutesPerCharge })}</td>
                                    <td className={styles.num}>{g.runs}</td>
                                    <td>{dots(g.used)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <h4>{t('stats.areaPerCharge')}</h4>
                    <table className={styles.table}>
                        <tbody>
                            {groups.map(g => (
                                <tr key={`${g.mode}-${g.navigationMode}`}>
                                    <td>{label(g)}</td>
                                    <td className={styles.num}>≈ {formatArea(g.areaPerCharge ?? 0)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </>
            ) : <span className={styles.muted}>{t('stats.noBattery')}</span>}
            {speed.length > 0 && (
                <>
                    <h4>{t('stats.areaPerMinute')}</h4>
                    <table className={styles.table}>
                        <tbody>
                            {speed.map(g => (
                                <tr key={`${g.mode}-${g.navigationMode}`}>
                                    <td>{label(g)}</td>
                                    <td className={styles.num}>{formatAreaPerMinute(g.areaPerMinute ?? 0)}</td>
                                    <td className={styles.num}>{t('stats.runs', { count: g.runs })}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </>
            )}
            {stats.batteryNotMeasurable > 0 && <span className={styles.muted}>{t('stats.notMeasurable', { count: stats.batteryNotMeasurable })}</span>}
            <details className={styles.details}>
                <summary>{t('stats.details')}</summary>
                <Battery points={stats.battery} />
            </details>
        </section>
    )
}

// minutes per charge per week and mode: how the battery holds up over time
function BatteryTrend({ weekly }: { weekly: RobotStats['batteryWeekly'] }) {
    const { t } = useTranslation()
    const [hover, setHover] = useState<number>()
    const shown = weekly.filter(w => BATTERY_SERIES.some(s => s.mode === w.mode))
    if (!shown.length) return null

    // every week from the first with data up to this one, empty weeks included
    const monday = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - (d.getDay() + 6) % 7)
    const first = monday(new Date(shown[0].week + 'T00:00')), last = monday(new Date())
    const weeks: string[] = []
    for (let d = first; d <= last; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7)) {
        weeks.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
    }
    const value = (week: string, mode: number) => shown.find(w => w.week === week && w.mode === mode)
    const yMax = Math.ceil(Math.max(...shown.map(w => w.minutesPerCharge)) / 30) * 30
    const week = hover !== undefined ? weeks[hover] : undefined

    return (
        <section className={styles.card}>
            <h3>{t('stats.trendTitle')} <span className={styles.muted}>{t('stats.trendHint')}</span></h3>
            <div className={styles.legend}>
                {BATTERY_SERIES.map(s => <span key={s.key}><i style={{ background: s.color }} />{t(`modes.${s.key}`)}</span>)}
            </div>
            <div className={styles.plot} onPointerLeave={() => setHover(undefined)} role="img" aria-label={t('stats.trendTitle')}>
                <span className={styles.gridLabel}>{t('stats.minutes', { value: yMax })}</span>
                <div className={styles.bars}>
                    {weeks.map((w, i) => (
                        <div key={w} className={`${styles.barSlot} ${styles.pair} ${hover === i ? styles.hovered : ''}`}
                            onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)}>
                            {BATTERY_SERIES.map(s => {
                                const v = value(w, s.mode)
                                return <div key={s.key} className={styles.bar}
                                    style={{ height: v ? `${v.minutesPerCharge / yMax * 100}%` : 0, minHeight: v ? undefined : 0, background: s.color }} />
                            })}
                        </div>
                    ))}
                </div>
                {week && (
                    <div className={styles.tooltip} style={{ left: `${(hover! + 0.5) / weeks.length * 100}%`, translate: tooltipShift((hover! + 0.5) / weeks.length * 100) }}>
                        <strong>{t('stats.weekOf', { date: shortDate(week + 'T00:00') })}</strong>
                        {BATTERY_SERIES.map(s => {
                            const v = value(week, s.mode)
                            return v && <span key={s.key}>{t(`modes.${s.key}`)}: {t('stats.minutes', { value: v.minutesPerCharge })} · {t('stats.runs', { count: v.runs })}</span>
                        })}
                        {BATTERY_SERIES.every(s => !value(week, s.mode)) && <span>{t('stats.noRunsWeek')}</span>}
                    </div>
                )}
            </div>
            <div className={styles.axis}>
                <span>{shortDate(weeks[0] + 'T00:00')}</span>
                <span>{t('stats.thisWeek')}</span>
            </div>
        </section>
    )
}

// per zone: how often, when last, how long and how fast it is cleaned
function Zones({ zones }: { zones: RobotStats['zones'] }) {
    const { t } = useTranslation()
    const { formatArea, formatAreaPerMinute } = useUnits()
    return (
        <section className={styles.card}>
            <h3>{t('stats.zonesTitle')}</h3>
            {zones.length ? (
                <table className={styles.table}>
                    <tbody>
                        {zones.map(z => (
                            <tr key={z.id}>
                                <td>
                                    <div className={styles.zoneName}>{z.name || t('stats.unnamedZone')}</div>
                                    <div className={styles.muted}>
                                        {t('stats.runs', { count: z.runs })}{z.lastAt && ` · ${t('stats.lastAt', { date: shortDate(z.lastAt) })}`}
                                    </div>
                                </td>
                                <td className={styles.num}>
                                    <div>{t('stats.minutes', { value: z.minutes })} · {formatArea(z.area)}</div>
                                    {z.areaPerMinute != null && <div className={styles.muted}>{formatAreaPerMinute(z.areaPerMinute)}</div>}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ) : <span className={styles.muted}>{t('stats.noZones')}</span>}
        </section>
    )
}

// every measured run as a dot: % per hour of cleaning over time, by mode
function Battery({ points }: { points: RobotStats['battery'] }) {
    const { t } = useTranslation()
    const { formatArea } = useUnits()
    const [hover, setHover] = useState<number>()
    const shown = points.filter(p => BATTERY_SERIES.some(s => s.mode === p.mode))
    if (!shown.length) return <span className={styles.muted}>{t('stats.noBattery')}</span>

    const times = shown.map(p => new Date(p.startAt).getTime())
    const first = Math.min(...times), span = Math.max(...times) - first || 1
    const yMax = Math.ceil(Math.max(...shown.map(p => p.perHour)) / 50) * 50
    const grid = Array.from({ length: yMax / 50 + 1 }, (_, i) => i * 50)
    const point = hover !== undefined ? shown[hover] : undefined
    const x = (p: typeof shown[number]) => 4 + (new Date(p.startAt).getTime() - first) / span * 92 // % with a margin for the dots
    const y = (p: typeof shown[number]) => p.perHour / yMax * 100

    return (
        <div className={styles.detailsBody}>
            <span className={styles.muted}>{t('stats.batteryHint')}</span>
            <div className={styles.legend}>
                {BATTERY_SERIES.map(s => <span key={s.key}><i style={{ background: s.color }} />{t(`modes.${s.key}`)}</span>)}
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
        </div>
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
