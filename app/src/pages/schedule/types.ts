import type { RobotDay } from "../../types/neato/gen3/api"
import type { CleaningMode } from "../../types/neato/gen3/state"

export interface ScheduleEvent {
    mode: CleaningMode
    day: RobotDay
    startTime: string // HH:MM
    boundaryId?: string // Zone cleaning
    // getSchedule returns the zone as `boundary` (+ `mapId`) instead of `boundaryId`
    boundary?: { id: string, name: string }
    mapId?: string
}

export interface GetSchedule {
    enabled: boolean
    events: ScheduleEvent[]
}
