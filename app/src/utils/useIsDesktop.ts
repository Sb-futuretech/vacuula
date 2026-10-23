import { useSyncExternalStore } from 'react'

// keep in sync with $desktop in variables.scss
const DESKTOP_QUERY = '(min-width: 900px)'

const subscribe = (onChange: () => void) => {
    const mq = window.matchMedia(DESKTOP_QUERY)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
}

// true while the window is wide enough for the desktop layout
export function useIsDesktop() {
    return useSyncExternalStore(subscribe, () => window.matchMedia(DESKTOP_QUERY).matches)
}
