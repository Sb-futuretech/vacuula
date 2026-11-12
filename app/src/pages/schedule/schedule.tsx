import { useEffect, useMemo, useRef, useState } from 'react'
import styles from './schedule.module.scss'
import Drawer from '../../components/drawer/drawer'

import type { GetSchedule, ScheduleEvent } from './types'
import { FaTrash, FaServer, FaExclamationTriangle } from 'react-icons/fa'
import Input from '../../components/input/input'
import Button from '../../components/button/button'
import { GEN3_COMMANDS } from '../../http/gen3'
import { CleaningMode, CleaningNavigationMode } from '../../types/neato/gen3/state'
import { useRobot } from '../../context/useRobot'
import { useMediaQuery } from '../../utils/useIsDesktop'
import { showToast, withFeedback } from '../../components/toast/toast'
import { RobotDay } from '../../types/neato/gen3/api'
import { RobotType } from '../../types'
import Scheudle_gen4 from './scheudle_gen4'
import { decodeRobotText } from '../../utils/robotText'
import { useTranslation } from 'react-i18next'
import { dayKey } from '../../i18n/days'
import { usePersistentMaps } from '../../loaders/resources'
import type { UseState } from '../../components/map/types'
import { fetchAllGen3Boundaries, gen3ZoneOptions, getCachedZones, isGen3MapCached, splitZoneValue, zoneValue } from '../../loaders/gen3Boundaries'
import { Http, type PiScheduleEntry, type RobotStats } from '../../http'
import { GEN3_MODE_KEY, GEN3_NAV_KEY, gen3CleaningModeHelp, gen3NavigationHelp } from '../../utils/modes'
import { useMascot } from '../../mascot'

import WeekView from './weekView'
import { formatHHMM } from '../../utils/clockTime'
import { buildWeek, estimateMinutes, groupEvents, minutesOf, mondayFirst, nextRun, OVERLAP_MIN, overlapsWith, WEEK, zoneOf,
    type RobotGroup } from './week'


// what the drawer edits: nothing (a new entry), a Pi entry or a group of robot events
type Editing = { kind: 'pi', entry: PiScheduleEntry } | { kind: 'robot', group: RobotGroup } | null

// wide enough for the details column on the right; keep in sync with $schedule-wide in schedule.module.scss
const SCHEDULE_WIDE = '(min-width: 1400px)'

// two components, not an early return: switching between a gen3 and a gen4 robot on this tab must
// not change the number of hooks
export default function Schedule() {
    const { robot } = useRobot()
    return robot?.type === RobotType.NeatoGen4 ? <Scheudle_gen4 /> : <ScheduleGen3 />
}

function ScheduleGen3() {
    const { t } = useTranslation()

    const { robot, serverInfo } = useRobot()

    const [schedule, setSchedule] = useState<GetSchedule>()
    const [drawerOpen, setDrawerOpen] = useState(false)

    const offset = serverInfo.utc_offset_minutes ?? 0
    const { data: persistentMaps } = usePersistentMaps()

    // the zones of all maps, for names and the zone picker; a render once they are in shows them
    const [, setZonesLoaded] = useState(0)
    useEffect(() => {
        if (robot.type !== RobotType.NeatoGen3 || !persistentMaps) return
        fetchAllGen3Boundaries(robot.serial, persistentMaps).then(() => setZonesLoaded(n => n + 1))
    }, [robot.serial, persistentMaps])

    const zoneOptions = gen3ZoneOptions(robot.serial, persistentMaps)
    const allZonesLoaded = !!persistentMaps && persistentMaps.every(m => isGen3MapCached(robot.serial, m.id))


    type ScheduleForm = { startTime: string, mode: CleaningMode, navigationMode: CleaningNavigationMode, zones: string[] }
    const emptyForm: ScheduleForm = { startTime: '', mode: CleaningMode.ECO, navigationMode: CleaningNavigationMode.NORMAL, zones: [] }
    const [scheduleForm, SetScheduleForm] = useState<ScheduleForm>(emptyForm)
    // an entry's zones without those deleted from the maps since: the picker cannot show them, so they
    // could not be taken out, and the robot answers them with "wrong floor". Kept until all zones are loaded.
    const formZones = allZonesLoaded ? scheduleForm.zones.filter(v => zoneOptions.some(o => o.value === v)) : scheduleForm.zones
    const [editing, setEditing] = useState<Editing>(null)
    const { mascot } = useMascot()
    const [piEntries, setPiEntries] = useState<PiScheduleEntry[]>([])
    const getPiEntries = () => { Http.getPiSchedule(robot.serial).then(res => setPiEntries(res.data)).catch(() => setPiEntries([])) }
    useEffect(getPiEntries, [robot.serial])
    // finished runs, for how long an entry takes
    const [stats, setStats] = useState<RobotStats>()
    useEffect(() => { Http.getStats(robot.serial).then(res => setStats(res.data)).catch(() => setStats(undefined)) }, [robot.serial])
    const [selected, setSelected] = useState<string | null>(null)
    // the details of a tapped entry open under the week: bring them into view
    const detailsRef = useRef<HTMLDivElement>(null)
    const sideColumn = useMediaQuery(SCHEDULE_WIDE)
    useEffect(() => { detailsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }) }, [selected])
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => { const id = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(id) }, [])
    // one robot event is created per selected day
    const [days, setDays] = useState<RobotDay[]>([])

    // the robot's own schedule; if it can't be read (robot offline), the page still works with the Pi's
    const [scheduleFailed, setScheduleFailed] = useState(false)
    const getSchedule = () => {
        GEN3_COMMANDS.getSchedule(robot.serial).then(res => {
            setSchedule(res.data.data)
            setScheduleFailed(false)
        }).catch(() => setScheduleFailed(true))
    }

    useEffect(() => {
        if (!robot) return;
        getSchedule();
    }, [robot])

    // what the robot's own schedule cannot keep goes to the Pi (FORK.md: only mode, day, time and one zone)
    const piNeedsNavigation = scheduleForm.navigationMode !== CleaningNavigationMode.NORMAL
    const piNeedsZones = formZones.length > 1
    const needsPi = piNeedsNavigation || piNeedsZones

    // robot events (local time, from the server) close to a Pi entry on one of its days
    const fallbacks = (entryDays: number[], startTime: string) => (schedule?.events ?? [])
        .filter(e => !(editing?.kind === 'robot' && editing.group.events.includes(e)))
        .filter(e => entryDays.includes(e.day) && Math.abs(minutesOf(e.startTime) - minutesOf(startTime)) <= OVERLAP_MIN)
        .map(e => e.startTime)
        .filter((time, i, all) => all.indexOf(time) === i)

    const removeEvents = (events: ScheduleEvent[]) => {
        if (!schedule) return;
        withFeedback(GEN3_COMMANDS.setSchedule(robot.serial, schedule.events.filter(e => !events.includes(e)))).finally(() => getSchedule())
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
            zones: entry.zones.map(z => zoneValue(z.mapId, z.boundaryId)),
        })
        setDays(entry.days)
        setDrawerOpen(true)
    }

    const openRobot = (group: RobotGroup) => {
        setEditing({ kind: 'robot', group })
        // built from the event itself, so the zone is kept even before the zone list has loaded
        const mapId = group.events.find(e => e.mapId)?.mapId
        const zone = group.zoneId && (zoneOptions.find(o => splitZoneValue(o.value)[1] === group.zoneId)?.value
            ?? zoneValue(mapId ?? '', group.zoneId))
        SetScheduleForm({ startTime: group.startTime, mode: group.mode, navigationMode: CleaningNavigationMode.NORMAL, zones: zone ? [zone] : [] })
        setDays(group.days)
        setDrawerOpen(true)
    }

    // saves the drawer: a new entry, or the edited one in place; an entry moves between Pi and robot
    // when what it needs changes (navigation mode / several zones only work from the Pi)
    const saveEvents = () => {
        // without the robot's schedule only Pi entries can be saved: writing the robot's list blind
        // would replace what is on it
        if (!schedule && !needsPi) {
            showToast(t('schedule.robotScheduleUnavailable'), false)
            return
        }
        setDrawerOpen(false)
        const editedRobotEvents = editing?.kind === 'robot' ? editing.group.events : []
        const robotEvents = (schedule?.events ?? []).filter(e => !editedRobotEvents.includes(e))
        if (needsPi) {
            const entry = {
                days, startTime: scheduleForm.startTime, mode: scheduleForm.mode, navigationMode: scheduleForm.navigationMode,
                zones: formZones.map(value => {
                    const [mapId, boundaryId] = splitZoneValue(value)
                    return { mapId, boundaryId, name: zoneOptions.find(o => o.value === value)?.label ?? '' }
                }),
            }
            const saved: Promise<unknown> = editing?.kind === 'pi'
                ? Http.updatePiSchedule(robot.serial, editing.entry.id, { ...entry, enabled: editing.entry.enabled ?? true })
                : Http.addPiSchedule(robot.serial, entry)
            // a robot entry that became a Pi entry is only removed once the Pi has it; if that fails, the
            // user hears that the old one is still there (both would run)
            withFeedback(saved).then(() => editedRobotEvents.length
                ? withFeedback(GEN3_COMMANDS.setSchedule(robot.serial, robotEvents), null, 'schedule.week.oldNotRemoved') : undefined)
                .finally(() => { getPiEntries(); if (editedRobotEvents.length) getSchedule() })
            return
        }
        const zone = formZones[0] && splitZoneValue(formZones[0])[1]
        const added: ScheduleEvent[] = days.map(day => ({ mode: scheduleForm.mode, startTime: scheduleForm.startTime, day, ...(zone && { boundaryId: zone }) }))
        // an identical day/time/zone entry is replaced instead of duplicated
        const kept = robotEvents.filter(e => !added.some(a => a.day === e.day && a.startTime === e.startTime && zoneOf(a) === zoneOf(e)))
        // a Pi entry that the robot can keep now is only removed once the robot has it; if that fails, the
        // user hears that the old one is still there (both would run)
        withFeedback(GEN3_COMMANDS.setSchedule(robot.serial, [...added, ...kept])).then(() => editing?.kind === 'pi'
            ? withFeedback(Http.deletePiSchedule(robot.serial, editing.entry.id), null, 'schedule.week.oldNotRemoved') : undefined)
            .finally(() => { getSchedule(); if (editing?.kind === 'pi') getPiEntries() })
    }

    const togglePiEntry = (entry: PiScheduleEntry) => {
        const { id, ...rest } = entry
        withFeedback(Http.updatePiSchedule(robot.serial, id, { ...rest, enabled: !(entry.enabled ?? true) })).finally(getPiEntries)
    }

    const updateForm = <T extends object>(update: UseState<T>, patch: Partial<T>) => {
        update(prev => ({
            ...prev,
            ...patch
        }))
    }

    const estimate = (mode: CleaningMode, navigationMode: CleaningNavigationMode, zoneIds: string[]) => estimateMinutes(stats, mode, navigationMode, zoneIds)
    const week = useMemo(() => buildWeek(piEntries, schedule?.events ?? [], schedule?.enabled ?? false,
        (mode, navigationMode, zoneIds) => estimateMinutes(stats, mode, navigationMode, zoneIds)), [piEntries, schedule, stats])

    if (!schedule && !scheduleFailed) return

    const robotGroups = groupEvents(schedule?.events ?? [])
    // the server's clock: entries are in its time zone
    const serverNow = new Date(now + offset * 60_000)
    const next = nextRun(week, serverNow)
    const selectedSlot = week.flat().find(s => s.key === selected)

    const dayName = (d: number) => t(`days.${dayKey(d)}` as any)
    const shortDay = (d: number) => t(`daysShort.${dayKey(d)}` as any)
    const modeText = (mode: CleaningMode, nav: CleaningNavigationMode) => t(`modes.${GEN3_MODE_KEY[mode] ?? 'normal'}` as any)
        + (nav !== CleaningNavigationMode.NORMAL ? ` · ${t(`modes.${GEN3_NAV_KEY[nav] ?? 'normal'}` as any)}` : '')
    // names from the maps as they are now. Until every map's zones are loaded, a zone not found yet keeps
    // the name it was saved with; once they are, it is gone from the maps: "unknown zone".
    const zoneNameById = new Map((persistentMaps ?? []).flatMap(m => getCachedZones(robot.serial, m.id).map(z => [z.id, z.name] as const)))
    const zoneNamesOf = ({ zoneIds, zoneNames }: { zoneIds: string[], zoneNames: string[] }) => zoneIds.map((id, i) => {
        const current = zoneNameById.get(id)
        if (current !== undefined) return decodeRobotText(current) || t('schedule.week.unnamedZone')
        // not found yet: while the zones still load, the saved name (or "…"); once all are in, it is gone
        if (!allZonesLoaded) return zoneNames[i] ? decodeRobotText(zoneNames[i]) : '…'
        return t('schedule.week.unknownZone')
    })
    const zonesText = (slot: { zoneIds: string[], zoneNames: string[] }) => slot.zoneIds.length
        ? zoneNamesOf(slot).join(', ')
        : t('schedule.wholeMap')
    const lengthText = (minutes: number | null) => minutes != null ? t('schedule.week.about', { minutes }) : t('schedule.week.noEstimate')
    const inText = (minutes: number) => minutes < 60 ? t('schedule.week.inMinutes', { count: minutes })
        : minutes < 48 * 60 ? t('schedule.week.inHours', { count: Math.round(minutes / 60) })
            : t('schedule.week.inDays', { count: Math.round(minutes / 1440) })
    const dayWord = (daysAhead: number, day: number) => daysAhead === 0 ? t('schedule.week.today') : daysAhead === 1 ? t('schedule.week.tomorrow') : dayName(day)

    // the drawer's entry: how long it takes and what it runs into
    const formZoneIds = formZones.map(value => splitZoneValue(value)[1])
    const formMinutes = estimate(scheduleForm.mode, needsPi ? scheduleForm.navigationMode : CleaningNavigationMode.NORMAL, formZoneIds)
    const formFallbacks = scheduleForm.startTime ? fallbacks(days, scheduleForm.startTime) : []
    const formOverlaps = scheduleForm.startTime && days.length
        ? overlapsWith(week, days, minutesOf(scheduleForm.startTime), formMinutes, needsPi,
            s => editing?.kind === 'pi' ? s.pi?.id === editing.entry.id : editing?.kind === 'robot' ? s.group?.key === editing.group.key : false)
        : []
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

    // the tapped entry's details: under the week, or in a column on the right in wide windows
    const details = selectedSlot ? (
        <div className={styles.details} ref={detailsRef}>
            <span className={styles.detailsTitle}>
                {dayName(selectedSlot.day)} {formatHHMM(selectedSlot.start)}
                {selectedSlot.minutes != null && ` – ${formatHHMM(selectedSlot.start + selectedSlot.minutes)}`}
            </span>
            <span>{zonesText(selectedSlot)} · {modeText(selectedSlot.mode, selectedSlot.navigationMode)} · {lengthText(selectedSlot.minutes)}</span>
            <span className={styles.type}>
                {selectedSlot.kind === 'pi'
                    ? <><FaServer className={styles.badge} /> {t('schedule.week.byPi')}</>
                    : <><img src={mascot.src} alt="" className={styles.badge} /> {t('schedule.week.byRobot')}</>}
                {!selectedSlot.active && ` ${t(selectedSlot.kind === 'pi' ? 'schedule.week.paused' : 'schedule.week.robotOff')}`}
            </span>
            {selectedSlot.backups.length > 0 && (
                <span className={styles.type}>
                    {t('schedule.week.backup', { times: selectedSlot.backups.map(e => e.startTime).join(', ') })}
                    {' '}<button type="button" className={styles.linkButton} onClick={() => removeEvents(selectedSlot.backups)}>{t('schedule.week.removeBackup')}</button>
                </span>
            )}
            {selectedSlot.overlaps.length > 0 && (
                <span className={styles.warnNote}>
                    <FaExclamationTriangle /> {t('schedule.week.overlap', { times: selectedSlot.overlaps.map(o => formatHHMM(o.start)).join(', ') })}
                </span>
            )}
            <div className={styles.detailsActions}>
                <Button text={t('schedule.week.edit')} style='secondary' onClick={() => selectedSlot.pi ? openPi(selectedSlot.pi) : selectedSlot.group && openRobot(selectedSlot.group)} />
                {selectedSlot.pi && (
                    <Input type="switch" skipSection={true} value={selectedSlot.pi.enabled ?? true} onChange={() => togglePiEntry(selectedSlot.pi!)} />
                )}
                <FaTrash className={styles.trash} title={t('schedule.week.delete')}
                    onClick={() => selectedSlot.pi
                        ? withFeedback(Http.deletePiSchedule(robot.serial, selectedSlot.pi.id)).finally(getPiEntries)
                        : selectedSlot.group && removeEvents(selectedSlot.group.events)} />
            </div>
            {selectedSlot.group && selectedSlot.group.days.length > 1 && (
                <span className={styles.type}>{t('schedule.week.allDays', { days: dayList(selectedSlot.group.days) })}</span>
            )}
            {selectedSlot.pi && selectedSlot.pi.days.length > 1 && (
                <span className={styles.type}>{t('schedule.week.allDays', { days: dayList(selectedSlot.pi.days) })}</span>
            )}
        </div>
    ) : robotGroups.length + piEntries.length > 0 && (
        <span className={styles.hint}>{t('schedule.week.tapHint')}</span>
    )

    return (
        <div className={styles.container}>

            <div className={`${styles.featureList} ${styles.withWeek}`}>
                <div className={`${styles.item} ${styles.staticItem}`}>
                    <div className={styles.info}>
                        <span>{t('schedule.schedule')}</span>
                        {serverInfo && (
                            <span className={styles.type}>{serverInfo.timezone}</span>
                        )}
                        {!schedule && <span className={styles.type}>{t('schedule.robotScheduleUnavailable')}</span>}
                    </div>
                    {schedule ? (
                        <Input type="switch" skipSection={true} value={schedule.enabled} onChange={() => {
                            let cmd = GEN3_COMMANDS.enableSchedule;
                            if (schedule.enabled) cmd = GEN3_COMMANDS.disableSchedule;
                            withFeedback(cmd(robot.serial)).then(() => getSchedule());
                        }} />
                    ) : <Button text={t('common.retry')} style='secondary' onClick={getSchedule} />}
                </div>

                <div className={styles.nextRun}>
                    <span className={styles.nextLabel}>{t('schedule.week.next')}{next && ` · ${inText(next.minutesUntil)}`}</span>
                    {next ? (
                        <>
                            <span className={styles.nextWhen}>{dayWord(next.daysAhead, next.slot.day)} {formatHHMM(next.slot.start)}</span>
                            <span className={styles.type}>
                                {zonesText(next.slot)} · {modeText(next.slot.mode, next.slot.navigationMode)}
                                {next.slot.minutes != null && ` · ${t('schedule.week.about', { minutes: next.slot.minutes })}`}
                            </span>
                        </>
                    ) : <span className={styles.type}>{t('schedule.week.noNext')}</span>}
                </div>

                <div className={`${styles.item} ${styles.actionItem}`} onClick={openNew}>
                    <div className={styles.info}>
                        <span>{t('schedule.newSchedule')}</span>
                        <span className={styles.type}>{t('schedule.addOneMore')}</span>
                    </div>
                </div>

                {/* names as shown in the details, also for the blocks' screen-reader labels */}
                <WeekView week={week.map(day => day.map(slot => ({ ...slot, zoneNames: zoneNamesOf(slot) })))} selected={selected} onSelect={slot => setSelected(slot?.key ?? null)}
                    today={serverNow.getUTCDay()} nowMinutes={serverNow.getUTCHours() * 60 + serverNow.getUTCMinutes()} />

                {!sideColumn && details}

                {robotGroups.length === 0 && piEntries.length === 0 && (
                    <span style={{ textAlign: 'center' }}>{t('schedule.noSchedules')}</span>
                )}
            </div>
            {sideColumn && !drawerOpen && <aside className={styles.side}>{details}</aside>}
            {/* wide windows: the form takes the right column while it is open */}
            {(!sideColumn || drawerOpen) && <Drawer
                sidePanel={sideColumn}
                open={drawerOpen}
                handle={false}
                showBackButton={sideColumn}
                onBackButtonClick={() => setDrawerOpen(false)}
                onOpenChange={setDrawerOpen}
                title={t(editing ? 'schedule.editEvent' : 'schedule.addEvent')}
                footer={<>
                    {(days.length === 0 || !scheduleForm.startTime) && (
                        <span className={styles.note}>{t('schedule.saveHint')}</span>
                    )}
                    <Button text={t('common.save')} style='success' disabled={days.length === 0 || !scheduleForm.startTime} onClick={saveEvents} />
                </>}
            >

                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    <Input type="custom" label={t('schedule.days')}
                        extraInfo={activePreset ? t(`schedule.${activePreset === 'weekdays' ? 'weekdaysShort' : activePreset === 'daily' ? 'daily' : 'weekendShort'}` as any)
                            : days.length ? t('schedule.week.daysCount', { count: days.length }) : undefined}>
                        <div className={styles.dayChips}>
                            {WEEK.map(d => (
                                <button key={d} type="button" aria-pressed={days.includes(d)} aria-label={dayName(d)}
                                    className={`${styles.dayChip} ${days.includes(d) ? styles.dayChipOn : ''}`}
                                    onClick={() => setDays(days.includes(d) ? days.filter(x => x !== d) : [...days, d])}>
                                    {shortDay(d)}
                                </button>
                            ))}
                        </div>
                    </Input>

                    <Input
                        type="select"
                        label={t('common.mode')}
                        options={[
                            { value: CleaningMode.ECO, label: t('modes.eco') },
                            { value: CleaningMode.NORMAL, label: t('modes.normal') },
                        ]}
                        value={scheduleForm.mode}
                        extraInfo={t(gen3CleaningModeHelp(scheduleForm.mode) as any)}
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
                        extraInfo={scheduleForm.navigationMode === CleaningNavigationMode.DEEP
                            ? `${t('modeHelp.navigation.deep')} ${t('schedule.deepNeedsNormal')}`
                            : t(gen3NavigationHelp(scheduleForm.navigationMode) as any)}
                        onChange={(navigationMode) => updateForm(SetScheduleForm, navigationMode === CleaningNavigationMode.DEEP
                            ? { navigationMode, mode: CleaningMode.NORMAL } : { navigationMode })}
                    />

                    <Input
                        type="time"
                        label={`${t('common.time')} (${serverInfo?.timezone ?? 'UTC'})`}
                        value={scheduleForm.startTime}
                        extraInfo={!scheduleForm.startTime ? t('schedule.timeHint') : undefined}
                        onChange={(startTime) => updateForm(SetScheduleForm, { startTime })} />

                    <span className={styles.note}>
                        {formMinutes != null
                            ? t('schedule.week.takes', { minutes: formMinutes }) + (scheduleForm.startTime ? ` (${scheduleForm.startTime} – ${formatHHMM(minutesOf(scheduleForm.startTime) + formMinutes)})` : '')
                            : t('schedule.week.noEstimateLong')}
                    </span>

                    <Input
                        type="multi-select"
                        label={t('schedule.selectZones')}
                        extraInfo={t('schedule.selectZonesHelp')}
                        options={zoneOptions}
                        value={formZones}
                        onChange={(zones) => updateForm(SetScheduleForm, { zones })}
                    />

                    {needsPi && (
                        <span className={styles.note}>
                            <FaServer size={12} /> {t('schedule.runsOnPi', { what: t(piNeedsNavigation && piNeedsZones ? 'schedule.piWhatBoth' : piNeedsNavigation ? 'schedule.piWhatNavigation' : 'schedule.piWhatZones') })}
                            {formFallbacks.length > 0 && <> {t('schedule.fallbackNote', { times: formFallbacks.join(', ') })}</>}
                        </span>
                    )}

                    {editing?.kind === 'pi' && !needsPi && (
                        <span className={styles.note}>{t('schedule.movesToRobot')}</span>
                    )}

                    {formOverlaps.length > 0 && (
                        <span className={`${styles.note} ${styles.warnNote}`}>
                            <FaExclamationTriangle /> {t('schedule.week.formOverlap', { times: formOverlaps.map(o => `${shortDay(o.day)} ${formatHHMM(o.start)}`).join(', ') })}
                        </span>
                    )}
                </div>

            </Drawer>}

        </div>
    )
}
