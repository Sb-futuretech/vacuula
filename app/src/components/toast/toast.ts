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

// okKey ("Saved") when the promise resolves, else why not, from the server's answer: no answer at all
// (server not reached), 504 (the robot did not answer), the robot's own reply with a result other
// than "ok" (it refused), "Robot not connected", or anything else. Returns the promise unchanged.
export function withFeedback<T>(promise: Promise<T>, okKey = 'common.saved'): Promise<T> {
    promise.then(
        () => showToast(i18n.t(okKey)),
        (e: AxiosError<{ result?: string, error?: string }>) => {
            const data = e.response?.data
            showToast(i18n.t(!e.response ? 'common.notSavedServer'
                : e.response.status === 504 ? 'common.notSavedNoAnswer'
                    : data?.result ? 'common.notSavedRefused'
                        : data?.error === 'Robot not connected' ? 'common.notSavedOffline'
                            : 'common.notSaved'), false)
        })
    return promise
}
