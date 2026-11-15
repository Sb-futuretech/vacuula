import axios, { type AxiosResponse } from "axios";
import i18n from "./i18n";
import { Neato, type QuickRobotInfo } from "./types";
import type { NoGoLine, VacuulaMapData, Zone } from "./components/map/types";

declare module 'axios' {
  export interface AxiosRequestConfig {
    skipLoader?: boolean;
  }
}

const ha_ingress = window.location.pathname.match(/^\/api\/hassio_ingress\/[^/]+/)
export const BASE_PATH = ha_ingress ? ha_ingress[0] : ""

/** GET /api/server */
export interface ServerInfo {
  version: string
  /** this fork's own version and build commit (fork_version.py) */
  fork_version?: string
  fork_commit?: string
  min_installer_version: string
  gen3_port: number
  gen4_port: number

  timezone: string
  utc_offset_minutes: number
}

const instance = axios.create({
  baseURL: `${BASE_PATH}/api`, 
});

export type LoadingState = { isLoading: boolean; message?: string };

let loadingStateCallback: ((state: LoadingState) => void) | null = null;
let pendingRequests = 0;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

const startLoading = () => {
  pendingRequests += 1;
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (pendingRequests === 1) {
    loadingStateCallback?.({ isLoading: true, message: i18n.t('common.sendingCommand') });
  }
};

const stopLoading = () => {
  pendingRequests = Math.max(0, pendingRequests - 1);
  if (pendingRequests === 0) {
    // small delay avoids flicker when requests fire back to back
    hideTimer = setTimeout(() => {
      hideTimer = null;
      loadingStateCallback?.({ isLoading: false });
    }, 150);
  }
};


instance.interceptors.request.use((config) => {
  if (!config.skipLoader) startLoading();
  return config;
});

instance.interceptors.response.use(
  (response) => {
    if (!response.config.skipLoader) stopLoading();
    return response;
  },
  (error) => {
    if (!error.config?.skipLoader) stopLoading();
    return Promise.reject(error);
  }
);

/** A schedule entry the server runs itself (gen3): navigation modes and several zones */
export interface PiScheduleEntry {
  id: number
  days: number[] // robot day numbers, 0 = Sunday
  startTime: string // HH:MM, server time
  mode: number
  navigationMode: number
  zones: { mapId: string, boundaryId: string, name: string }[] // empty: whole map
  enabled?: boolean // off: kept, but not run
}

/** GET /api/robot/<serial>/stats (gen3) */
// floor type on a gen3 map (from the black box's brush load): cells [u, v, kind] with kind 1 hard,
// 2 runner, 3 high pile; carpet areas with a rectangle (map cells) to offer as a zone
export interface MapFloor {
  cells: [number, number, 1 | 2 | 3][]
  patches: { kind: 'high' | 'runner', areaM2: number, share: number, rect: [number, number][] }[]
}

// gen3 lidar (server gen3/lidar.py), all in mm of the robot's own frame (y up): one turn of the lidar,
// the robot's pose then ([x, y, heading in degrees counter-clockwise]) and the points it hit
export interface LidarScan {
  pose: [number, number, number]
  pts: [number, number][]
}

// the stored map the robot's frame lies on: its id, where the frame's origin is in its cells, mm per cell
export interface LidarMap {
  mapId: string
  u0: number
  v0: number
  mmPerCell: number
}

// what the lidar saw in the clean running now: the grid so far as a grey PNG (0 unknown, 128 free, 255
// something there) with its top left corner (x0, y0) and cell size in mm, the robot's pose and its way
export interface LiveLidar {
  t: number
  running: boolean
  map: LidarMap | null
  grid: { png: string, x0: number, y0: number, cell: number, width: number, height: number }
  pose: [number, number, number]
  track: [number, number][]
  // finished runs: what stood where the map's other runs agree it is free (null: can't be told)
  changes?: LidarChange[] | null
}

// a new obstacle or a closed door in a run (server gen3/lidar_map.changes): the length of the side the
// lidar saw, its middle and box in mm of the robot's frame
export interface LidarChange {
  kind: 'obstacle' | 'door'
  lengthCm: number
  x: number
  y: number
  box: [number, number, number, number]
}

// what the lidar saw over all runs on a stored map (server gen3/lidar_map.py): a grey PNG whose `values`
// mark free, movable (something there in some runs) and fixed (in nearly all), its top left corner
// (x0, y0) and cell size in mm of the robot's frame, and where that frame lies on the map
export interface MapLidar {
  png: string
  x0: number
  y0: number
  cell: number
  width: number
  height: number
  runs: number
  values: { free: number, movable: number, fixed: number }
  map: LidarMap
}

// a problem the robot noted in its black box (gen3), where it happened: cells of a run map or stored map
export interface Problem {
  kind: 'bump' | 'tilt' | 'lost' | 'unreachable' | 'slip' | 'stuck' | 'dock_tilted' | 'off_base'
  detail: string
  u: number
  v: number
  run?: string | null
  at?: string
}

// how much of its area a run cleaned (gen3, from its black box track); `missed` is RLE [value, count]
// over the run map, 1 = free floor that was not cleaned
export interface RunCoverage {
  percent: number
  areaM2: number
  missedM2: number
  zone: boolean
  width: number
  height: number
  missed: [number, number][]
  cleaned?: [number, number][] // what it cleaned on free floor (newer tracks)
}

export interface StatsTotals { runs: number, area: number, hours: number, areaPerMinute: number | null }
export interface RobotStats {
  totals: { week: StatsTotals, month: StatsTotals, all: StatsTotals }
  daily: { date: string, area: number, runs: number }[] // the last 28 days, oldest first
  // battery use of runs without a recharge break; perHour is per hour of actual cleaning
  battery: { startAt: string, mode: number | null, navigationMode: number | null, used: number, area: number, perHour: number, chargeStart: number }[]
  // every measurable run per mode + navigation the robot reported, summed up
  batteryGroups: { mode: number | null, navigationMode: number | null, runs: number, used: number, minutesPerCharge: number | null, areaPerCharge: number | null }[]
  speedGroups: { mode: number | null, navigationMode: number | null, runs: number, areaPerMinute: number | null }[]
  // share of its area a run cleaned (its zone, or all free floor), from its black box track
  coverageGroups?: { zone: boolean, mode: number | null, navigationMode: number | null, runs: number, percent: number, lowest: number }[]
  batteryWeekly: { week: string, index: number | null, runs: number, skipped?: number, newBattery?: boolean, used: number, combos: { mode: number | null, navigationMode: number | null, runs: number }[] }[]
  batteryInfo?: { serial: number | null, vendor: string | null, designCapacity: number | null, totalCharges: number | null,
    timeToEmpty: number | null, level: number | null, runSeconds: number | null, at: string } | null
  batteryChanges?: { at: string, serial: number, totalCharges: number | null }[]
  zones: { id: string, name: string, mapId: string, runs: number, lastAt: string | null, minutes: number, area: number, areaPerMinute: number | null,
    wallMinutes?: number | null, coverage?: number | null }[] // wallMinutes: start to end of a finished run, recharging included; coverage: % of the zone cleaned
  wholeMap?: { runs: number, minutes: number } | null // the same for a whole map run
  batteryNotMeasurable: number // recharged in between or no battery values
  reliability: { runs: number, complete: number, canceled: number, withError: number, recharged: number, pickedUp: number, localizationLost: number }
  launchedFrom: Record<string, number>
  problems: { kind: 'error' | 'alert', code: string, count: number, lastAt: number }[]
}

// a robot's Telegram messages (server: telegram.py); the token itself never comes back
export type TelegramKind = 'error' | 'alert' | 'offline' | 'online' | 'run_done' | 'schedule'
export interface TelegramSettings {
  botName: string | null
  tokenSet: boolean
  chatId: string | null
  chatName: string | null
  kinds: TelegramKind[]
  enabled: boolean
  groups: TelegramKind[]
}
export interface TelegramChat { id: string, name: string, type: string }

// One entry of the notification centre (server: vacuula_server/notifications.py)
export interface AppNotification {
  id: number
  createdAt: number // unix seconds
  kind: 'run_done' | 'error' | 'alert' | 'away_from_base' | 'stuck' | 'unstuck' | 'offline' | 'online' | 'robot_push' | 'schedule_overlap' | 'schedule_skipped' | 'schedule_clock'
  code: string | null // robot error / alert / push message code, or the run id for run_done
  data: Record<string, any>
}

// Gen3 zone queue as the server reports it (GET /zone-queue and `zoneQueue` events)
export interface ZoneQueueStatus {
  index: number // zone being cleaned (or next, while waiting)
  total: number
  zones: { mapId: string, boundaryId: string, name: string }[]
  results: { boundaryId: string, name: string, alert: string | null }[] // finished zones
  waiting: boolean // between two zones
  skipped: boolean // the zones after the current one were dropped
  done: boolean // last status of a finished queue
}

export type DriveCombo = 'forward' | 'back' | 'stop' | 'arc-left' | 'arc-right' | 'pivot-left' | 'pivot-right'
export type DriveCommand = `${'vacuum' | 'brush' | 'eco' | 'turbo'}-${'on' | 'off'}`

// robot reads that are shared (see Http.sendCmd)
const SHARED_READS = new Set(['getRobotState', 'getSchedule', 'getMapBoundaries', 'getGeneralInfo', 'getPreferences'])
const SHARE_MS = 1500
interface SharedRead { at: number | null, promise: Promise<AxiosResponse<unknown>> }
const sharedReads = new Map<string, SharedRead>()

export class Http {
  // Robot commands. A read the app asks for from several places at once (on start: the robot is
  // selected twice and the live connection opens -- three getRobotState in 0.7 s, each one a trip to the
  // robot of 0.3-1.3 s) is shared: while one is under way, or its answer is less than SHARE_MS old,
  // the same answer is used. Any other command (start, save, dismiss...) changes the robot: the shared
  // answers of that robot are dropped, so a read after it always asks the robot again.
  static sendCmd<T>(robotSerial: string, cmd: object) {
    const name = (cmd as { cmd?: string }).cmd ?? ''
    if (!SHARED_READS.has(name)) {
      for (const key of sharedReads.keys()) if (key.startsWith(robotSerial + '|')) sharedReads.delete(key)
      return instance.post<T>(`/robot/${robotSerial}/command`, JSON.stringify(cmd));
    }
    const key = `${robotSerial}|${JSON.stringify(cmd)}`
    const hit = sharedReads.get(key)
    if (hit && (hit.at === null || Date.now() - hit.at < SHARE_MS)) return hit.promise as Promise<AxiosResponse<T>>
    const entry: SharedRead = { at: null, promise: instance.post<T>(`/robot/${robotSerial}/command`, JSON.stringify(cmd)) }
    entry.promise.then(() => { entry.at = Date.now() }, () => { if (sharedReads.get(key) === entry) sharedReads.delete(key) })
    sharedReads.set(key, entry)
    return entry.promise as Promise<AxiosResponse<T>>
  }

  static getNotifications(serial: string) {
    return instance.get<AppNotification[]>(`/robot/${serial}/notifications`)
  }

  static getZoneQueue(serial: string) {
    return instance.get<{ queue: ZoneQueueStatus | null }>(`/robot/${serial}/zone-queue`)
  }

  // the zone being cleaned finishes, the remaining ones are dropped
  static cancelZoneQueue(serial: string) {
    return instance.delete(`/robot/${serial}/zone-queue`)
  }

  // Gen3 manual drive: the server holds the connection to the robot (gen3/manual_drive.py)
  static driveStart(serial: string) {
    return instance.post(`/robot/${serial}/drive/start`)
  }

  static drive(serial: string, message: { combo: DriveCombo } | { command: DriveCommand }) {
    return instance.post(`/robot/${serial}/drive`, message)
  }

  static driveStop(serial: string) {
    return instance.post(`/robot/${serial}/drive/stop`)
  }

  // Gen3: the server cleans the zones one after another (the D7 ignores `boundaryIds`)
  static startZoneQueue(serial: string, zones: { mapId: string, boundaryId: string, name?: string }[], mode: number, navigationMode: number) {
    return instance.post(`/robot/${serial}/zone-queue`, { zones, mode, navigationMode })
  }

  static getPersistentMaps(serial: string) {
    return instance.get<Neato.Gen3.PersistentMap[] | Neato.Gen4.Floorplan[]>(`/robot/${serial}/maps`)
  }

  static getPersistentMap(serial: string, mapId: string) {
    return instance.get<VacuulaMapData>(`/robot/${serial}/maps/${mapId}`)
  }

  static postUseMapAsFloorPlan(serial: string, mapId: string) {
    return instance.post(`/robot/${serial}/maps/${mapId}/use`)
  }

  static postUnuseMapAsFloorPlan(serial: string, mapId: string) {
    return instance.post(`/robot/${serial}/maps/${mapId}/unuse`)
  }

  static updatePersistentMap(serial: string, mapId: string, data: { name?: string, enabled?: boolean }) {
    return instance.post(`/robot/${serial}/maps/${mapId}`, data)
  }

  static postBoundaries(serial: string, mapId: string, data: (NoGoLine | Zone)[]) {
    return instance.post(`/robot/${serial}/maps/${mapId}/boundaries`, data)
  }

  static getBoundaries(serial: string, mapId: string) {
    return instance.get(`/robot/${serial}/maps/${mapId}/boundaries`)
  }

  static promoteFloorplan(serial: string, mapId: string) {
    return instance.post(`/robot/${serial}/maps/${mapId}/promote`)
  }

  static getPiSchedule(serial: string) {
    return instance.get<PiScheduleEntry[]>(`/robot/${serial}/pi-schedule`)
  }

  static addPiSchedule(serial: string, entry: Omit<PiScheduleEntry, 'id'>) {
    return instance.post<PiScheduleEntry>(`/robot/${serial}/pi-schedule`, JSON.stringify(entry))
  }

  static updatePiSchedule(serial: string, id: number, entry: Omit<PiScheduleEntry, 'id'>) {
    return instance.put<PiScheduleEntry>(`/robot/${serial}/pi-schedule/${id}`, JSON.stringify(entry))
  }

  static deletePiSchedule(serial: string, id: number) {
    return instance.delete(`/robot/${serial}/pi-schedule/${id}`)
  }

  static getTelegram(serial: string) {
    return instance.get<TelegramSettings>(`/robot/${serial}/telegram`)
  }

  /** Every key optional; token "" removes bot and chat. Fails with `{error}` when Telegram refuses the token. */
  static updateTelegram(serial: string, body: { token?: string, chatId?: string | null, chatName?: string | null, kinds?: TelegramKind[], enabled?: boolean }) {
    return instance.put<TelegramSettings>(`/robot/${serial}/telegram`, JSON.stringify(body))
  }

  static findTelegramChats(serial: string) {
    return instance.post<TelegramChat[]>(`/robot/${serial}/telegram/chats`)
  }

  static testTelegram(serial: string) {
    return instance.post(`/robot/${serial}/telegram/test`)
  }

  static getStats(serial: string) {
    return instance.get<RobotStats>(`/robot/${serial}/stats`)
  }

  static getCleanings(serial: string) {
    return instance.get(`/robot/${serial}/runs`)
  }

  static getCleaning(serial: string, runId: string) {
    return instance.get(`/robot/${serial}/run/${runId}`)
  }

  // gen3: where the robot was last shown on its map, also while it does not clean (null if never)
  static getLastPosition(serial: string) {
    return instance.get<{ mapId: string, u: number, v: number, heading: number, t: number } | null>(`/robot/${serial}/last-position`)
  }

  // gen3: the way of the clean running now, for an app that opens or reloads during it (null if none)
  // gen3: what the lidar saw in the clean running now (grid so far, pose, way), null without one
  static getLiveLidar(serial: string) {
    return instance.get<LiveLidar | null>(`/robot/${serial}/live-lidar`, { skipLoader: true }) // every few s: no spinner
  }

  // gen3: what the lidar saw in a finished run, like getLiveLidar (404 without one)
  static getRunLidar(serial: string, runId: string) {
    return instance.get<LiveLidar>(`/robot/${serial}/run/${runId}/lidar`, { skipLoader: true })
  }

  static getLiveTrack(serial: string) {
    return instance.get<{ mapId: string, points: [number, number][], t: number } | null>(`/robot/${serial}/live-track`)
  }

  // gen3: floor type per cell of a map from the brush load over the runs, and carpet areas as zone offers
  static getMapFloor(serial: string, mapId: string) {
    return instance.get<MapFloor>(`/robot/${serial}/maps/${mapId}/floor`)
  }

  // gen3: bumps, tilts, getting lost or stuck recorded on a map over the last runs (map cells)
  // gen3: in how many of a map's last `runs` runs each cell was cleaned, worked out by the server once
  // per run (counts as RLE over the stored map)
  static getMapCoverage(serial: string, mapId: string, runs: number) {
    return instance.get<{ width: number, height: number, runs: number, blackBoxRuns: number, counts: [number, number][] }>(
      `/robot/${serial}/maps/${mapId}/coverage/${runs}`)
  }

  // gen3: where each run of a map lies on it ({run id: [dx, dy]}, null: not on it), worked out by the server
  static getMapOffsets(serial: string, mapId: string) {
    return instance.get<Record<string, [number, number] | null>>(`/robot/${serial}/maps/${mapId}/offsets`, { skipLoader: true })
  }

  // TEMPORARY: how long a step of the app took on the user's device, into the server's log
  static clientTiming(data: object) {
    return instance.post('/client-timing', JSON.stringify(data), { skipLoader: true }).catch(() => { })
  }

  // gen3: what the lidar saw over all runs on a map (fixed, movable, free), 404 without
  static getMapLidar(serial: string, mapId: string) {
    return instance.get<MapLidar>(`/robot/${serial}/maps/${mapId}/lidar`)
  }

  static getMapProblems(serial: string, mapId: string) {
    return instance.get<Problem[]>(`/robot/${serial}/maps/${mapId}/problems`)
  }

  // gen3: the way a run drove, from its black box, in cells of the run's map (404 without one)
  static getRunTrack(serial: string, runId: string) {
    return instance.get<{ cells: [number, number][], coverage?: RunCoverage | null, problems?: Problem[] }>(`/robot/${serial}/run/${runId}/track`)
  }

  static deleteFloorplan(serial: string, mapId: string) {
    return instance.delete(`/robot/${serial}/maps/${mapId}`)
  }

  // TODO: look over if i want this as a put or not
  static restoreFloorplan(serial: string, mapId: string) {
    return instance.put(`/robot/${serial}/maps/${mapId}`)
  }

  static getRobots() {
    return instance.get<QuickRobotInfo>('/robots');
  }

  /** Server facts the UI needs: the IANA timezone it runs in and its current UTC offset. */
  static getServerInfo() {
    return instance.get<ServerInfo>('/server');
  }

  static getVacuulaCert() {
    return instance.get('/cert');
  }

  static updateRobot(serial: string, data: { name: string }) {
    return instance.post(`/robot/${serial}`, data)
  }

  static setLoadingStateCallback(cb: ((state: LoadingState) => void) | null) {
    loadingStateCallback = cb;
  }
}


