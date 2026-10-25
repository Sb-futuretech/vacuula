import { useEffect, useRef, useState } from 'react'
import { FaBell } from 'react-icons/fa'
import { useTranslation } from 'react-i18next'
import styles from './notificationBell.module.scss'
import { useApp } from '../../context/useApp'
import NotificationList from './notificationList'

// Bell next to the robot bar: unread count, opens the notification list as a dropdown. Open means
// read; a click outside, Escape or opening a run closes it.
export default function NotificationBell() {
    const { t } = useTranslation()
    const { unreadNotifications, markNotificationsRead } = useApp()
    const [open, setOpen] = useState(false)
    const ref = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (open && unreadNotifications) markNotificationsRead()
    }, [open, unreadNotifications])

    useEffect(() => {
        if (!open) return
        const onClick = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onClick)
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('mousedown', onClick)
            document.removeEventListener('keydown', onKey)
        }
    }, [open])

    return (
        <div className={styles.wrapper} ref={ref}>
            <button className={styles.bell} onClick={() => setOpen(o => !o)} aria-label={t('notifications.title')} aria-expanded={open}>
                <FaBell size={18} />
                {unreadNotifications > 0 && (
                    <span className={styles.badge}>{unreadNotifications > 99 ? '99+' : unreadNotifications}</span>
                )}
            </button>
            {open && (
                <div className={styles.dropdown}>
                    <NotificationList onOpenRun={() => setOpen(false)} />
                </div>
            )}
        </div>
    )
}
