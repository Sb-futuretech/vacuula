import { useEffect, useState } from 'react'
import styles from './schedule.module.scss'
import Drawer from '../../components/drawer/drawer'

import type { GetSchedule, ScheduleEvent } from './types'
import { FaTrash, FaServer, FaPen } from 'react-icons/fa'
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
const zoneOf = (e: ScheduleEvent) => e.boundaryId ?? e.boundary?.id
const mondayFirst = (d: number) => (d + 6) % 7

// robot events with the same time, mode and zone on several days, shown and edited as one row
interface RobotGroup { key: string, startTime: string, mode: CleaningMode, zoneId?: string, zoneName?: string, days: RobotDay[], events: ScheduleEvent[] }
const groupEvents = (events: ScheduleEvent[]): RobotGroup[] => {
    const groups = new Map<string, RobotGroup>()
    for (const e of events) {
        const key = `${e.startTime}|${e.mode}|${zoneOf(e) ?? ''}`
        const g = groups.get(key) ?? { key, startTime: e.startTime, mode: e.mode, zoneId: zoneOf(e), zoneName: e.boundary?.name, days: [], events: [] }
        g.days.push(e.day)
        g.events.push(e)
        groups.set(key, g)
    }
    return [...groups.values()]
        .map(g => ({ ...g, days: [...g.days].sort((a, b) => mondayFirst(a) - mondayFirst(b)) }))
        .sort((a, b) => mondayFirst(a.days[0]) - mondayFirst(b.days[0]) || a.startTime.localeCompare(b.startTime))
}

// what the drawer edits: nothing (a new entry), a Pi entry or a group of robot events
type Editing = { kind: 'pi', entry: PiScheduleEntry } | { kind: 'robot', group: RobotGroup } | null

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


    type ScheduleForm = { startTime: string, mode: CleaningMode, navigationMode: CleaningNavigationMode, zones: string[] }
    const emptyForm: ScheduleForm = { startTime: '', mode: CleaningMode.ECO, navigationMode: CleaningNavigationMode.NORMAL, zones: [] }
    const [scheduleForm, SetScheduleForm] = useState<ScheduleForm>(emptyForm)
    const [editing, setEditing] = useState<Editing>(null)
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
        .filter(e => !(editing?.kind === 'robot' && editing.group.events.includes(e)))
        .filter(e => entryDays.includes(e.day) && Math.abs(minutesOf(e.startTime) - minutesOf(startTime)) <= OVERLAP_MIN)
        .map(e => e.startTime)
        .filter((time, i, all) => all.indexOf(time) === i)

    const removeEvents = (events: ScheduleEvent[]) => {
        if (!schedule) return;
        GEN3_COMMANDS.setSchedule(robot.serial, schedule.events.filter(e => !events.includes(e))).finally(() => getSchedule())
    }

    const openNew = () => {
        setEditing(null)
        SetScheduleForm(emptyForm)
        setDays([])
        setDrawerOpen(true)
    }

    const openPi = (entry: PiScheduleEntry) => {
        setEditing({ kind: 'pi', entry })
        SetScheduleForm({
            startTime: entry.startTime, mode: entry.mode, navigationMode: entry.navigationMode,
            zones: entry.zones.map(z => `${z.mapId}${ZONE_SEP}${z.boundaryId}`),
        })
        setDays(entry.days)
        setDrawerOpen(true)
    }

    const openRobot = (group: RobotGroup) => {
        setEditing({ kind: 'robot', group })
        // built from the event itself, so the zone is kept even before the zone list has loaded
        const mapId = group.events.find(e => e.mapId)?.mapId
        const zone = group.zoneId && (zoneOptions.find(o => o.value.endsWith(`${ZONE_SEP}${group.zoneId}`))?.value
            ?? `${mapId ?? ''}${ZONE_SEP}${group.zoneId}`)
        SetScheduleForm({ startTime: group.startTime, mode: group.mode, navigationMode: CleaningNavigationMode.NORMAL, zones: zone ? [zone] : [] })
        setDays(group.days)
        setDrawerOpen(true)
    }

    // saves the drawer: a new entry, or the edited one in place; an entry moves between Pi and robot
    // when what it needs changes (navigation mode / several zones only work from the Pi)
    const saveEvents = () => {
        if (!schedule) return;
        setDrawerOpen(false)
        const editedRobotEvents = editing?.kind === 'robot' ? editing.group.events : []
        const robotEvents = schedule.events.filter(e => !editedRobotEvents.includes(e))
        if (needsPi) {
            const entry = {
                days, startTime: scheduleForm.startTime, mode: scheduleForm.mode, navigationMode: scheduleForm.navigationMode,
                zones: scheduleForm.zones.map(value => {
                    const [mapId, boundaryId] = value.split(ZONE_SEP)
                    return { mapId, boundaryId, name: zoneOptions.find(o => o.value === value)?.label ?? '' }
                }),
            }
            const saved = editing?.kind === 'pi'
                ? Http.updatePiSchedule(robot.serial, editing.entry.id, { ...entry, enabled: editing.entry.enabled ?? true })
                : Http.addPiSchedule(robot.serial, entry)
            saved.then(() => {
                // a robot entry that became a Pi entry: only removed once the Pi has it
                if (editedRobotEvents.length) GEN3_COMMANDS.setSchedule(robot.serial, robotEvents).finally(() => getSchedule())
            }).finally(getPiEntries)
            return
        }
        const zone = scheduleForm.zones[0]?.split(ZONE_SEP)[1]
        const added: ScheduleEvent[] = days.map(day => ({ mode: scheduleForm.mode, startTime: scheduleForm.startTime, day, ...(zone && { boundaryId: zone }) }))
        // an identical day/time/zone entry is replaced instead of duplicated
        const kept = robotEvents.filter(e => !added.some(a => a.day === e.day && a.startTime === e.startTime && zoneOf(a) === zoneOf(e)))
        GEN3_COMMANDS.setSchedule(robot.serial, [...added, ...kept]).then(() => {
            // a Pi entry that the robot can keep now: only removed once the robot has it
            if (editing?.kind === 'pi') Http.deletePiSchedule(robot.serial, editing.entry.id).finally(getPiEntries)
        }).finally(() => getSchedule())
    }

    const togglePiEntry = (entry: PiScheduleEntry) => {
        const { id, ...rest } = entry
        Http.updatePiSchedule(robot.serial, id, { ...rest, enabled: !(entry.enabled ?? true) }).finally(getPiEntries)
    }

    const updateForm = <T extends object>(update: UseState<T>, patch: Partial<T>) => {
        update(prev => ({
            ...prev,
            ...patch
        }))
    }

    if (!schedule) return

    const robotGroups = groupEvents(schedule.events ?? [])
    const dayList = (list: number[]) => [...list].sort((a, b) => mondayFirst(a) - mondayFirst(b)).map(d => t(`days.${dayKey(d)}`)).join(', ')

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

                <div className={`${styles.item} ${styles.actionItem}`} onClick={openNew}>
                    <div className={styles.info}>
                        <span>{t('schedule.newSchedule')}</span>
                        <span className={styles.type}>{t('schedule.addOneMore')}</span>
                    </div>
                </div>

                {piEntries.map(entry => {
                    const fallback = fallbacks(entry.days, entry.startTime)
                    const enabled = entry.enabled ?? true
                    return (
                        <div key={`pi-${entry.id}`} className={`${styles.item} ${enabled ? '' : styles.paused}`}>
                            <div className={`${styles.info} ${styles.editable}`} onClick={() => openPi(entry)}>
                                <span><FaServer className={styles.badge} title={t('schedule.piBadge')} /> {entry.startTime} <FaPen className={styles.editIcon} />{!enabled && <span className={styles.type}> {t('schedule.piPaused')}</span>}</span>
                                <span className={styles.type}>
                                    {t('schedule.piSummary', {
                                        days: dayList(entry.days),
                                        mode: t(`modes.${entry.mode === CleaningMode.ECO ? 'eco' : 'normal'}` as any),
                                        navigation: t(`modes.${NAV_KEYS[entry.navigationMode] ?? 'normal'}` as any),
                                        zones: entry.zones.length ? entry.zones.map(z => decodeRobotText(z.name)).join(', ') : t('schedule.wholeMap'),
                                    })}
                                </span>
                                {fallback.length > 0 && <span className={styles.type}>{t('schedule.fallbackNote', { times: fallback.join(', ') })}</span>}
                            </div>
                            <Input type="switch" skipSection={true} value={enabled} onChange={() => togglePiEntry(entry)} />
                            <FaTrash onClick={() => Http.deletePiSchedule(robot.serial, entry.id).finally(getPiEntries)} />
                        </div>
                    )
                })}

                {robotGroups.map(group => {
                    return (
                        <div key={group.key} className={styles.item}>
                            <div className={`${styles.info} ${styles.editable}`} onClick={() => openRobot(group)}>
                                <span><img src={mascot.src} alt={t('schedule.robotBadge')} title={t('schedule.robotBadge')} className={styles.badge} /> {group.startTime} <FaPen className={styles.editIcon} /></span>
                                <span className={styles.type}>
                                    {t('schedule.gen3Summary', { day: dayList(group.days), mode: CleaningMode[group.mode] })}
                                    {group.zoneName && ` | ${t('schedule.gen3SummaryZone', { zone: decodeRobotText(group.zoneName) })}`}
                                </span>
                            </div>
                            <FaTrash onClick={() => removeEvents(group.events)} />
                        </div>
                    )
                })}
                {robotGroups.length === 0 && piEntries.length === 0 && (
                    <span style={{ textAlign: 'center' }}>{t('schedule.noSchedules')}</span>
                )}
            </div>
            <Drawer
                open={drawerOpen}
                handle={false}
                onOpenChange={setDrawerOpen}
                openHeightPercent={70}
                title={t(editing ? 'schedule.editEvent' : 'schedule.addEvent')}
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

                    {editing?.kind === 'pi' && !needsPi && (
                        <span className={styles.note}>{t('schedule.movesToRobot')}</span>
                    )}

                    <Button text={t('common.save')} style='success' disabled={days.length === 0 || !scheduleForm.startTime} onClick={saveEvents} />
                </div>

            </Drawer>

        </div>
    )
}
