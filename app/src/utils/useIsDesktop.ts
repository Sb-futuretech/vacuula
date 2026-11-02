import { useSyncExternalStore } from 'react'

// keep in sync with $desktop in variables.scss
const DESKTOP_QUERY = '(min-width: 900px)'

// true while the media query matches, updated when the window changes
export function useMediaQuery(query: string) {
    const subscribe = (onChange: () => void) => {
        const mq = window.matchMedia(query)
        mq.addEventListener('change', onChange)
        return () => mq.removeEventListener('change', onChange)
    }
    return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches)
}

// true while the window is wide enough for the desktop layout
export function useIsDesktop() {
    return useMediaQuery(DESKTOP_QUERY)
}
