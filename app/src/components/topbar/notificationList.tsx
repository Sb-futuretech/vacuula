import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import TimeAgo from 'react-timeago'
import styles from './notificationList.module.scss'
import { useApp } from '../../context/useApp'
import { useRobot } from '../../context/useRobot'
import { useUnits } from '../../units'
import { useTimeAgoFormatter } from '../../i18n/timeago'
import { formatDuration } from '../../utils/duration'
import type { AppNotification } from '../../http'

const ICONS: Record<AppNotification['kind'], string> = {
    run_done: '✅', error: '❌', alert: '⚠️', offline: '🔌', online: '🔌', robot_push: '📣',
    schedule_overlap: '🗓️', schedule_skipped: '🗓️', schedule_clock: '🕐',
}

// Notification centre list (the bell's dropdown): everything the server noted about the robot,
// newest first. `onOpenRun` is called before a finished run opens on the runs page.
// a robot clock's offset from UTC in minutes, as "UTC+2" / "UTC+5:30"
const utcOffset = (min: number) =>
    `UTC${min < 0 ? '-' : '+'}${Math.floor(Math.abs(min) / 60)}${Math.abs(min) % 60 ? `:${String(Math.abs(min) % 60).padStart(2, '0')}` : ''}`

export default function NotificationList({ onOpenRun }: { onOpenRun?: () => void }) {
    const { t, i18n } = useTranslation()
    const { notifications } = useApp()
    const { robot } = useRobot()
    const { formatArea } = useUnits()
    const timeAgoFormatter = useTimeAgoFormatter()
    const navigate = useNavigate()

    // the robot's own error / alert texts, already translated for the home page
    const robotText = (code: string | null) => {
        const key = `robotErrorCode.${robot.type}.${code}`
        return code && i18n.exists(key) ? t(key as any) : code ?? ''
    }

    // the push message's code; older notifications only kept the raw body ({"message_code": ...})
    const pushCode = (n: AppNotification): string | null => {
        if (n.code) return n.code
        try { return JSON.parse(n.data.body)?.message_code ?? null } catch { return null }
    }

    const describe = (n: AppNotification): { title: string, detail?: string } => {
        const d = n.data
        switch (n.kind) {
            case 'run_done': return {
                title: t(d.status === 'canceled' ? 'notifications.runCanceled' : 'notifications.runDone'),
                detail: [
                    d.startAt && d.endAt && formatDuration(d.startAt, d.endAt),
                    typeof d.cleanedArea === 'number' && formatArea(d.cleanedArea),
                    d.chargeStart != null && t('home.lastRun.battery', { start: d.chargeStart, end: d.chargeEnd }),
                ].filter(Boolean).join(' · '),
            }
            case 'error': return { title: t('notifications.error'), detail: robotText(n.code) }
            case 'alert': return { title: t('notifications.alert'), detail: robotText(n.code) }
            case 'offline': return { title: t('notifications.offline', { minutes: d.minutes ?? 5 }) }
            case 'online': return { title: t('notifications.online') }
            case 'schedule_overlap': return {
                title: t('notifications.scheduleOverlap', { time: d.piTime }),
                detail: t('notifications.scheduleOverlapDetail', { times: (d.robotTimes ?? []).join(', ') }),
            }
            case 'schedule_skipped': return {
                title: t('notifications.scheduleSkipped', { time: d.piTime }),
                detail: i18n.exists(`notifications.skipReason.${n.code}`) ? t(`notifications.skipReason.${n.code}` as any) : n.code ?? '',
            }
            case 'schedule_clock': return {
                title: t('notifications.scheduleClock'),
                detail: n.code === 'local' ? t('notifications.scheduleClockLocal')
                    : n.code === 'utc' || !n.code ? t('notifications.scheduleClockUtc')
                    : t('notifications.scheduleClockOffset', { offset: utcOffset(Number(n.code)) }),
            }
            case 'robot_push': return { title: t('notifications.robotPush'), detail: pushCode(n) ? robotText(pushCode(n)) : d.body }
        }
    }

    return (
        <div className={styles.notifications}>
            <span className={styles.title}>{t('notifications.title')}</span>
            {notifications.length === 0 && <span className={styles.empty}>{t('notifications.empty')}</span>}
            {notifications.map(n => {
                const { title, detail } = describe(n)
                const opensRun = n.kind === 'run_done' && n.code
                return (
                    <div key={n.id} className={`${styles.item} ${opensRun ? styles.link : ''}`}
                        onClick={opensRun ? () => { onOpenRun?.(); navigate('/runs', { state: { runId: n.code } }) } : undefined}>
                        <span className={styles.icon}>{ICONS[n.kind]}</span>
                        <div className={styles.text}>
                            <span className={styles.itemTitle}>{title}</span>
                            {detail && <span className={styles.detail}>{detail}</span>}
                        </div>
                        <span className={styles.time}><TimeAgo date={n.createdAt * 1000} formatter={timeAgoFormatter} /></span>
                    </div>
                )
            })}
        </div>
    )
}
