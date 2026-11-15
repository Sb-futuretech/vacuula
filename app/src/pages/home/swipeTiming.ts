import { Http } from '../../http'

// TEMPORARY (to be removed): how long showing another past run on the home page takes on the user's
// device, step by step, into the server's log (POST /api/client-timing). Starts at the arrow or swipe.
let current: { runId: string, t: number, steps: Record<string, unknown> } | null = null

export function startSwipe(runId: string) {
    current = { runId, t: performance.now(), steps: {} }
    const mine = current
    window.setTimeout(() => {
        if (current !== mine) return
        Http.clientTiming({ what: 'home last run', runId: mine.runId, steps: mine.steps, userAgent: navigator.userAgent })
        current = null
    }, 4000)
}

// a step done: ms since the arrow (a later call of the same step overwrites it: "drawn" = the last draw)
export function swipeTiming(step: string, data?: object) {
    if (!current) return
    current.steps[step] = { ms: Math.round(performance.now() - current.t), ...data }
}
