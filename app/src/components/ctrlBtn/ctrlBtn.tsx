import styles from './ctrlBtn.module.scss'

interface CtrlBtnProps {
    icon: React.ReactNode
    label: string
    disabled?: boolean
    onClick?: () => void
}

export default function CtrlBtn({ icon, label, disabled, onClick }: CtrlBtnProps) {
    return (
        <button className={`${styles.ctrlBtn} ${disabled ? styles.disabled : ''}`} onClick={onClick} aria-label={label} disabled={disabled}>
            {icon}
            <span className={styles.ctrlLabel}>{label}</span>
        </button>
    )
}
