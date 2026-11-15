import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Http, type LiveLidar } from '../../http'
import { useLiveScan } from '../../context/liveScan'
import LidarView from './LidarView'

// The lidar view of the clean running now: the grid from the server every POLL_MS, and the turn the
// robot sees right now (played back from the server's live events).

const POLL_MS = 4000          // the grid grows slowly: fetched this often
const SCAN_FRESH_S = 5

interface Props {
    serial: string
    // false: nothing to show (yet) -> the caller shows something else
    onAvailable?: (available: boolean) => void
}

export default function LiveLidarView({ serial, onAvailable }: Props) {
    const { t } = useTranslation()
    const liveScan = useLiveScan()
    const [data, setData] = useState<LiveLidar | null>(null)

    useEffect(() => {
        let cancelled = false
        const load = () => Http.getLiveLidar(serial)
            // only a whole answer: one without its picture (seen 2026-11-15) would crash the view
            .then(res => { if (!cancelled) setData(res.data?.grid?.png ? res.data : null) })
            .catch(() => { })
        load()
        const id = window.setInterval(load, POLL_MS)
        return () => { cancelled = true; clearInterval(id) }
    }, [serial])
    useEffect(() => onAvailable?.(!!data), [!!data]) // eslint-disable-line react-hooks/exhaustive-deps

    if (!data) return null
    const scan = liveScan && Date.now() / 1000 - liveScan.t < SCAN_FRESH_S ? liveScan.scan : null
    return <LidarView data={data} scan={scan} caption={t('home.lidarLive')} />
}
