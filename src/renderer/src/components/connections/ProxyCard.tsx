import type { ReactElement } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Network, RefreshCw } from 'lucide-react'
import type { ConnectionInfo, ProviderConnection, ProxyConnection } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { Badge } from '../ui/Badge'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { ConnectionStatusBadge } from '../ui/ConnectionStatusBadge'
import { IconButton } from '../ui/IconButton'
import { Icon } from '../ui/Icon'
import { SecretField } from '../ui/SecretField'
import { useConfirm } from '../ui/ConfirmDialog'
import { relativeTime } from '../../lib/remap'
import { cleanIpcError } from '../../lib/ipcError'
import { connectionKindLabel, defaultChangeAnnouncement, defaultMode } from '../../lib/connectionLabel'
import { KEY_REMOVED_RE, checkLines, reportsNote } from '../../lib/proxyChecks'
import { hostOf, validateProxyForm } from '../../lib/proxyForm'
import ModelList from './ModelList'
import TierEditor from './TierEditor'
import { CopyDetails } from './ConnectionCard'
import { ProxyFields } from './ProxyFields'
import { useConnectionsAnnounce } from './announce'

const statusWord = (state: ConnectionInfo['status']['state']): string =>
  state === 'connected' ? 'connected' : state === 'connecting' ? 'connecting' : state === 'error' ? 'connection error' : 'not connected'

/** "A, B, C (and N more)" for at most five names. */
export function usedByText(usedBy: { name: string }[]): string {
  const names = usedBy.slice(0, 5).map((u) => u.name)
  const more = usedBy.length - names.length
  return names.join(', ') + (more > 0 ? ` (and ${more} more)` : '')
}

export default function ProxyCard({
  info,
  open,
  onToggle,
  focusToken,
  onFocused,
  onRemoved,
  existingNames
}: {
  info: ConnectionInfo
  open: boolean
  onToggle: () => void
  /** Set to this card's id by the panel to move focus to the card's name once (after Add). */
  focusToken: string | null
  onFocused: () => void
  onRemoved: (name: string) => void
  /** Names of the other connections, for the duplicate check. */
  existingNames: string[]
}): ReactElement {
  const conn = info.connection as ProxyConnection
  const id = conn.id
  const name = conn.name
  const setInfo = useAppStore((s) => s.setConnectionInfo)
  const loadModels = useAppStore((s) => s.loadModels)
  const models = useAppStore((s) => s.models[id])
  const modelsError = useAppStore((s) => s.modelsError[id])
  const announce = useConnectionsAnnounce()
  const { confirm, dialog } = useConfirm()
  const card = useRef<HTMLElement>(null)
  const state = info.status.state
  const connected = state === 'connected'
  const usedBy = info.usedBy ?? []

  const [busy, setBusy] = useState<null | 'refresh' | 'connect' | 'save'>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showErrors, setShowErrors] = useState(false)
  const saved = { name: conn.name, anthropicBaseUrl: conn.anthropicBaseUrl, openaiBaseUrl: conn.openaiBaseUrl ?? '', modelsUrl: conn.modelsUrl ?? '' }
  const [values, setValues] = useState(saved)
  const savedKey = JSON.stringify(saved)
  useEffect(() => {
    setValues(JSON.parse(savedKey))
  }, [savedKey])
  const dirty = JSON.stringify(values) !== savedKey
  const errors = validateProxyForm({ ...values, kind: conn.kind }, existingNames)
  const hasErrors = Object.keys(errors).length > 0

  // Default row.
  const chosen = useAppStore((s) => s.defaultConnectionChosen)
  const storedDefault = useAppStore((s) => s.defaultConnectionStored)
  const defaultChanges = useAppStore((s) => s.defaultConnectionChanges)
  const loadDefault = useAppStore((s) => s.loadDefaultConnection)
  const mode = defaultMode(id, chosen, storedDefault)
  const [defaultError, setDefaultError] = useState<string | null>(null)
  const errorId = `conn-default-error-${id}`
  useEffect(() => {
    void loadDefault()
  }, [loadDefault])
  useEffect(() => {
    setDefaultError(null)
  }, [defaultChanges])
  const changeDefault = async (next: string | null): Promise<void> => {
    setDefaultError(null)
    try {
      await useAppStore.getState().setDefaultConnection(next)
      announce(defaultChangeAnnouncement(next, useAppStore.getState().defaultConnection))
    } catch (e) {
      const msg = cleanIpcError(e)
      setDefaultError(msg)
      announce(msg)
    }
  }

  const lastState = useRef(state)
  useEffect(() => {
    if (lastState.current === state) return
    lastState.current = state
    announce(`${name}: ${statusWord(state)}`)
  }, [state, announce, name])

  useEffect(() => {
    if (connected && !models) void loadModels(id)
  }, [connected, models, id, loadModels])

  useEffect(() => {
    if (focusToken !== id) return
    // The Add dialog is still closing: wait a frame so the focus is not swallowed by the inert page.
    // The token is spent at once and the timer is not cancelled by a re-render, so a remounted card can never
    // take focus later from whatever the user (or Save key) moved it to.
    onFocused()
    const el = card.current
    setTimeout(() => {
      if (!el?.isConnected) return
      const a = document.activeElement
      // Do not pull focus off something the user already moved to inside this card.
      if (a && a !== document.body && el.contains(a)) return
      el.querySelector<HTMLElement>('.conn-title h4')?.focus()
    }, 60)
  }, [focusToken, id, onFocused])

  // Save changes and Save key unmount their own button; focus goes to the action that logically follows (Test and connect).
  // Runs after every commit while a request is pending, so it waits for the button to remount and become enabled
  // instead of racing the re-render with timers.
  const wantTestFocus = useRef(0)
  const focusTestSoon = (): void => {
    wantTestFocus.current = Date.now() + 3000
    setFocusTick((n) => n + 1)
    // One late pass in case nothing else re-renders once the buttons settle.
    setTimeout(() => setFocusTick((n) => n + 1), 300)
  }
  const [focusTick, setFocusTick] = useState(0)
  useEffect(() => {
    if (!wantTestFocus.current) return
    if (Date.now() > wantTestFocus.current) {
      wantTestFocus.current = 0
      return
    }
    const active = document.activeElement
    // Only rescue focus that was dropped (page body) or sits on a control that just went away.
    if (active && active !== document.body && active.isConnected && !active.closest('[data-testid=secret-field]')) {
      wantTestFocus.current = 0
      return
    }
    const btn = card.current?.querySelector<HTMLButtonElement>('[data-testid=proxy-test]')
    if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
      btn.focus()
      if (document.activeElement === btn) wantTestFocus.current = 0
    }
  })
  void focusTick

  const save = async (): Promise<ConnectionInfo | null> => {
    setShowErrors(true)
    if (hasErrors) return null
    setBusy('save')
    setError(null)
    setNotice(null)
    try {
      const urlChanged = values.anthropicBaseUrl !== saved.anthropicBaseUrl || values.openaiBaseUrl !== saved.openaiBaseUrl || values.modelsUrl !== saved.modelsUrl
      const next: ProxyConnection = {
        ...conn,
        name: values.name.trim().replace(/\s+/g, ' '),
        anthropicBaseUrl: values.anthropicBaseUrl.trim(),
        openaiBaseUrl: values.openaiBaseUrl.trim() || undefined,
        modelsUrl: values.modelsUrl.trim() || undefined
      }
      const res = await window.orgai.connections.update(next as ProviderConnection)
      setInfo(res)
      if (urlChanged) setNotice('Changed. Test and connect to apply.')
      else setNotice('Saved.')
      announce(urlChanged ? `${next.name} changed. Test and connect to apply.` : `${next.name} saved`)
      return res
    } catch (e) {
      setError(cleanIpcError(e))
      return null
    } finally {
      setBusy(null)
    }
  }

  const testAndConnect = async (): Promise<void> => {
    if (dirty && !(await save())) return
    setBusy('connect')
    setError(null)
    try {
      const next = await window.orgai.connections.connect(id)
      setInfo(next)
      const lines = checkLines(next.status.checks, hostOf(next.connection && (next.connection as ProxyConnection).anthropicBaseUrl)).map((l) => l.text)
      announce([`${name}: ${statusWord(next.status.state)}`, next.status.state === 'connected' ? lines.join('. ') : next.status.detail].filter(Boolean).join('. '))
      if (next.status.state === 'connected') void loadModels(id, true)
      setNotice(null)
    } catch (e) {
      setError(cleanIpcError(e))
    } finally {
      setBusy(null)
    }
  }

  const refresh = async (): Promise<void> => {
    setBusy('refresh')
    setError(null)
    try {
      const status = await window.orgai.connections.test(id)
      setInfo({ ...info, status })
      if (status.state === 'connected') await loadModels(id, true)
    } catch (e) {
      setError(cleanIpcError(e))
    } finally {
      setBusy(null)
    }
  }

  const deleteKey = async (): Promise<void> => {
    const users = usedBy.length > 0 ? ` ${usedBy.length === 1 ? 'This project uses it' : 'These projects use it'}: ${usedByText(usedBy)}. They cannot run on ${name} until you add a key again.` : ''
    const ok = await confirm({
      title: `Delete the key for ${name}?`,
      body: <p>The stored key is deleted and {name} is disconnected. The addresses are kept.{users}</p>,
      confirmLabel: 'Delete key',
      danger: true,
      confirmTestId: 'proxy-delete-key-confirm'
    })
    if (!ok) return
    setError(null)
    try {
      setInfo(await window.orgai.connections.logout(id))
      setNotice('Key deleted. The addresses are kept.')
      announce(`${name}: key deleted`)
    } catch (e) {
      setError(cleanIpcError(e))
    }
  }

  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: `Remove ${name}?`,
      body: <p>The stored key is deleted. Past runs keep showing the name as &quot;Removed proxy&quot;.</p>,
      confirmLabel: 'Remove proxy',
      danger: true,
      confirmTestId: 'proxy-remove-confirm'
    })
    if (!ok) return
    setError(null)
    try {
      const res = await window.orgai.connections.removeProxy(id)
      useAppStore.setState({ connections: res.connections })
      void useAppStore.getState().loadConnections()
      onRemoved(name)
    } catch (e) {
      // A project started using it meanwhile: main's text names the projects.
      setError(cleanIpcError(e))
    }
  }

  const host = hostOf(conn.anthropicBaseUrl)
  const lines = checkLines(info.status.checks, host)
  const note = reportsNote(info.status.checks)
  const keyRemoved = KEY_REMOVED_RE.test(info.status.detail ?? '')
  const kind = connectionKindLabel(conn)
  const summary = useMemo(() => {
    const when = relativeTime(info.status.checkedAt)
    if (state === 'connected') return [kind, models ? `${models.length} models` : info.status.checks?.modelCount != null ? `${info.status.checks.modelCount} models` : '', when ? `updated ${when}` : ''].filter(Boolean).join(' · ')
    if (state === 'connecting') return info.status.detail ?? 'Testing the proxy'
    if (state === 'error') return info.status.detail ?? 'Something went wrong.'
    return `${kind} · ${info.status.detail ?? (conn.hasApiKey ? 'Not connected. Test and connect.' : 'Not connected. Add a key and test.')}`
  }, [state, info.status, kind, models, conn.hasApiKey])

  const removeReasonId = `proxy-remove-reason-${id}`
  const blocked = usedBy.length > 0

  return (
    <section ref={card} className="card-block conn-card proxy-card" data-testid="connection-card" data-provider={id} data-kind="proxy" data-name={name} aria-label={name}>
      <header className="card-sec conn-head">
        <span className="conn-mark">
          <Icon icon={Network} size="lg" />
        </span>
        <div className="conn-title">
          <h4 tabIndex={-1}>
            {name} <Badge tone="neutral">{kind}</Badge>
            {info.isDefault && (
              <>
                {' '}
                <Badge tone="accent" testId="default-connection-badge">
                  Default for new projects and assistants
                </Badge>
                {mode && (
                  <span className="conn-default-mode" data-testid="default-connection-mode">
                    {mode === 'chosen' ? 'Chosen' : 'Automatic'}
                  </span>
                )}
              </>
            )}
          </h4>
          <p className={state === 'error' ? 'conn-detail conn-summary invalid-text' : 'conn-detail conn-summary'} data-testid="connection-status" title={summary}>
            {summary}
          </p>
        </div>
        <ConnectionStatusBadge state={state} />
        {connected ? (
          <IconButton icon={RefreshCw} label={`Refresh ${name} status and models`} size="sm" spin={busy === 'refresh'} disabled={busy !== null} onClick={() => void refresh()} testId="connection-refresh" />
        ) : (
          <Button size="sm" variant="primary" loading={busy === 'connect'} disabled={busy !== null || !conn.anthropicBaseUrl} ariaLabel={`Test and connect ${name}`} onClick={() => void testAndConnect()} testId="proxy-test-header">
            Connect
          </Button>
        )}
        <IconButton icon={open ? ChevronDown : ChevronRight} label={open ? `Collapse ${name}` : `Expand ${name}`} size="sm" expanded={open} onClick={onToggle} testId="proxy-toggle" />
      </header>
      {open && (
        <>
          {state === 'error' && (
            <div className="card-sec">
              <Banner tone="danger" title="Connection error" actions={<CopyDetails text={info.status.detail ?? ''} />}>
                {info.status.detail}
              </Banner>
            </div>
          )}
          {keyRemoved && state !== 'error' && (
            <div className="card-sec">
              <Banner tone="warning" testId="proxy-key-removed">
                {info.status.detail}
              </Banner>
            </div>
          )}
          {error && (
            <div className="card-sec">
              <Banner tone="danger" onDismiss={() => setError(null)} testId="proxy-error">
                {error}
              </Banner>
            </div>
          )}
          {lines.length > 0 && (
            <div className="card-sec">
              <ul className="proxy-checks" data-testid="proxy-checks" aria-label="What the last test found">
                {lines.map((l) => (
                  <li key={l.check} className="proxy-check" data-testid="proxy-check" data-check={l.check} data-ok={String(l.ok)}>
                    {l.text}
                  </li>
                ))}
              </ul>
              {note && (
                <p className="muted proxy-reports-note" data-testid="proxy-reports-note">
                  {note}
                </p>
              )}
            </div>
          )}
          <div className="card-sec">
            <div className="conn-auth">
              <ProxyFields prefix={`pc-${id}`} values={values} errors={showErrors ? errors : {}} onChange={(p) => setValues((v) => ({ ...v, ...p }))} />
              <div className="field">
                <label id={`pc-${id}-key-label`}>API key</label>
                <SecretField
                  name={`API key for ${name}`}
                  state={conn.hasApiKey ? 'set' : 'notSet'}
                  hint="Stored encrypted on this machine. It is never shown again."
                  onSave={async (v) => {
                    setInfo(await window.orgai.connections.setSecret({ id, apiKey: v }))
                    setNotice('Key saved. Test and connect to apply.')
                    focusTestSoon()
                  }}
                  onClear={async () => {
                    setInfo(await window.orgai.connections.setSecret({ id, apiKey: null }))
                    setNotice('Key cleared.')
                  }}
                />
              </div>
              {notice && !error && (
                <p className="muted" data-testid="proxy-notice">
                  {notice}
                </p>
              )}
              {blocked && (
                <p className="field-msg warn" id={removeReasonId} data-testid="proxy-remove-reason">
                  {name} is used by: {usedByText(usedBy)}. Move those projects to another connection first (Project settings &gt; General &gt; Connection); OrgAI will not remove it while they use it.
                </p>
              )}
              <div className="conn-actions">
                {dirty && (
                  <Button loading={busy === 'save'} disabled={busy !== null} onClick={() => void save().then((r) => r && focusTestSoon())} testId="proxy-save">
                    Save changes
                  </Button>
                )}
                <Button variant="primary" loading={busy === 'connect'} disabled={busy !== null || !values.anthropicBaseUrl.trim()} onClick={() => void testAndConnect()} testId="proxy-test">
                  Test and connect
                </Button>
                {conn.hasApiKey && <Button onClick={() => void deleteKey()} testId="proxy-delete-key">Delete key</Button>}
                <Button variant="ghost" inert={blocked} ariaDescribedBy={blocked ? removeReasonId : undefined} onClick={() => void remove()} testId="proxy-remove">
                  Remove proxy
                </Button>
              </div>
              {(connected || info.isDefault) && (
                <div className="conn-default-row">
                  {info.isDefault ? (
                    mode === 'chosen' && (
                      <button type="button" className="btn sm" data-testid="connection-default-auto" aria-describedby={defaultError ? errorId : undefined} onClick={() => void changeDefault(null)}>
                        Back to automatic
                      </button>
                    )
                  ) : (
                    <button type="button" className="btn sm" data-testid="connection-make-default" aria-label={`Use for new projects: ${name}`} aria-describedby={defaultError ? errorId : undefined} onClick={() => void changeDefault(id)}>
                      Use for new projects
                    </button>
                  )}
                  {defaultError && (
                    <p className="conn-default-error invalid-text" id={errorId} data-testid="connection-default-error">
                      {defaultError}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
          {connected && (
            <>
              <div className="card-sec">
                {(info.modelsRefreshedAt || info.modelsError) && (
                  <p className={`field-msg${info.modelsError ? ' warn' : ''}`} data-testid="models-refreshed">
                    {info.modelsRefreshedAt ? `Models updated ${relativeTime(info.modelsRefreshedAt)}` : ''}
                    {info.modelsRefreshedAt && info.modelsError ? '. ' : ''}
                    {info.modelsError ? `Last refresh failed: ${info.modelsError}` : ''}
                  </p>
                )}
                <ModelList id={id} models={models} error={modelsError} onRetry={() => void loadModels(id, true)} tierModels={info.connection.tierModels} />
              </div>
              <div className="card-sec">
                <TierEditor info={info} models={models ?? []} onSave={async (c) => {
                  const next = await window.orgai.connections.update(c)
                  setInfo(next)
                  return next
                }} />
              </div>
            </>
          )}
        </>
      )}
      {dialog}
    </section>
  )
}
