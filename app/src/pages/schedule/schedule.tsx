import { useEffect, useState } from 'react'
import styles from './schedule.module.scss'
import Drawer from '../../components/drawer/drawer'

import type { GetSchedule, ScheduleEvent } from './types'
import { FaTrash, FaServer } from 'react-icons/fa'
import Input from '../../components/input/input'
import Button from '../../components/button/button'
import { GEN3_COMMANDS } from '../../http/gen3'
import { CleaningMode, CleaningNavigationMode } from '../../types/neato/gen3/state'
import { useRobot } from '../../context/useRobot'
import { RobotDay } from '../../types/neato/gen3/api'
import { RobotType } from '../../types'
import Scheudle_gen4 from './scheudle_gen4'
import { decodeRobotText } from '../../utils/robotText'
import { useTranslation } from 'react-i18next'
import { dayKey } from '../../i18n/days'
import { usePersistentMaps } from '../../loaders/resources'
import type { UseState } from '../../components/map/types'
import { fetchAllGen3Boundaries, getCachedZones } from '../../loaders/gen3Boundaries'
import { Http, type PiScheduleEntry } from '../../http'
import { useMascot } from '../../mascot'

// a robot event this close to a Pi entry is its fallback (server: gen3/pi_schedule.py OVERLAP_MIN)
const OVERLAP_MIN = 15
const minutesOf = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m }
const NAV_KEYS: Record<number, string> = { [CleaningNavigationMode.NORMAL]: 'normal', [CleaningNavigationMode.EXTRA_CARE]: 'extraCare', [CleaningNavigationMode.DEEP]: 'deep' }
const ZONE_SEP = '||'

export default () => {
    const { t } = useTranslation()

    const { robot, serverInfo } = useRobot()

    if (robot?.type === RobotType.NeatoGen4) return <Scheudle_gen4 />


    const [schedule, setSchedule] = useState<GetSchedule>()
    const [drawerOpen, setDrawerOpen] = useState(false)

    const offset = serverInfo.utc_offset_minutes ?? 0
    const { data: persistentMaps } = usePersistentMaps()

    useEffect(() => {
        if (robot.type !== RobotType.NeatoGen3 || !persistentMaps) return
        fetchAllGen3Boundaries(robot.serial, persistentMaps)
    }, [robot.serial, persistentMaps])

    // value "mapId||zoneId": a Pi entry needs the map, a robot event only the zone
    const zoneOptions = (persistentMaps ?? [])
        .filter(m => 'enabled' in m && m.enabled)
        .flatMap(m => getCachedZones(robot.serial, m.id).map(z => ({ value: `${m.id}${ZONE_SEP}${z.id}`, label: `${m.name} - ${z.name}` })))


    const [scheduleForm, SetScheduleForm] = useState<{ startTime: string, mode: CleaningMode, navigationMode: CleaningNavigationMode, zones: string[] }>({
        startTime: '',
        mode: CleaningMode.ECO,
        navigationMode: CleaningNavigationMode.NORMAL,
        zones: [],
    })
    const { mascot } = useMascot()
    const [piEntries, setPiEntries] = useState<PiScheduleEntry[]>([])
    const getPiEntries = () => { Http.getPiSchedule(robot.serial).then(res => setPiEntries(res.data)).catch(() => setPiEntries([])) }
    useEffect(getPiEntries, [robot.serial])
    // one robot event is created per selected day
    const [days, setDays] = useState<RobotDay[]>([])

    const getSchedule = () => {
        GEN3_COMMANDS.getSchedule(robot.serial).then(res => {
            setSchedule(res.data.data)
        })
    }

    useEffect(() => {
        if (!robot) return;
        getSchedule();
    }, [robot])

    // what the robot's own schedule cannot keep goes to the Pi (FORK.md: only mode, day, time and one zone)
    const piNeedsNavigation = scheduleForm.navigationMode !== CleaningNavigationMode.NORMAL
    const piNeedsZones = scheduleForm.zones.length > 1
    const needsPi = piNeedsNavigation || piNeedsZones

    // robot events (local time, from the server) close to a Pi entry on one of its days
    const fallbacks = (entryDays: number[], startTime: string) => (schedule?.events ?? [])
        .filter(e => entryDays.includes(e.day) && Math.abs(minutesOf(e.startTime) - minutesOf(startTime)) <= OVERLAP_MIN)
        .map(e => e.startTime)
        .filter((time, i, all) => all.indexOf(time) === i)

    const removeEvent = (event: ScheduleEvent) => {
        if (!schedule) return;
        GEN3_COMMANDS.setSchedule(robot.serial, schedule.events.filter(e => e !== event)).finally(() => getSchedule())
    }

    const addEvents = () => {
        if (!schedule) return;
        if (needsPi) {
            setDrawerOpen(false)
            Http.addPiSchedule(robot.serial, {
                days, startTime: scheduleForm.startTime, mode: scheduleForm.mode, navigationMode: scheduleForm.navigationMode,
                zones: scheduleForm.zones.map(value => {
                    const [mapId, boundaryId] = value.split(ZONE_SEP)
                    return { mapId, boundaryId, name: zoneOptions.find(o => o.value === value)?.label ?? '' }
                }),
            }).finally(getPiEntries)
            return
        }
        const zoneOf = (e: ScheduleEvent) => e.boundaryId ?? e.boundary?.id
        const zone = scheduleForm.zones[0]?.split(ZONE_SEP)[1]
        const added: ScheduleEvent[] = days.map(day => ({ mode: scheduleForm.mode, startTime: scheduleForm.startTime, day, ...(zone && { boundaryId: zone }) }))
        // an identical day/time/zone entry is replaced instead of duplicated
        const kept = schedule.events.filter(e => !added.some(a => a.day === e.day && a.startTime === e.startTime && zoneOf(a) === zoneOf(e)))
        setDrawerOpen(false)
        GEN3_COMMANDS.setSchedule(robot.serial, [...added, ...kept]).finally(() => getSchedule())
    }

    const updateForm = <T extends object>(update: UseState<T>, patch: Partial<T>) => {
        update(prev => ({
            ...prev,
            ...patch
        }))
    }

    if (!schedule) return

    // Monday first, then by time
    const sortedEvents = [...(schedule.events ?? [])].sort((a, b) =>
        ((a.day + 6) % 7) - ((b.day + 6) % 7) || a.startTime.localeCompare(b.startTime))

    const WEEKDAYS = [RobotDay.MONDAY, RobotDay.TUESDAY, RobotDay.WEDNESDAY, RobotDay.THURSDAY, RobotDay.FRIDAY]
    const WEEKEND = [RobotDay.SATURDAY, RobotDay.SUNDAY]
    const presets: Record<'weekdays' | 'daily' | 'weekend', RobotDay[]> = {
        weekdays: WEEKDAYS,
        daily: [...WEEKDAYS, ...WEEKEND],
        weekend: WEEKEND,
    }
    const activePreset = (Object.keys(presets) as (keyof typeof presets)[])
        .find(k => presets[k].length === days.length && presets[k].every(d => days.includes(d)))

    return (
        <div className={styles.container}>

            <div className={styles.featureList}>
                <div className={`${styles.item} ${styles.staticItem}`}>
                    <div className={styles.info}>
                        <span>{t('schedule.schedule')}</span>
                        {serverInfo && (
                            <span className={styles.type}>{serverInfo.timezone}</span>
                        )}
                    </div>
                    <Input type="switch" skipSection={true} value={schedule.enabled} onChange={() => {
                        let cmd = GEN3_COMMANDS.enableSchedule;
                        if (schedule.enabled) cmd = GEN3_COMMANDS.disableSchedule;
                        cmd(robot.serial).then(() => getSchedule());
                    }} />
                </div>

                <hr style={{ width: '90%' }} />

                <div className={`${styles.item} ${styles.actionItem}`} onClick={() => setDrawerOpen(true)}>
                    <div className={styles.info}>
                        <span>{t('schedule.newSchedule')}</span>
                        <span className={styles.type}>{t('schedule.addOneMore')}</span>
                    </div>
                </div>

                {piEntries.map(entry => {
                    const fallback = fallbacks(entry.days, entry.startTime)
                    const dayNames = [...entry.days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map(d => t(`days.${dayKey(d)}`)).join(', ')
                    return (
                        <div key={`pi-${entry.id}`} className={styles.item}>
                            <div className={styles.info}>
                                <span><FaServer className={styles.badge} title={t('schedule.piBadge')} /> {entry.startTime}</span>
                                <span className={styles.type}>
                                    {t('schedule.piSummary', {
                                        days: dayNames,
                                        mode: t(`modes.${entry.mode === CleaningMode.ECO ? 'eco' : 'normal'}` as any),
                                        navigation: t(`modes.${NAV_KEYS[entry.navigationMode] ?? 'normal'}` as any),
                                        zones: entry.zones.length ? entry.zones.map(z => decodeRobotText(z.name)).join(', ') : t('schedule.wholeMap'),
                                    })}
                                </span>
                                {fallback.length > 0 && <span className={styles.type}>{t('schedule.fallbackNote', { times: fallback.join(', ') })}</span>}
                            </div>
                            <FaTrash onClick={() => Http.deletePiSchedule(robot.serial, entry.id).finally(getPiEntries)} />
                        </div>
                    )
                })}

                {sortedEvents.map((item, i) => {
                    return (
                        <div key={i} className={styles.item}>
                            <div className={styles.info}>
                                <span><img src={mascot.src} alt={t('schedule.robotBadge')} title={t('schedule.robotBadge')} className={styles.badge} /> {item.startTime}</span>
                                <span className={styles.type}>
                                    {t('schedule.gen3Summary', { day: t(`days.${dayKey(item.day)}`), mode: CleaningMode[item.mode] })}
                                    {item.boundary && ` | ${t('schedule.gen3SummaryZone', { zone: decodeRobotText(item.boundary.name) })}`}
                                </span>
                            </div>
                            <FaTrash onClick={() => removeEvent(item)} />
                        </div>
                    )
                })}
                {sortedEvents.length === 0 && piEntries.length === 0 && (
                    <span style={{ textAlign: 'center' }}>{t('schedule.noSchedules')}</span>
                )}
            </div>
            <Drawer
                open={drawerOpen}
                handle={false}
                onOpenChange={setDrawerOpen}
                openHeightPercent={70}
                title={t('schedule.addEvent')}
            >

                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    <Input
                        type="select"
                        label={t('schedule.days')}
                        options={[
                            { value: 'weekdays' as const, label: t('schedule.weekdaysShort') },
                            { value: 'daily' as const, label: t('schedule.daily') },
                            { value: 'weekend' as const, label: t('schedule.weekendShort') },
                        ]}
                        allowDeselect
                        value={activePreset}
                        onChange={(preset) => setDays(preset ? presets[preset] : [])}
                    />

                    <Input
                        type="multi-select"
                        skipSection={true}
                        options={[
                            { value: RobotDay.MONDAY, label: t('days.monday') },
                            { value: RobotDay.TUESDAY, label: t('days.tuesday') },
                            { value: RobotDay.WEDNESDAY, label: t('days.wednesday') },
                            { value: RobotDay.THURSDAY, label: t('days.thursday') },
                            { value: RobotDay.FRIDAY, label: t('days.friday') },
                            { value: RobotDay.SATURDAY, label: t('days.saturday') },
                            { value: RobotDay.SUNDAY, label: t('days.sunday') },
                        ]}
                        value={days}
                        onChange={setDays}
                    />

                    <Input
                        type="select"
                        label={t('common.mode')}
                        options={[
                            { value: CleaningMode.ECO, label: t('modes.eco') },
                            { value: CleaningMode.NORMAL, label: t('modes.normal') },
                        ]}
                        value={scheduleForm.mode}
                        // Eco together with Deep is rejected by the robot
                        onChange={(mode) => updateForm(SetScheduleForm, mode === CleaningMode.ECO && scheduleForm.navigationMode === CleaningNavigationMode.DEEP
                            ? { mode, navigationMode: CleaningNavigationMode.NORMAL } : { mode })}
                    />

                    <Input
                        type="select"
                        label={t('schedule.navigation')}
                        options={[
                            { value: CleaningNavigationMode.NORMAL, label: t('modes.normal') },
                            { value: CleaningNavigationMode.EXTRA_CARE, label: t('modes.extraCare') },
                            { value: CleaningNavigationMode.DEEP, label: t('modes.deep') },
                        ]}
                        value={scheduleForm.navigationMode}
                        extraInfo={scheduleForm.navigationMode === CleaningNavigationMode.DEEP ? t('schedule.deepNeedsNormal') : undefined}
                        onChange={(navigationMode) => updateForm(SetScheduleForm, navigationMode === CleaningNavigationMode.DEEP
                            ? { navigationMode, mode: CleaningMode.NORMAL } : { navigationMode })}
                    />

                    <Input
                        type="time"
                        label={`${t('common.time')} (${serverInfo?.timezone ?? 'UTC'})`}
                        value={scheduleForm.startTime}
                        onChange={(startTime) => updateForm(SetScheduleForm, { startTime })} />

                    <Input
                        type="multi-select"
                        label={t('schedule.selectZones')}
                        extraInfo={t('schedule.selectZonesHelp')}
                        options={zoneOptions}
                        value={scheduleForm.zones}
                        onChange={(zones) => updateForm(SetScheduleForm, { zones })}
                    />

                    {needsPi && (
                        <span className={styles.note}>
                            <FaServer size={12} /> {t('schedule.runsOnPi', { what: t(piNeedsNavigation && piNeedsZones ? 'schedule.piWhatBoth' : piNeedsNavigation ? 'schedule.piWhatNavigation' : 'schedule.piWhatZones') })}
                            {scheduleForm.startTime && fallbacks(days, scheduleForm.startTime).length > 0 && (
                                <> {t('schedule.fallbackNote', { times: fallbacks(days, scheduleForm.startTime).join(', ') })}</>
                            )}
                        </span>
                    )}

                    <Button text={t('common.save')} style='success' disabled={days.length === 0 || !scheduleForm.startTime} onClick={addEvents} />
                </div>

            </Drawer>

        </div>
    )
}
