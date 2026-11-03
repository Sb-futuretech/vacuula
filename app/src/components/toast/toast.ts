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

// "Saved" when the promise resolves, else why not (the server answers 504 when the robot did not
// answer, 400 when it said no). Returns the promise unchanged.
export function withFeedback<T>(promise: Promise<T>): Promise<T> {
    promise.then(
        () => showToast(i18n.t('common.saved')),
        (e: AxiosError) => showToast(i18n.t(e.response?.status === 504 || !e.response ? 'common.notSavedNoAnswer'
            : e.response.status === 400 ? 'common.notSavedRefused' : 'common.notSaved'), false))
    return promise
}
