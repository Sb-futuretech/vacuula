import type { AxiosError } from 'axios'
import i18n from '../../i18n'

// Short messages at the bottom of the app (shown by Toaster), e.g. whether the robot took a change.
export type Toast = { id: number, text: string, ok: boolean }

let listener: ((toast: Toast) => void) | null = null
let nextId = 0

export function onToast(fn: ((toast: Toast) => void) | null) {
    listener = fn
}

export function showToast(text: string, ok = true) {
    listener?.({ id: ++nextId, text, ok })
}

// okKey ("Saved"; null: nothing) when the promise resolves, else failKey ("Not saved") and why, from the server's
// answer: none at all (server not reached), 504 (the robot did not answer), the robot's own reply
// (gen3 `result`, gen4 `code`: it refused), 502 or "Robot not connected…" (not connected), else no
// reason. Returns the promise unchanged.
export function withFeedback<T>(promise: Promise<T>, okKey: string | null = 'common.saved', failKey = 'common.notSaved'): Promise<T> {
    promise.then(
        () => { if (okKey) showToast(i18n.t(okKey)) },
        (e: AxiosError<{ result?: string, code?: number, error?: string }>) => {
            const res = e.response
            const reason = !res ? 'common.reasonServer'
                : res.status === 504 ? 'common.reasonNoAnswer'
                    : res.data?.result !== undefined || res.data?.code !== undefined ? 'common.reasonRefused'
                        : res.status === 502 || res.data?.error?.startsWith('Robot not connected') ? 'common.reasonOffline'
                            : null
            showToast(reason ? `${i18n.t(failKey)}: ${i18n.t(reason)}.` : `${i18n.t(failKey)}.`, false)
        })
    return promise
}
