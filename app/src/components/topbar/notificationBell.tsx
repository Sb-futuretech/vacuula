import { FaBell } from 'react-icons/fa'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import styles from './notificationBell.module.scss'
import { useApp } from '../../context/useApp'

// Bell next to the robot bar: unread count, opens the notification centre
export default function NotificationBell() {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { unreadNotifications } = useApp()
    return (
        <button className={styles.bell} onClick={() => navigate('/notifications')} aria-label={t('notifications.title')}>
            <FaBell size={18} />
            {unreadNotifications > 0 && (
                <span className={styles.badge}>{unreadNotifications > 99 ? '99+' : unreadNotifications}</span>
            )}
        </button>
    )
}
