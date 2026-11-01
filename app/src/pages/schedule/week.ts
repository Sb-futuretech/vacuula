// The week view's data: every Pi entry and robot event placed on its days, with how long it takes
// (estimated from the stored runs), which robot events are a Pi entry's fallback, and which overlap.
import type { PiScheduleEntry, RobotStats } from '../../http'
import { CleaningMode, CleaningNavigationMode } from '../../types/neato/gen3/state'
import { RobotDay } from '../../types/neato/gen3/api'
import type { ScheduleEvent } from './types'

// a robot event this close to a Pi entry is its fallback (server: gen3/pi_schedule.py OVERLAP_MIN)
export const OVERLAP_MIN = 15
// length assumed for the overlap check while there is no estimate
const UNKNOWN_MIN = 30

export const minutesOf = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m }
export const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
export const mondayFirst = (d: number) => (d + 6) % 7
export const WEEK: RobotDay[] = [RobotDay.MONDAY, RobotDay.TUESDAY, RobotDay.WEDNESDAY, RobotDay.THURSDAY, RobotDay.FRIDAY, RobotDay.SATURDAY, RobotDay.SUNDAY]
export const zoneOf = (e: ScheduleEvent) => e.boundaryId ?? e.boundary?.id

// robot events with the same time, mode and zone on several days, shown and edited as one entry
export interface RobotGroup { key: string, startTime: string, mode: CleaningMode, zoneId?: string, zoneName?: string, days: RobotDay[], events: ScheduleEvent[] }
export const groupEvents = (events: ScheduleEvent[]): RobotGroup[] => {
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

export type Level = 'eco' | 'normal' | 'deep'
export const levelOf = (mode: CleaningMode, navigationMode: CleaningNavigationMode): Level =>
    navigationMode !== CleaningNavigationMode.NORMAL ? 'deep' : mode === CleaningMode.ECO ? 'eco' : 'normal'

/** How long a run is out (start to end, recharging included), from the stored runs; null without data. */
export function estimateMinutes(stats: RobotStats | undefined, mode: CleaningMode, navigationMode: CleaningNavigationMode, zoneIds: string[]): number | null {
    if (!stats) return null
    let base: number
    if (zoneIds.length) {
        const per = zoneIds.map(id => stats.zones.find(z => z.id === id)).map(z => z ? (z.wallMinutes ?? z.minutes) : null)
        if (per.some(m => m == null)) return null
        base = per.reduce<number>((sum, m) => sum + (m ?? 0), 0)
    } else {
        if (!stats.wholeMap) return null
        base = stats.wholeMap.minutes
    }
    // the runs behind `base` mix modes: scale by how fast this mode cleans against all runs
    const overall = stats.totals.all.areaPerMinute
    const own = stats.speedGroups.find(g => g.mode === mode && g.navigationMode === navigationMode)?.areaPerMinute
    const factor = overall && own ? Math.min(2.5, Math.max(0.5, overall / own)) : 1
    return Math.max(1, Math.round(base * factor))
}

export interface Slot {
    key: string
    day: RobotDay
    start: number // minutes after midnight, server time
    minutes: number | null // estimated length
    kind: 'pi' | 'robot'
    pi?: PiScheduleEntry
    group?: RobotGroup
    active: boolean // a paused Pi entry, or robot events while the robot's schedule is off, do not run
    mode: CleaningMode
    navigationMode: CleaningNavigationMode
    zoneIds: string[]
    zoneNames: string[]
    backups: ScheduleEvent[] // robot events that only run when the Pi is off (Pi slots)
    overlaps: Slot[] // other active slots on the day running at the same time
    lane: number
    lanes: number
}

/** The week, Monday first: each day's slots by start time. */
export function buildWeek(piEntries: PiScheduleEntry[], events: ScheduleEvent[], robotScheduleOn: boolean,
    estimate: (mode: CleaningMode, nav: CleaningNavigationMode, zoneIds: string[]) => number | null): Slot[][] {
    const groups = groupEvents(events)
    const week: Slot[][] = WEEK.map(() => [])

    for (const entry of piEntries) {
        const zoneIds = entry.zones.map(z => z.boundaryId)
        const minutes = estimate(entry.mode, entry.navigationMode, zoneIds)
        for (const day of entry.days) {
            week[mondayFirst(day)].push({
                key: `pi-${entry.id}-${day}`, day, start: minutesOf(entry.startTime), minutes, kind: 'pi', pi: entry,
                active: entry.enabled ?? true, mode: entry.mode, navigationMode: entry.navigationMode,
                zoneIds, zoneNames: entry.zones.map(z => z.name), backups: [], overlaps: [], lane: 0, lanes: 1,
            })
        }
    }

    for (const group of groups) {
        const zoneIds = group.zoneId ? [group.zoneId] : []
        const minutes = estimate(group.mode, CleaningNavigationMode.NORMAL, zoneIds)
        for (const event of group.events) {
            const start = minutesOf(event.startTime)
            const day = week[mondayFirst(event.day)]
            // the fallback of a Pi entry that runs: the server switches it off around the Pi's start
            const owner = day.find(s => s.kind === 'pi' && s.active && Math.abs(s.start - start) <= OVERLAP_MIN)
            if (owner) {
                owner.backups.push(event)
                continue
            }
            day.push({
                key: `robot-${group.key}-${event.day}`, day: event.day, start, minutes, kind: 'robot', group,
                active: robotScheduleOn, mode: group.mode, navigationMode: CleaningNavigationMode.NORMAL,
                zoneIds, zoneNames: group.zoneName ? [group.zoneName] : [], backups: [], overlaps: [], lane: 0, lanes: 1,
            })
        }
    }

    for (const day of week) {
        day.sort((a, b) => a.start - b.start)
        const running = day.filter(s => s.active)
        for (const [i, a] of running.entries()) {
            for (const b of running.slice(i + 1)) {
                if (b.start < a.start + (a.minutes ?? UNKNOWN_MIN)) {
                    a.overlaps.push(b)
                    b.overlaps.push(a)
                }
            }
        }
        // overlapping slots share the row: each gets its own lane
        for (const s of day) {
            if (!s.overlaps.length) continue
            const taken = s.overlaps.filter(o => day.indexOf(o) < day.indexOf(s)).map(o => o.lane)
            while (taken.includes(s.lane)) s.lane++
        }
        for (const s of day) s.lanes = Math.max(1, s.lane + 1, ...s.overlaps.map(o => o.lane + 1))
    }
    return week
}

/** The next active slot from `now` (server time), and how many days ahead it is. */
export function nextRun(week: Slot[][], now: Date): { slot: Slot, daysAhead: number, minutesUntil: number } | null {
    const today = now.getUTCDay() as RobotDay
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes()
    for (let ahead = 0; ahead <= 7; ahead++) {
        const day = week[mondayFirst((today + ahead) % 7)]
        const slot = day.find(s => s.active && (ahead > 0 || s.start > nowMin))
        if (slot) return { slot, daysAhead: ahead, minutesUntil: ahead * 1440 + slot.start - nowMin }
    }
    return null
}

/** Active slots on `days` overlapping a run at `start` of `minutes`, apart from `skip` and fallback pairs. */
export function overlapsWith(week: Slot[][], days: RobotDay[], start: number, minutes: number | null, isPi: boolean, skip: (s: Slot) => boolean): Slot[] {
    const length = minutes ?? UNKNOWN_MIN
    return days.flatMap(d => week[mondayFirst(d)]).filter(s => {
        if (!s.active || skip(s)) return false
        // a robot event next to a Pi entry is its fallback, not a second run
        if ((s.kind === 'pi') !== isPi && Math.abs(s.start - start) <= OVERLAP_MIN) return false
        return s.start < start + length && start < s.start + (s.minutes ?? UNKNOWN_MIN)
    })
}
