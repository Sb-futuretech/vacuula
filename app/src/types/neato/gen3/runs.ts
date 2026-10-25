export enum StartedBy {
    APP = "app",
    BUTTON = "button",
    SCHEDULE = "schedule",
    INTERNAL = "internal"
}

export enum RunStates {
    NOT_STARTED = "not_started",
    DONE = "done",
    IN_PROGRESS = "in_progress",
    NOT_REACHABLE = "not_reachable",
    CANCELED = "canceled",
    PAUSED = "paused",
    SUSPEND_CHARGING = "suspend_charging",
    ERROR = "error"
}



export interface CleaningRun {
    id: string,
    robot: string,
    persistent_map: string
    run: Run
}

export interface Run {
    id: string
    persistent_map_id?: string // the stored map the run was on (missing for a mapping run)
    status: string
    launched_from: string
    error: string | null
    category: number
    mode: number
    modifier: number
    navigation_mode: number
    start_at: string
    end_at: string
    end_orientation_relative_degrees: number
    run_charge_at_start: number
    run_charge_at_end: number
    suspended_cleaning_charging_count: number
    time_in_suspended_cleaning: number
    time_in_error: number
    time_in_pause: number
    cleaned_area: number
    base_count: number
    is_docked: boolean
    delocalized_probability: number
    teleported: boolean
    picked_up_count: number
    localization_lost: boolean
    valid_as_persistent_map: boolean
}

