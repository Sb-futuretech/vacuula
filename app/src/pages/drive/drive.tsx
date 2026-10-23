import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FaArrowDown, FaArrowLeft, FaArrowRight, FaArrowUp, FaStop } from 'react-icons/fa'
import styles from './drive.module.scss'
import { Http, type DriveCombo } from '../../http'
import { useRobot } from '../../context/useRobot'

type Direction = 'up' | 'down' | 'left' | 'right'

// the robot stops when a moving combo is not repeated; the server sends `stop` after 1 s
const REPEAT_MS = 300

const KEYS: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }

// ← / → alone pivot on the spot, together with ↑ they curve
function comboFor(pressed: Set<Direction>): DriveCombo | null {
    if (pressed.has('up')) return pressed.has('left') ? 'arc-left' : pressed.has('right') ? 'arc-right' : 'forward'
    if (pressed.has('down')) return 'back'
    if (pressed.has('left')) return 'pivot-left'
    if (pressed.has('right')) return 'pivot-right'
    return null
}

const withDirection = (set: Set<Direction>, dir: Direction, on: boolean) => {
    const next = new Set(set)
    if (on) next.add(dir)
    else next.delete(dir)
    return next
}

// Remote control for a gen3 robot: hold an arrow (button or key) to drive, let go to stop
export default function Drive() {
    const { t } = useTranslation()
    const { robot } = useRobot()
    const [status, setStatus] = useState<'connecting' | 'ready' | 'error'>('connecting')
    const [error, setError] = useState('')
    const [pressed, setPressed] = useState<Set<Direction>>(new Set())
    const [motors, setMotors] = useState({ vacuum: false, brush: false, turbo: false })
    const movingRef = useRef(false)

    const fail = (err: any) => {
        setStatus('error')
        setError(err?.response?.data?.error ?? String(err))
    }

    // connect when the page opens, leave manual mode when it closes
    useEffect(() => {
        setStatus('connecting')
        Http.driveStart(robot.serial).then(() => setStatus('ready')).catch(fail)
        return () => { Http.driveStop(robot.serial) }
    }, [robot.serial])

    // resend the combo while it is held, `stop` once everything is released
    const combo = comboFor(pressed)
    useEffect(() => {
        if (status !== 'ready') return
        if (!combo) {
            if (movingRef.current) Http.drive(robot.serial, { combo: 'stop' }).catch(fail)
            movingRef.current = false
            return
        }
        movingRef.current = true
        const send = () => Http.drive(robot.serial, { combo }).catch(fail)
        send()
        const timer = setInterval(send, REPEAT_MS)
        return () => clearInterval(timer)
    }, [combo, status])

    // arrow keys drive, space stops; losing focus releases everything
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === ' ') {
                e.preventDefault()
                if (e.type === 'keydown') setPressed(new Set())
                return
            }
            const dir = KEYS[e.key]
            if (!dir) return
            e.preventDefault()
            setPressed(prev => withDirection(prev, dir, e.type === 'keydown'))
        }
        const release = () => setPressed(new Set())
        window.addEventListener('keydown', onKey)
        window.addEventListener('keyup', onKey)
        window.addEventListener('blur', release)
        return () => {
            window.removeEventListener('keydown', onKey)
            window.removeEventListener('keyup', onKey)
            window.removeEventListener('blur', release)
        }
    }, [])

    // pointer capture keeps the release event even when the finger slides off the button
    const holdButton = (dir: Direction, icon: React.ReactNode) => (
        <button
            className={`${styles.arrow} ${styles[dir]} ${pressed.has(dir) ? styles.active : ''}`}
            disabled={status !== 'ready'}
            aria-label={dir}
            onPointerDown={e => {
                e.currentTarget.setPointerCapture(e.pointerId)
                setPressed(prev => withDirection(prev, dir, true))
            }}
            onPointerUp={() => setPressed(prev => withDirection(prev, dir, false))}
            onPointerCancel={() => setPressed(prev => withDirection(prev, dir, false))}
        >
            {icon}
        </button>
    )

    const toggle = (motor: 'vacuum' | 'brush' | 'turbo') => {
        const on = !motors[motor]
        // the power setting is eco or turbo, so turning turbo off means eco
        const command = motor === 'turbo' ? (on ? 'turbo-on' : 'eco-on') : `${motor}-${on ? 'on' : 'off'}` as const
        Http.drive(robot.serial, { command }).catch(fail)
        setMotors(m => ({ ...m, [motor]: on }))
    }

    return (
        <div className={styles.drive}>
            <div className={`${styles.status} ${styles[status]}`}>
                {status === 'connecting' && t('drive.connecting')}
                {status === 'ready' && t('drive.ready')}
                {status === 'error' && t('drive.error', { message: error })}
            </div>

            <div className={styles.pad}>
                {holdButton('up', <FaArrowUp size={28} />)}
                {holdButton('left', <FaArrowLeft size={28} />)}
                <button className={`${styles.arrow} ${styles.stop}`} disabled={status !== 'ready'} aria-label="stop" onClick={() => setPressed(new Set())}>
                    <FaStop size={24} />
                </button>
                {holdButton('right', <FaArrowRight size={28} />)}
                {holdButton('down', <FaArrowDown size={28} />)}
            </div>

            <div className={styles.motors}>
                {(['vacuum', 'brush', 'turbo'] as const).map(motor => (
                    <button key={motor} className={motors[motor] ? styles.on : ''} disabled={status !== 'ready'} onClick={() => toggle(motor)}>
                        {t(`drive.${motor}`)}
                    </button>
                ))}
            </div>

            <p className={styles.hint}>{t('drive.hint')}</p>
        </div>
    )
}
