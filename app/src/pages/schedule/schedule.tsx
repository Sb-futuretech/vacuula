import { useEffect, useState } from 'react'
import styles from './schedule.module.scss'
import Drawer from '../../components/drawer/drawer'

import type { GetSchedule, ScheduleEvent } from './types'
import { FaTrash } from 'react-icons/fa'
import Input from '../../components/input/input'
import Button from '../../components/button/button'
import { GEN3_COMMANDS } from '../../http/gen3'
import { CleaningMode } from '../../types/neato/gen3/state'
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

    const zoneOptions = (persistentMaps ?? [])
        .filter(m => 'enabled' in m && m.enabled)
        .flatMap(m => getCachedZones(robot.serial, m.id).map(z => ({ value: z.id, label: `${m.name} - ${z.name}` })))


    const [scheduleForm, SetScheduleForm] = useState<Omit<ScheduleEvent, 'day'>>({
        startTime: '',
        mode: CleaningMode.ECO
    })
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

    const removeEvent = (event: ScheduleEvent) => {
        if (!schedule) return;
        GEN3_COMMANDS.setSchedule(robot.serial, schedule.events.filter(e => e !== event)).finally(() => getSchedule())
    }

    const addEvents = () => {
        if (!schedule) return;
        const zoneOf = (e: ScheduleEvent) => e.boundaryId ?? e.boundary?.id
        const added: ScheduleEvent[] = days.map(day => ({ ...scheduleForm, day }))
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

                {sortedEvents.map((item, i) => {
                    return (
                        <div key={i} className={styles.item}>
                            <div className={styles.info}>
                                <span>{item.startTime}</span>
                                <span className={styles.type}>
                                    {t('schedule.gen3Summary', { day: t(`days.${dayKey(item.day)}`), mode: CleaningMode[item.mode] })}
                                    {item.boundary && ` | ${t('schedule.gen3SummaryZone', { zone: decodeRobotText(item.boundary.name) })}`}
                                </span>
                            </div>
                            <FaTrash onClick={() => removeEvent(item)} />
                        </div>
                    )
                })}
                {sortedEvents.length === 0 && (
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
                        onChange={(mode) => updateForm(SetScheduleForm, { mode })}
                    />

                    <Input
                        type="time"
                        label={`${t('common.time')} (${serverInfo?.timezone ?? 'UTC'})`}
                        value={scheduleForm.startTime}
                        onChange={(startTime) => updateForm(SetScheduleForm, { startTime })} />

                    <Input
                        type="select"
                        label={t('schedule.selectZones')}
                        extraInfo={t('schedule.selectZonesHelp')}
                        options={zoneOptions}
                        allowDeselect
                        value={scheduleForm.boundaryId}
                        onChange={(boundaryId) => updateForm(SetScheduleForm, { boundaryId })}
                    />

                    <Button text={t('common.save')} style='success' disabled={days.length === 0 || !scheduleForm.startTime} onClick={addEvents} />
                </div>

            </Drawer>

        </div>
    )
}
