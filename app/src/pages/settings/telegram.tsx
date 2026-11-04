// Telegram messages for this robot: its own bot (token), the chat to send to, which notifications.
// The server keeps the token and never returns it; the app only sees the bot's name.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Input from '../../components/input/input'
import Button from '../../components/button/button'
import { Http, type TelegramChat, type TelegramKind, type TelegramSettings } from '../../http'
import { useRobot } from '../../context/useRobot'
import { serverError } from '../../components/toast/toast'
import styles from './settings.module.scss'

export default function TelegramSettingsSection() {
    const { t } = useTranslation()
    const { robot } = useRobot()
    const [settings, setSettings] = useState<TelegramSettings>()
    const [token, setToken] = useState('')
    const [chats, setChats] = useState<TelegramChat[]>()
    const [busy, setBusy] = useState(false)
    const [message, setMessage] = useState<{ ok: boolean, text: string }>()

    // mounted with key={robot.serial}: another robot starts fresh
    useEffect(() => {
        Http.getTelegram(robot.serial).then(res => setSettings(res.data)).catch(() => setSettings(undefined))
    }, [robot.serial])

    const run = (action: () => Promise<unknown>, done?: string) => {
        setBusy(true)
        setMessage(undefined)
        action()
            .then(() => done && setMessage({ ok: true, text: done }))
            .catch(err => setMessage({ ok: false, text: serverError(err) }))
            .finally(() => setBusy(false))
    }
    const update = (body: Parameters<typeof Http.updateTelegram>[1], done?: string) =>
        run(() => Http.updateTelegram(robot.serial, body).then(res => setSettings(res.data)), done)

    if (!settings) return null

    const kindLabel = (kind: TelegramKind) => t(`telegram.kind.${kind}` as any)

    return (
        <div className={styles.featureList}>
            <b>{t('telegram.title')}</b>

            {!settings.tokenSet ? (
                <Input type="custom" label={t('telegram.token')} extraInfo={t('telegram.tokenHelp')}>
                    <div className={styles.telegramRow}>
                        <input className={styles.telegramInput} type="password" autoComplete="off" value={token}
                            placeholder="123456789:AA…" onChange={e => setToken(e.target.value)} />
                        <Button text={t('common.save')} style='success' disabled={busy || !token.trim()}
                            onClick={() => update({ token: token.trim() }, t('telegram.tokenSaved'))} />
                    </div>
                </Input>
            ) : (
                <Input type="custom" label={t('telegram.bot')} extraInfo={t('telegram.botHelp', { bot: settings.botName })}>
                    <div className={styles.telegramRow}>
                        <span className={styles.telegramValue}>{settings.botName}</span>
                        <Button text={t('telegram.removeBot')} style='secondary' disabled={busy}
                            onClick={() => { setToken(''); setChats(undefined); update({ token: '' }) }} />
                    </div>
                </Input>
            )}

            {settings.tokenSet && (
                <Input type="custom" label={t('telegram.chat')}
                    extraInfo={settings.chatId ? undefined : t('telegram.chatHelp', { bot: settings.botName })}>
                    <div className={styles.telegramRow}>
                        <span className={styles.telegramValue}>{settings.chatName ?? settings.chatId ?? t('telegram.noChat')}</span>
                        <Button text={t('telegram.findChat')} style='secondary' disabled={busy}
                            onClick={() => run(() => Http.findTelegramChats(robot.serial).then(res => {
                                setChats(res.data)
                                if (!res.data.length) setMessage({ ok: false, text: t('telegram.noChats', { bot: settings.botName }) })
                            }))} />
                    </div>
                    {chats && chats.length > 0 && (
                        <div className={styles.telegramChats}>
                            {chats.map(chat => (
                                <Button key={chat.id} text={`${chat.name}${chat.type !== 'private' ? ` (${chat.type})` : ''}`}
                                    style={chat.id === settings.chatId ? 'primary' : 'secondary'} disabled={busy}
                                    onClick={() => { setChats(undefined); update({ chatId: chat.id, chatName: chat.name }) }} />
                            ))}
                        </div>
                    )}
                </Input>
            )}

            {settings.tokenSet && settings.chatId && (
                <>
                    <Input type="multi-select" label={t('telegram.kinds')}
                        options={settings.groups.map(kind => ({ value: kind, label: kindLabel(kind) }))}
                        value={settings.kinds}
                        onChange={kinds => update({ kinds })} />
                    <Input type="switch" label={t('telegram.enabled')} value={settings.enabled}
                        onChange={enabled => update({ enabled })} />
                    <Button text={t('telegram.test')} style='secondary' disabled={busy}
                        onClick={() => run(() => Http.testTelegram(robot.serial), t('telegram.testSent'))} />
                </>
            )}

            {message && <span className={message.ok ? styles.telegramOk : styles.telegramError}>{message.text}</span>}
        </div>
    )
}
