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

// okKey ("Saved"; null: nothing) when the promise resolves, else failKey ("Not saved") and why:
// - no answer at all, or a 502/503 without the server's own {error} (e.g. the Home Assistant proxy
//   while the add-on is down): the server could not be reached
// - 504: the robot did not answer
// - the robot's own reply (gen3 `result`, gen4 `code`) or "Robot rejected…": it refused
// - "Robot not connected…", "Failed to send … to robot" (dead connection): not connected
// The server words its errors in English; matching their starts is the contract until it sends codes.
// Returns the promise unchanged.
export function withFeedback<T>(promise: Promise<T>, okKey: string | null = 'common.saved', failKey = 'common.notSaved'): Promise<T> {
    promise.then(
        () => { if (okKey) showToast(i18n.t(okKey)) },
        (e: AxiosError<{ result?: string, code?: number, error?: string }>) => {
            const reason = failureReason(e)
            showToast(reason ? `${i18n.t(failKey)}: ${i18n.t(reason)}.` : `${i18n.t(failKey)}.`, false)
        })
    return promise
}

function failureReason(e: AxiosError<{ result?: string, code?: number, error?: string }>) {
    const res = e.response
    const data = typeof res?.data === 'object' ? res.data : undefined
    const error = typeof data?.error === 'string' ? data.error : undefined
    if (!res || ((res.status === 502 || res.status === 503) && !error)) return 'common.reasonServer'
    if (res.status === 504) return 'common.reasonNoAnswer'
    if (data?.result !== undefined || data?.code !== undefined || error?.startsWith('Robot rejected')) return 'common.reasonRefused'
    if (error?.startsWith('Robot not connected') || (error?.startsWith('Failed to send') && error.endsWith('to robot'))) return 'common.reasonOffline'
    return null
}
