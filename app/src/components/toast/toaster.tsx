import { useEffect, useState } from 'react'
import { onToast, type Toast } from './toast'
import styles from './toast.module.scss'

export default function Toaster() {
    const [toasts, setToasts] = useState<Toast[]>([])
    useEffect(() => {
        onToast(toast => {
            setToasts(list => [...list, toast])
            setTimeout(() => setToasts(list => list.filter(t => t.id !== toast.id)), toast.ok ? 2500 : 6000)
        })
        return () => onToast(null)
    }, [])
    return (
        <div className={styles.toasts} aria-live="polite">
            {toasts.map(t => <div key={t.id} className={`${styles.toast} ${t.ok ? '' : styles.fail}`}>{t.ok && '✓ '}{t.text}</div>)}
        </div>
    )
}
