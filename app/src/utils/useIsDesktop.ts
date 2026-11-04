import { useCallback, useMemo, useSyncExternalStore } from 'react'

// keep in sync with $desktop in variables.scss
const DESKTOP_QUERY = '(min-width: 900px)'

// true while the media query matches, updated when the window changes
export function useMediaQuery(query: string) {
    // one MediaQueryList and subscription per query, not a new one on every render
    const mq = useMemo(() => window.matchMedia(query), [query])
    const subscribe = useCallback((onChange: () => void) => {
        mq.addEventListener('change', onChange)
        return () => mq.removeEventListener('change', onChange)
    }, [mq])
    return useSyncExternalStore(subscribe, () => mq.matches)
}

// true while the window is wide enough for the desktop layout
export function useIsDesktop() {
    return useMediaQuery(DESKTOP_QUERY)
}
