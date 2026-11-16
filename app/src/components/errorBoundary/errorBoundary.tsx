import { Component, type ErrorInfo, type ReactNode } from 'react'
import { BASE_PATH } from '../../http'
import styles from './errorBoundary.module.scss'

// A page that throws while rendering would leave the whole app black. This catches it: the error is
// shown with a button to reload, and sent to the server's log (POST /api/client-error), so it can be
// read there afterwards. `resetKey`: a new value (another page) tries again.
interface Props { children: ReactNode, resetKey?: unknown }
interface State { error: Error | null }

export default class ErrorBoundary extends Component<Props, State> {
    state: State = { error: null }

    static getDerivedStateFromError(error: Error): State {
        return { error }
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        const report = {
            message: String(error?.message ?? error),
            stack: (error?.stack ?? '').slice(0, 3000),
            component: (info.componentStack ?? '').slice(0, 2000),
            url: window.location.href,
            userAgent: navigator.userAgent,
        }
        console.error('Page crashed:', error, info.componentStack)
        fetch(`${BASE_PATH}/api/client-error`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report),
        }).catch(() => { })
    }

    componentDidUpdate(prev: Props) {
        if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null })
    }

    render() {
        if (!this.state.error) return this.props.children
        // plain texts: the translations may be what broke
        return (
            <div className={styles.box}>
                <h2>Die Seite ist abgestürzt / This page crashed</h2>
                <code>{this.state.error.message}</code>
                <p>Der Fehler steht auch im Log des Servers. / The error is in the server's log too.</p>
                <button onClick={() => window.location.reload()}>Neu laden / Reload</button>
            </div>
        )
    }
}
