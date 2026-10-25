import { useEffect } from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import TimeAgo from 'react-timeago'
import styles from './notifications.module.scss'
import { useApp } from '../../context/useApp'
import { useRobot } from '../../context/useRobot'
import { useUnits } from '../../units'
import { useTimeAgoFormatter } from '../../i18n/timeago'
import { formatDuration } from '../../utils/duration'
import type { AppNotification } from '../../http'

const ICONS: Record<AppNotification['kind'], string> = {
    run_done: '✅', error: '❌', alert: '⚠️', offline: '🔌', online: '🔌', robot_push: '📣',
}

// Notification centre: everything the server noted about the robot, newest first
export default function Notifications() {
    const { t, i18n } = useTranslation()
    const { notifications, unreadNotifications, markNotificationsRead } = useApp()
    const { robot } = useRobot()
    const { formatArea } = useUnits()
    const timeAgoFormatter = useTimeAgoFormatter()
    const navigate = useNavigate()

    // opening the page reads everything; a notification arriving while it is open counts as read too
    useEffect(() => {
        if (unreadNotifications) markNotificationsRead()
    }, [unreadNotifications])

    // the robot's own error / alert texts, already translated for the home page
    const robotText = (code: string | null) => {
        const key = `robotErrorCode.${robot.type}.${code}`
        return code && i18n.exists(key) ? t(key as any) : code ?? ''
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
            case 'robot_push': return { title: t('notifications.robotPush'), detail: d.body }
        }
    }

    return (
        <div className={styles.notifications}>
            <h2 className={styles.title}>{t('notifications.title')}</h2>
            {notifications.length === 0 && <span className={styles.empty}>{t('notifications.empty')}</span>}
            {notifications.map(n => {
                const { title, detail } = describe(n)
                const opensRun = n.kind === 'run_done' && n.code
                return (
                    <div key={n.id} className={`${styles.item} ${opensRun ? styles.link : ''}`}
                        onClick={opensRun ? () => navigate('/runs', { state: { runId: n.code } }) : undefined}>
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
