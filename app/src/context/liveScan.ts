import { useSyncExternalStore } from 'react'
import type { LidarMap, LidarScan } from '../http'

// The lidar turn shown now while a gen3 robot cleans. Kept outside the app context on purpose: it
// changes 3 times a second, and only the views that draw it should render again, not the whole app.

// one lidar turn as shown: the turn, the stored map its frame lies on (or none), when it was shown (s)
export interface LiveScan {
    scan: LidarScan
    map: LidarMap | null
    t: number
}

// the server reads the black box every 2 s and sends that time's turns at once: played back over it
const SPAN_MS = 2000

let current: LiveScan | null = null
let timers: number[] = []
const listeners = new Set<() => void>()

function set(value: LiveScan | null) {
    current = value
    listeners.forEach(l => l())
}

// a batch from the server (event "liveScan"): shown one after the other over SPAN_MS
export function playLiveScans(map: LidarMap | null, scans: LidarScan[]) {
    timers.forEach(clearTimeout)
    timers = scans.map((scan, i) => window.setTimeout(() => set({ scan, map, t: Date.now() / 1000 }), i * SPAN_MS / scans.length))
}

// another robot, or the connection closed
export function clearLiveScan() {
    timers.forEach(clearTimeout)
    timers = []
    set(null)
}

export function useLiveScan(): LiveScan | null {
    return useSyncExternalStore(
        listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
        () => current,
    )
}
